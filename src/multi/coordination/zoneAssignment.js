import { beliefs, manhattanDistance, isWalkable } from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { setZoneConstraint } from '../../bdi/components/zone.js';
import { findSpawnerTiles, findNearestDeliveryTile } from '../../bdi/components/tilesearch.js';
import { aStar } from '../../bdi/pathfinding.js';
import { getZone, getZones, getSplitAxis, getMapBounds } from '../../shared/zones.js';
import { MSG_TYPE, onMessage, sendDirect } from '../communication.js';
import { getPeers, hasKnownPosition } from './peerState.js';

// Periodic assignment cadence.
const ZONE_ASSIGN_INTERVAL_MS = 15_000;
// Peer discovery debounce.
const PEER_DISCOVERY_ASSIGN_DELAY_MS = 500;
// Relay freeze after handoff activity.
const RELAY_FREEZE_TTL_MS = 12_000;

// Score threshold for high-value active work.
const BOTH_BUSY_SCORE_THRESHOLD = 10;
// Fast split before the periodic loop starts.
const USE_HEURISTIC_PREASSIGN = process.env.USE_HEURISTIC_PREASSIGN !== 'false';
// Minimum score gain needed to override an active intention.
const IMPROVEMENT_THRESHOLD = 5;
// Ignore assignments already close to the current target.
const SAME_ZONE_TARGET_DISTANCE = 3;

let _isCoordinator = false;

/** @type {Record<string, string> | null} */
let _lastAssignment = null;
let _hasEverAssigned = false;
let _lastHandoffActivityTs = 0;
let _zoneAssignPending = false;
// Last peer zone sent, used to suppress redundant refreshes.
let _lastSentPeerZone = null;

/** @type {() => (import('../../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../../shared/types.js').Intention) => void} */
let _forceIntention = () => {};

export function initZoneAssignment({ getCurrentIntention, forceIntention }) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
}

export function markHandoffActivity() {
    _lastHandoffActivityTs = Date.now();
}

export function setCoordinatorRole() {
    _isCoordinator = true;
}

/**
 * Computes parcel and spawner stats for each map half.
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
 * Finds a reachable navigation target inside a zone.
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
 * Splits the two agents across the map halves.
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

    // Same half: separate along the split axis.
    const axis = getSplitAxis(beliefs.grid);
    let selfCoord = selfPos.x;
    let peerCoord = peerPos.x;
    if (axis === 'y') {
        selfCoord = selfPos.y;
        peerCoord = peerPos.y;
    }

    let selfTakesLow = selfCoord < peerCoord;
    if (selfCoord === peerCoord) {
        selfTakesLow = selfId < peerId;
    }

    const [low, high] = zones;
    if (selfTakesLow) {
        return { [selfId]: low, [peerId]: high };
    }
    return { [selfId]: high, [peerId]: low };
}

/**
 * Applies a zone assignment locally and sends the peer update.
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

        // Avoid redundant periodic refreshes.
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
 * Runs an immediate heuristic split once the peer position is known.
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
 * Schedules one debounced zone assignment attempt.
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
 * Runs the periodic heuristic assignment cycle.
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

    // Freeze the split briefly after relay activity.
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

    // Stable splits only refresh constraints.
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
 * Starts the periodic zone assignment loop.
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
 * Registers the handler for incoming zone assignments.
 */
export function initZoneAssignHandler() {
    onMessage(MSG_TYPE.ZONE_ASSIGN, (envelope) => {
        const { targetId, center, score: payloadScore, totalReward } = envelope.payload ?? {};

        // Only act on assignments addressed to this agent, with a target tile.
        if (targetId !== beliefs.me.id) return;
        if (!center) return;

        // Score of the assigned zone, falling back to total reward then 0.
        const score = payloadScore ?? totalReward ?? 0;

        const current = _getCurrentIntention();
        const currentScore = current?.score ?? 0;
        const currentType = current?.type ?? null;

        // Never interrupt an in-progress handoff.
        if (currentType === 'go_handoff' || currentType === 'go_handoff_receive') {
            console.log(`[coord] Zone assign ignored: handoff in progress (${currentType})`);
            return;
        }

        // Idle/cheap intentions are safe to replace; real work is not.
        const isLowValueIntention =
            !current ||
            currentType === 'wait' ||
            currentType === 'explore' ||
            (currentType === 'go_to' && currentScore <= 0);

        const hasImportantIntention =
            current && current.status === 'active' && !isLowValueIntention;

        // Already heading somewhere close to the assigned tile: nothing to do.
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

        // If the zone centre is unreachable, fall back to a reachable zone tile.
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
                // Nothing in the zone is reachable: drop the assignment.
                console.log(
                    `[coord] Zone assign ignored: no reachable target in zone` +
                        ` (centre=(${center.x},${center.y}))`
                );
                return;
            }
        }

        // Keep important work unless the new zone is clearly better.
        if (hasImportantIntention && score - currentScore <= IMPROVEMENT_THRESHOLD) {
            console.log(
                `[coord] Zone assign ignored: ` +
                    `assignment=${score.toFixed(1)} ` +
                    `current=${currentScore.toFixed(1)} ` +
                    `threshold=${IMPROVEMENT_THRESHOLD}`
            );
            return;
        }

        // Restrict deliberation to the assigned zone.
        if (envelope.payload?.zone) setZoneConstraint(envelope.payload.zone);

        // Constraint-only refresh: update the zone but don't move.
        if (envelope.payload?.forceNavigation === false) {
            console.log(`[coord] Zone assign refreshed constraint only: ${envelope.payload.zone}`);
            return;
        }

        // Commit navigation to the assigned target.
        const intention = createIntention('go_to', null, target, score);
        console.log(`[coord] Zone assign accepted, go_to (${target.x},${target.y}) score=${score}`);

        _forceIntention(intention);
    });
}
