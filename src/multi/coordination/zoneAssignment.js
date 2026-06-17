import { beliefs, manhattanDistance, isWalkable } from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { setZoneConstraint } from '../../bdi/components/zone.js';
import { findSpawnerTiles, findNearestDeliveryTile } from '../../bdi/components/tilesearch.js';
import { aStar } from '../../bdi/pathfinding.js';
import { getZone, getZones, getSplitAxis, getMapBounds } from '../../shared/zones.js';
import { MSG_TYPE, onMessage, sendDirect } from '../communication.js';
import { getPeers, hasKnownPosition } from './peerState.js';

// How often the zone assignment loop re-runs
const ZONE_ASSIGN_INTERVAL_MS = 15_000;
// How long to wait after spotting a new peer before running the first assignment
const PEER_DISCOVERY_ASSIGN_DELAY_MS = 500;
// While a handoff happened within this window, freeze the zone assignment
const RELAY_FREEZE_TTL_MS = 12_000;

// Score above which an agent is considered busy with a high-value intention
const BOTH_BUSY_SCORE_THRESHOLD = 10;
// If enabled, runs a fast heuristic zone split on peer discovery
const USE_HEURISTIC_PREASSIGN = process.env.USE_HEURISTIC_PREASSIGN !== 'false';
// A new zone assignment must beat the current intention score by at least this
const IMPROVEMENT_THRESHOLD = 5;
// Ignore a zone assignment if the target is already this close to the current one
const SAME_ZONE_TARGET_DISTANCE = 3;

let _isCoordinator = false;

/** @type {Record<string, string> | null} */
let _lastAssignment = null;
let _hasEverAssigned = false;
let _lastHandoffActivityTs = 0;
let _zoneAssignPending = false;
// Last zone actually sent to the peer — used to suppress redundant refreshes
let _lastSentPeerZone = null;

/** @type {() => (import('../../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../../shared/types.js').Intention) => void} */
let _forceIntention = () => {};

// Must be called once before using this module
export function initZoneAssignment({ getCurrentIntention, forceIntention }) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
}

// Called by handoff.js when a handoff is accepted, to reset the relay freeze timer
export function markHandoffActivity() {
    _lastHandoffActivityTs = Date.now();
}

// Marks this agent as the LLM coordinator; only the coordinator runs zone assignments and LLM calls
export function setCoordinatorRole() {
    _isCoordinator = true;
}

/**
 * Scans all known parcels and spawner tiles to compute stats for each of the two
 * map halves: total reward, free parcel count, spawner count, and best pickup
 * score for self and peer.
 */
async function computeZoneStats() {
    const zones = {};
    for (const z of getZones(beliefs.grid)) {
        zones[z] = {
            totalReward: 0,
            freeParcels: 0,
            spawnerCount: 0,
            bestScoreForSelf: 0,
            bestScoreForPeer: 0,
        };
    }

    const { pickupValue } = await import('../../bdi/scoring.js');

    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    const selfKnown = hasKnownPosition(selfPos);
    const peers = getPeers();
    const peer = peers[0] ?? null;
    const peerPos = peer && hasKnownPosition(peer) ? { x: peer.x, y: peer.y } : selfPos;

    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy) continue;
        const zone = getZone({ x: p.x, y: p.y }, beliefs.grid);
        if (!zones[zone]) continue;
        zones[zone].freeParcels++;
        zones[zone].totalReward += p.reward;

        if (!selfKnown) continue;
        const deliveryTile = findNearestDeliveryTile({ x: p.x, y: p.y });
        if (!deliveryTile) continue;

        const scoreSelf = pickupValue(p, selfPos, deliveryTile);
        if (scoreSelf > zones[zone].bestScoreForSelf) zones[zone].bestScoreForSelf = scoreSelf;

        const scorePeer = pickupValue(p, peerPos, deliveryTile);
        if (scorePeer > zones[zone].bestScoreForPeer) zones[zone].bestScoreForPeer = scorePeer;
    }

    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        const zone = getZone({ x, y }, beliefs.grid);
        if (zones[zone]) zones[zone].spawnerCount++;
    }

    return zones;
}

// Returns the geometric center tile of a map half.
function getZoneCenter(zoneName) {
    const { minX, maxX, minY, maxY } = getMapBounds(beliefs.grid);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const cx = Math.round(midX);
    const cy = Math.round(midY);

    if (zoneName === 'left') {
        return { x: Math.round((minX + midX) / 2), y: cy };
    }
    if (zoneName === 'right') {
        return { x: Math.round((midX + maxX) / 2), y: cy };
    }
    if (zoneName === 'bottom') {
        return { x: cx, y: Math.round((minY + midY) / 2) };
    }
    if (zoneName === 'top') {
        return { x: cx, y: Math.round((midY + maxY) / 2) };
    }
    return { x: cx, y: cy };
}

/**
 * Finds the best reachable navigation target in a zone.
 * Tries spawner tiles first (nearest to fromPos), then walkable tiles near
 * the geometric center, then the center itself as last resort
 */
export function getNearestReachableZoneTarget(zoneName, fromPos) {
    const spawners = findSpawnerTiles().filter((s) => getZone(s, beliefs.grid) === zoneName);
    spawners.sort((a, b) => manhattanDistance(fromPos, a) - manhattanDistance(fromPos, b));
    for (const s of spawners) {
        if (aStar(fromPos, s, { avoidAgents: true })) return s;
    }

    const center = getZoneCenter(zoneName);
    const candidates = [];
    for (const [key, tile] of beliefs.grid) {
        if (tile.type === '0') continue;
        const [x, y] = key.split(',').map(Number);
        if (getZone({ x, y }, beliefs.grid) !== zoneName) continue;
        candidates.push({ x, y });
    }
    candidates.sort((a, b) => manhattanDistance(center, a) - manhattanDistance(center, b));
    for (const tile of candidates.slice(0, 30)) {
        if (aStar(fromPos, tile, { avoidAgents: true })) return tile;
    }

    return center;
}

// Returns the walkable tile closest to target by Manhattan distance
export function findNearestWalkableTile(target) {
    let best = null;
    let bestDist = Infinity;
    for (const [key] of beliefs.grid) {
        const [x, y] = key.split(',').map(Number);
        if (!isWalkable(x, y)) continue;
        const d = manhattanDistance(target, { x, y });
        if (d < bestDist) {
            bestDist = d;
            best = { x, y };
        }
    }
    return best;
}

/**
 * Splits the two agents across the two map halves.
 *
 * Returns null only before the map has loaded. If the agents are already in
 * different halves, each keeps its own. If they are in the same half, each is
 * given the half it is nearer to along the split axis so they separate without
 * crossing; ties are broken by id for determinism. An agent whose half has no
 * spawners parks at the half point (handled in deliberation.js).
 *
 * @returns {Record<string, string>|null}
 */
function computeHeuristicAssignment(selfId, selfPos, peerId, peerPos) {
    const zones = getZones(beliefs.grid);
    if (zones.length < 2) {
        return null;
    }

    const selfZone = getZone(selfPos, beliefs.grid);
    const peerZone = getZone(peerPos, beliefs.grid);

    if (selfZone !== peerZone) {
        return { [selfId]: selfZone, [peerId]: peerZone };
    }

    // Both agents are in the same half: give each the half it is nearer to along
    // the split axis so they separate without crossing.
    const axis = getSplitAxis(beliefs.grid);
    let selfCoord = selfPos.x;
    let peerCoord = peerPos.x;
    if (axis === 'y') {
        selfCoord = selfPos.y;
        peerCoord = peerPos.y;
    }

    let selfTakesLow = selfCoord < peerCoord;
    if (selfCoord === peerCoord) {
        selfTakesLow = selfId < peerId; // deterministic tiebreak
    }

    const [low, high] = zones;
    if (selfTakesLow) {
        return { [selfId]: low, [peerId]: high };
    }
    return { [selfId]: high, [peerId]: low };
}

/**
 * Applies the zone assignment to self and the peer.
 * Sets the zone constraint and forces a go_to navigation for self (unless busy),
 * then sends a ZONE_ASSIGN message to the peer.
 * Skips if a handoff is currently in progress
 */
function applyAssignment(assignment, zoneStats, selfId, selfPos, peerId, peerPos, options = {}) {
    const { forceNavigation = true } = options;

    const liveIntention = _getCurrentIntention();
    const isHandoffActive =
        liveIntention &&
        (liveIntention.status === 'active' || liveIntention.status === 'pending') &&
        (liveIntention.type === 'go_handoff' || liveIntention.type === 'go_handoff_receive');

    if (isHandoffActive) {
        console.log('[coord] Zone assignment deferred: handoff in progress');
        return;
    }

    const selfBusy =
        liveIntention?.status === 'active' &&
        (liveIntention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    const overrideFirstBusy = !_hasEverAssigned && beliefs.me.carrying.length === 0;

    const selfZoneName = assignment[selfId];
    if (!selfZoneName) return;
    _hasEverAssigned = true;

    const selfCenter = getNearestReachableZoneTarget(selfZoneName, selfPos);
    const selfEffectiveScore = Math.max(
        zoneStats[selfZoneName]?.bestScoreForSelf ?? 0,
        zoneStats[selfZoneName]?.totalReward ?? 0,
        (zoneStats[selfZoneName]?.spawnerCount ?? 0) * 2
    );

    console.log(
        `[coord] Zone assignment for self (${selfId}): ${selfZoneName} (${selfCenter.x},${selfCenter.y})`
    );

    setZoneConstraint(selfZoneName);
    if (forceNavigation && (!selfBusy || overrideFirstBusy)) {
        _forceIntention(createIntention('go_to', null, selfCenter, selfEffectiveScore));
    }

    if (assignment[peerId]) {
        const peerZoneName = assignment[peerId];

        // Skip redundant periodic refreshes when the peer zone hasn't changed
        if (!forceNavigation && peerZoneName === _lastSentPeerZone) return;

        const peerCenter = getNearestReachableZoneTarget(peerZoneName, peerPos);
        const peerEffectiveScore = Math.max(
            zoneStats[peerZoneName]?.bestScoreForPeer ?? 0,
            zoneStats[peerZoneName]?.totalReward ?? 0,
            (zoneStats[peerZoneName]?.spawnerCount ?? 0) * 2
        );
        console.log(`[coord] Zone assignment for peer (${peerId}): ${peerZoneName}`);
        _lastSentPeerZone = peerZoneName;
        sendDirect(peerId, MSG_TYPE.ZONE_ASSIGN, {
            targetId: peerId,
            zone: peerZoneName,
            center: peerCenter,
            score: peerEffectiveScore,
            totalReward: zoneStats[peerZoneName]?.totalReward ?? 0,
            forceNavigation,
        });
    }
}

/**
 * Runs an immediate heuristic zone split as soon as the peer position is known,
 * before the LLM responds, so agents start covering different areas right away
 */
export async function runHeuristicZoneAssignment() {
    if (!_isCoordinator) return;
    if (!USE_HEURISTIC_PREASSIGN) return;
    if (beliefs.me.x === null) return;

    const peers = getPeers();
    const peer = peers[0] ?? null;
    if (!peer || peer.x === null) return;

    const selfId = beliefs.me.id;
    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    const peerId = peer.id;
    const peerPos = { x: peer.x, y: peer.y };

    const assignment = computeHeuristicAssignment(selfId, selfPos, peerId, peerPos);
    if (!assignment) return;
    _lastAssignment = assignment;

    const HEURISTIC_SCORE = 10;
    const selfZoneName = assignment[selfId];
    const peerZoneName = assignment[peerId];

    console.log(
        `[coord] Heuristic zone split: ${selfId}=${selfZoneName} ${peerId}=${peerZoneName}`
    );

    const liveIntentionH = _getCurrentIntention();
    const selfBusyH =
        liveIntentionH?.status === 'active' &&
        (liveIntentionH.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    const overrideFirstBusyH = !_hasEverAssigned && beliefs.me.carrying.length === 0;

    const selfCenter = getNearestReachableZoneTarget(selfZoneName, selfPos);
    setZoneConstraint(selfZoneName);
    if (!selfBusyH || overrideFirstBusyH) {
        _forceIntention(createIntention('go_to', null, selfCenter, HEURISTIC_SCORE));
    }
    _hasEverAssigned = true;

    const peerCenter = getNearestReachableZoneTarget(peerZoneName, peerPos);
    sendDirect(peerId, MSG_TYPE.ZONE_ASSIGN, {
        targetId: peerId,
        zone: peerZoneName,
        center: peerCenter,
        score: HEURISTIC_SCORE,
        totalReward: 0,
        forceNavigation: true,
    });
}

/**
 * Schedules a single zone assignment attempt after delayMs.
 * Debounced: multiple rapid calls collapse into one
 */
export function scheduleZoneAssignment(delayMs = PEER_DISCOVERY_ASSIGN_DELAY_MS) {
    if (!_isCoordinator) return;
    if (_zoneAssignPending) return;
    _zoneAssignPending = true;
    setTimeout(async () => {
        _zoneAssignPending = false;
        await runZoneAssignment();
    }, delayMs);
}

/**
 * Main zone assignment cycle (heuristic, no LLM).
 *
 * Splits the two agents across the two map halves (see computeHeuristicAssignment)
 * and applies it. Navigation is only forced when the split actually changes, so a
 * stable split is just a cheap constraint refresh that never yanks an agent off
 * its work. Skips when both agents are busy, no peer is known, or a relay is in
 * progress.
 */
async function runZoneAssignment() {
    if (beliefs.me.x === null) return;

    const peers = getPeers();
    const peer = peers[0] ?? null;
    if (!peer) {
        console.log('[coord] Zone assignment skipped: no peer known yet');
        return;
    }

    const intention = _getCurrentIntention();
    const selfBusy =
        intention?.status === 'active' && (intention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;
    const peerBusy =
        peer.intention?.status === 'active' &&
        (peer.intention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    if (selfBusy && peerBusy) {
        console.log('[coord] Both agents busy with high-score intentions, skipping assignment');
        return;
    }

    const selfId = beliefs.me.id;
    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    if (!selfId || !hasKnownPosition(selfPos)) {
        console.log('[coord] Zone assignment skipped: own position unknown');
        return;
    }
    const peerId = peer.id;
    const peerPos = hasKnownPosition(peer) ? { x: peer.x, y: peer.y } : selfPos;

    const zoneStats = await computeZoneStats();

    // While a handoff just happened, freeze the split so the relay isn't disrupted:
    // re-apply the last assignment without forcing any navigation.
    const now = Date.now();
    const relayActive =
        _lastHandoffActivityTs > 0 && now - _lastHandoffActivityTs < RELAY_FREEZE_TTL_MS;
    if (relayActive && _lastAssignment) {
        console.log('[coord] Zone re-split suppressed: relay active (assignment frozen)');
        applyAssignment(_lastAssignment, zoneStats, selfId, selfPos, peerId, peerPos, {
            forceNavigation: false,
        });
        return;
    }

    const assignment = computeHeuristicAssignment(selfId, selfPos, peerId, peerPos);
    if (!assignment) return;

    // Only force a go_to when the split changed; otherwise just refresh the
    // constraint so neither agent is pulled away from its current intention.
    const changed =
        !_lastAssignment ||
        _lastAssignment[selfId] !== assignment[selfId] ||
        _lastAssignment[peerId] !== assignment[peerId];
    _lastAssignment = assignment;

    applyAssignment(assignment, zoneStats, selfId, selfPos, peerId, peerPos, {
        forceNavigation: changed,
    });
}

/**
 * Starts the periodic zone re-assignment loop.
 * The first assignment is triggered by peer discovery via scheduleZoneAssignment;
 * this loop handles periodic re-assignments to adapt to game-state changes
 */
export function startZoneAssignmentLoop() {
    if (!_isCoordinator) return;
    async function tick() {
        await runZoneAssignment();
        setTimeout(tick, ZONE_ASSIGN_INTERVAL_MS);
    }
    setTimeout(tick, ZONE_ASSIGN_INTERVAL_MS);
    console.log('[coord] Zone assignment loop started');
}

/**
 * Registers the handler for incoming ZONE_ASSIGN messages.
 * Converts a zone assignment into a go_to intention toward the zone center.
 * Ignores the assignment if the current intention is already high-value enough
 */
export function initZoneAssignHandler() {
    onMessage(MSG_TYPE.ZONE_ASSIGN, (envelope) => {
        const { targetId, center, score: payloadScore, totalReward } = envelope.payload ?? {};

        if (targetId !== beliefs.me.id) return;
        if (!center) return;

        const score = payloadScore ?? totalReward ?? 0;

        const current = _getCurrentIntention();
        const currentScore = current?.score ?? 0;
        const currentType = current?.type ?? null;

        if (currentType === 'go_handoff' || currentType === 'go_handoff_receive') {
            console.log(`[coord] Zone assign ignored: handoff in progress (${currentType})`);
            return;
        }

        const isLowValueIntention =
            !current ||
            currentType === 'wait' ||
            currentType === 'explore' ||
            (currentType === 'go_to' && currentScore <= 0);

        const hasImportantIntention =
            current && current.status === 'active' && !isLowValueIntention;

        if (
            current?.targetPos &&
            manhattanDistance(current.targetPos, center) <= SAME_ZONE_TARGET_DISTANCE
        ) {
            console.log(
                `[coord] Zone assign ignored: target already close ` +
                    `current=(${current.targetPos.x},${current.targetPos.y}) ` +
                    `assigned=(${center.x},${center.y})`
            );
            return;
        }

        const myPos =
            beliefs.me.x !== null && beliefs.me.y !== null
                ? { x: beliefs.me.x, y: beliefs.me.y }
                : null;

        let target = center;
        if (myPos && !aStar(myPos, target, { avoidAgents: false })) {
            const zoneName = envelope.payload?.zone ?? null;
            const alternative = zoneName ? getNearestReachableZoneTarget(zoneName, myPos) : null;
            if (alternative && aStar(myPos, alternative, { avoidAgents: false })) {
                console.log(
                    `[coord] Zone centre unreachable (${center.x},${center.y}),` +
                        ` using nearest reachable (${alternative.x},${alternative.y})`
                );
                target = alternative;
            } else {
                console.log(
                    `[coord] Zone assign ignored: no reachable target in zone` +
                        ` (centre=(${center.x},${center.y}))`
                );
                return;
            }
        }

        if (hasImportantIntention && score - currentScore <= IMPROVEMENT_THRESHOLD) {
            console.log(
                `[coord] Zone assign ignored: ` +
                    `assignment=${score.toFixed(1)} ` +
                    `current=${currentScore.toFixed(1)} ` +
                    `threshold=${IMPROVEMENT_THRESHOLD}`
            );
            return;
        }

        if (envelope.payload?.zone) setZoneConstraint(envelope.payload.zone);

        if (envelope.payload?.forceNavigation === false) {
            console.log(`[coord] Zone assign refreshed constraint only: ${envelope.payload.zone}`);
            return;
        }

        const intention = createIntention('go_to', null, target, score);
        console.log(`[coord] Zone assign accepted, go_to (${target.x},${target.y}) score=${score}`);

        _forceIntention(intention);
    });
}
