import { beliefs, manhattanDistance, isWalkable } from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { setZoneConstraint } from '../../bdi/components/zone.js';
import { findSpawnerTiles, findNearestDeliveryTile } from '../../bdi/components/tilesearch.js';
import { aStar } from '../../bdi/pathfinding.js';
import { getZone, getMapBounds } from '../../shared/zones.js';
import { MSG_TYPE, onMessage, sendDirect } from '../communication.js';
import { getPeers, hasKnownPosition } from './peerState.js';

// How often the zone assignment loop re-runs
const ZONE_ASSIGN_INTERVAL_MS = 15_000;
// How long to wait after spotting a new peer before running the first assignment
const PEER_DISCOVERY_ASSIGN_DELAY_MS = 500;
// Skip a periodic refresh if the assignment was updated less than this ago
const ASSIGNMENT_REFRESH_GRACE_MS = 3000;
// Minimum time between two LLM calls; routine ticks reuse the last assignment
const LLM_MIN_INTERVAL_MS = 90_000;
// Minimum time between two LLM rebalance calls
const REBALANCE_MIN_INTERVAL_MS = 60_000;
// While a handoff happened within this window, freeze the zone assignment
const RELAY_FREEZE_TTL_MS = 12_000;

// Score rate ratio below which one agent is considered slower than the other
const SCORE_IMBALANCE_THRESHOLD = 0.7;
// How many consecutive imbalanced intervals before triggering a rebalance
const IMBALANCE_CONSECUTIVE_INTERVALS = 3;
// Absolute score ratio below which a persistent gap rebalance is triggered
const SCORE_GAP_RATIO_THRESHOLD = 0.6;
// Both agents must have scored at least this much before gap checks are reliable
const SCORE_GAP_MIN_SCORE = 50;
// Below this ratio the lagging agent is force-assigned the better zone
const SCORE_GAP_FORCE_RATIO = 0.45;

// Score above which an agent is considered busy with a high-value intention
const BOTH_BUSY_SCORE_THRESHOLD = 10;
// If enabled, runs a fast heuristic zone split on peer discovery before the LLM responds
const USE_HEURISTIC_PREASSIGN = process.env.USE_HEURISTIC_PREASSIGN !== 'false';
// A new zone assignment must beat the current intention score by at least this
const IMPROVEMENT_THRESHOLD = 5;
// Ignore a zone assignment if the target is already this close to the current one
const SAME_ZONE_TARGET_DISTANCE = 3;

/** @type {{ selfScore: number, peerScore: number, ts: number } | null} */
let _scoreSnapshot = null;
let _imbalanceCount = 0;
/** @type {'self_slower'|'peer_slower'|null} */
let _imbalanceDirection = null;
let _imbalanceDirectionChanges = 0;
let _gapImbalanceCount = 0;

let _isCoordinator = false;

/** @type {Record<string, string> | null} */
let _lastAssignment = null;
let _lastAssignmentAppliedTs = 0;
let _hasEverAssigned = false;
let _lastLlmCallTs = 0;
let _lastRebalanceTs = 0;
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
 * Scans all known parcels and spawner tiles to compute stats for each zone:
 * total reward, free parcel count, spawner count, and best pickup score for
 * self and peer
 */
async function computeZoneStats() {
    const zones = {
        topLeft: {
            totalReward: 0,
            freeParcels: 0,
            spawnerCount: 0,
            bestScoreForSelf: 0,
            bestScoreForPeer: 0,
        },
        topRight: {
            totalReward: 0,
            freeParcels: 0,
            spawnerCount: 0,
            bestScoreForSelf: 0,
            bestScoreForPeer: 0,
        },
        bottomLeft: {
            totalReward: 0,
            freeParcels: 0,
            spawnerCount: 0,
            bestScoreForSelf: 0,
            bestScoreForPeer: 0,
        },
        bottomRight: {
            totalReward: 0,
            freeParcels: 0,
            spawnerCount: 0,
            bestScoreForSelf: 0,
            bestScoreForPeer: 0,
        },
    };

    const { pickupValue } = await import('../../bdi/scoring.js');

    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    const selfKnown = hasKnownPosition(selfPos);
    const peers = getPeers();
    const peer = peers[0] ?? null;
    const peerPos = peer && hasKnownPosition(peer) ? { x: peer.x, y: peer.y } : selfPos;

    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy) continue;
        const zone = getZone({ x: p.x, y: p.y }, beliefs.grid);
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
        zones[zone].spawnerCount++;
    }

    return zones;
}

// Returns the geometric center tile of a zone quadrant
function getZoneCenter(zoneName) {
    const { maxX, maxY } = getMapBounds(beliefs.grid);
    const midX = maxX / 2;
    const midY = maxY / 2;

    const centers = {
        topLeft: { x: Math.round(midX / 2), y: Math.round(midY + midY / 2) },
        topRight: { x: Math.round(midX + midX / 2), y: Math.round(midY + midY / 2) },
        bottomLeft: { x: Math.round(midX / 2), y: Math.round(midY / 2) },
        bottomRight: { x: Math.round(midX + midX / 2), y: Math.round(midY / 2) },
    };

    return centers[zoneName];
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
 * Computes a fast zone split without an LLM call.
 * Each agent is assigned to the zone they are already in.
 * If both are in the same zone, splits them diagonally using ID order as tiebreak
 */
function computeHeuristicAssignment(selfId, selfPos, peerId, peerPos) {
    if (beliefs.grid.size === 0) return null;

    const selfZone = getZone(selfPos, beliefs.grid);
    const peerZone = getZone(peerPos, beliefs.grid);

    if (selfZone !== peerZone) {
        const selfHalf = selfZone.endsWith('Left') ? 'left' : 'right';
        const peerHalf = peerZone.endsWith('Left') ? 'left' : 'right';
        if (selfHalf === peerHalf) {
            const peerVertical = peerZone.startsWith('top') ? 'top' : 'bottom';
            const peerOpposite = `${peerVertical}${peerHalf === 'left' ? 'Right' : 'Left'}`;
            return { [selfId]: selfZone, [peerId]: peerOpposite };
        }
        return { [selfId]: selfZone, [peerId]: peerZone };
    }

    const [first, second] = [selfId, peerId].sort();
    return { [first]: 'topLeft', [second]: 'bottomRight' };
}

// Returns a combined opportunity score for an agent in a zone (best pickup score + total reward + spawner density)
function zoneOpportunityForAgent(stats, agentKey) {
    const bestScore = agentKey === 'self' ? stats.bestScoreForSelf : stats.bestScoreForPeer;
    return Math.max(0, bestScore) + stats.totalReward + stats.spawnerCount * 5;
}

// Returns true if the zone has any opportunity for the given agent
function zoneHasOpportunity(stats, agentKey) {
    return zoneOpportunityForAgent(stats, agentKey) > 0;
}

// Returns 'left' or 'right' based on the zone name
function zoneSide(zoneName) {
    return zoneName?.endsWith('Left') ? 'left' : 'right';
}

// Returns the opposite side ('left' <-> 'right')
function oppositeSide(zoneName) {
    return zoneSide(zoneName) === 'left' ? 'right' : 'left';
}

// Returns the zone on the given side with the highest opportunity for an agent, skipping excludedZones
function bestZoneOnSide(zoneStats, side, agentKey, excludedZones = new Set()) {
    let bestZone = null;
    let bestValue = -Infinity;
    for (const zone of Object.keys(zoneStats)) {
        if (zoneSide(zone) !== side || excludedZones.has(zone)) continue;
        const value = zoneOpportunityForAgent(zoneStats[zone], agentKey);
        if (value > bestValue) {
            bestValue = value;
            bestZone = zone;
        }
    }
    return bestZone;
}

/**
 * Fixes a zone assignment that has problems:
 * - replaces zones with no useful opportunity
 * - prevents both agents from being assigned to the same map side
 * - gives the lagging agent the best available zone on the opposite side
 */
function repairAssignment(assignment, zoneStats, selfId, peerId, options = {}) {
    const { laggingAgentId = null } = options;
    const zones = Object.keys(zoneStats);
    const repaired = { ...assignment };

    for (const [agentId, agentKey] of [
        [selfId, 'self'],
        [peerId, 'peer'],
    ]) {
        const currentZone = repaired[agentId];
        const currentStats = currentZone ? zoneStats[currentZone] : null;
        if (currentStats && zoneHasOpportunity(currentStats, agentKey)) continue;

        const usedByOther = new Set(
            Object.entries(repaired)
                .filter(([id]) => id !== agentId)
                .map(([, zone]) => zone)
        );

        let bestZone = null;
        let bestValue = -Infinity;
        for (const zone of zones) {
            if (usedByOther.has(zone) && zones.length > usedByOther.size) continue;
            const value = zoneOpportunityForAgent(zoneStats[zone], agentKey);
            if (value > bestValue) {
                bestValue = value;
                bestZone = zone;
            }
        }

        if (bestZone && bestZone !== currentZone) {
            console.log(
                `[coord] Zone assignment repaired for ${agentId}: ` +
                    `${currentZone ?? 'none'} to ${bestZone} (no useful opportunity)`
            );
            repaired[agentId] = bestZone;
        }
    }

    if (
        repaired[selfId] &&
        repaired[peerId] &&
        zoneSide(repaired[selfId]) === zoneSide(repaired[peerId])
    ) {
        const moveId = laggingAgentId ?? peerId;
        const moveKey = moveId === selfId ? 'self' : 'peer';
        const stayId = moveId === selfId ? peerId : selfId;
        const targetSide = oppositeSide(repaired[stayId]);
        const bestZone = bestZoneOnSide(
            zoneStats,
            targetSide,
            moveKey,
            new Set([repaired[stayId]])
        );

        if (bestZone && bestZone !== repaired[moveId]) {
            console.log(
                `[coord] Zone assignment side-repaired for ${moveId}: ` +
                    `${repaired[moveId]} to ${bestZone} (same side coverage)`
            );
            repaired[moveId] = bestZone;
        }
    }

    if (laggingAgentId && repaired[laggingAgentId]) {
        const laggingKey = laggingAgentId === selfId ? 'self' : 'peer';
        const otherId = laggingAgentId === selfId ? peerId : selfId;
        const usedByOther = new Set([repaired[otherId]].filter(Boolean));
        let bestZone = repaired[laggingAgentId];
        let bestValue = zoneOpportunityForAgent(zoneStats[bestZone], laggingKey);

        for (const zone of zones) {
            if (usedByOther.has(zone)) continue;
            if (repaired[otherId] && zoneSide(zone) === zoneSide(repaired[otherId])) continue;
            const value = zoneOpportunityForAgent(zoneStats[zone], laggingKey);
            if (value > bestValue) {
                bestValue = value;
                bestZone = zone;
            }
        }

        if (bestZone !== repaired[laggingAgentId]) {
            console.log(
                `[coord] Zone assignment force-repaired for lagging ${laggingAgentId}: ` +
                    `${repaired[laggingAgentId]} to ${bestZone}`
            );
            repaired[laggingAgentId] = bestZone;
        }
    }

    return repaired;
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
    _lastAssignmentAppliedTs = Date.now();
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
    const zoneStats = await computeZoneStats();
    const repaired = repairAssignment(assignment, zoneStats, selfId, peerId);
    _lastAssignment = repaired;

    const HEURISTIC_SCORE = 10;
    const selfZoneName = repaired[selfId];
    const peerZoneName = repaired[peerId];

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
    _lastAssignmentAppliedTs = Date.now();
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
 * If the assignment would send each agent to the other's current zone (crossing paths),
 * swaps them so each agent stays on their own side
 */
function uncrossAssignment(assignment, selfId, selfPos, peerId, peerPos) {
    const selfCurrentZone = getZone(selfPos, beliefs.grid);
    const peerCurrentZone = getZone(peerPos, beliefs.grid);
    if (
        selfCurrentZone !== peerCurrentZone &&
        assignment[selfId] === peerCurrentZone &&
        assignment[peerId] === selfCurrentZone
    ) {
        const swapped = {
            ...assignment,
            [selfId]: assignment[peerId],
            [peerId]: assignment[selfId],
        };
        console.log(
            `[coord] Zone assignment un-crossed: ` +
                `${selfId}=${swapped[selfId]} ${peerId}=${swapped[peerId]}`
        );
        return swapped;
    }

    // Path-crossing check by sign: if relative positions and relative targets point in
    // opposite directions (on any axis), agents will have to cross each other.
    // This catches the case where both agents are in the same zone but assigned to opposite sides.
    const selfZone = assignment[selfId];
    const peerZone = assignment[peerId];
    if (selfZone && peerZone && selfZone !== peerZone) {
        const selfCenter = getZoneCenter(selfZone);
        const peerCenter = getZoneCenter(peerZone);
        if (selfCenter && peerCenter) {
            const xCross = (selfPos.x - peerPos.x) * (selfCenter.x - peerCenter.x) < 0;
            const yCross = (selfPos.y - peerPos.y) * (selfCenter.y - peerCenter.y) < 0;
            if (xCross || yCross) {
                const swapped = {
                    ...assignment,
                    [selfId]: peerZone,
                    [peerId]: selfZone,
                };
                console.log(
                    `[coord] Zone assignment un-crossed (path-cross): ` +
                        `${selfId}=${swapped[selfId]} ${peerId}=${swapped[peerId]}`
                );
                return swapped;
            }
        }
    }

    return assignment;
}

/**
 * Main zone assignment cycle.
 * Checks for score imbalance between agents, decides whether to call the LLM
 * or reuse the last assignment, then applies it.
 * Skips if both agents are busy or if no peer is known yet
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

    const now = Date.now();
    const selfScore = beliefs.me.score ?? 0;
    const peerScore = peer.score ?? 0;
    let selfRate = null,
        peerRate = null;
    let isImbalanced = false;
    let laggingAgentId = null;

    if (_scoreSnapshot) {
        const elapsed = (now - _scoreSnapshot.ts) / 1000;
        if (elapsed > 0) {
            selfRate = Math.max(0, (selfScore - _scoreSnapshot.selfScore) / elapsed);
            peerRate = Math.max(0, (peerScore - _scoreSnapshot.peerScore) / elapsed);
            const maxRate = Math.max(selfRate, peerRate);
            if (maxRate > 0 && Math.min(selfRate, peerRate) / maxRate < SCORE_IMBALANCE_THRESHOLD) {
                const direction = selfRate < peerRate ? 'self_slower' : 'peer_slower';
                const trailingDirection = selfScore <= peerScore ? 'self_slower' : 'peer_slower';
                if (direction !== trailingDirection) {
                    _imbalanceCount = 0;
                    _imbalanceDirectionChanges = 0;
                    _imbalanceDirection = null;
                    console.log(
                        `[coord] Score imbalance ignored: leader is slower ` +
                            `self=${selfRate.toFixed(2)}/s peer=${peerRate.toFixed(2)}/s ` +
                            `scores self=${selfScore} peer=${peerScore}`
                    );
                } else {
                    if (_imbalanceDirection && _imbalanceDirection !== direction)
                        _imbalanceDirectionChanges++;
                    _imbalanceDirection = direction;
                    _imbalanceCount++;
                    console.log(
                        `[coord] Score imbalance (${_imbalanceCount}/${IMBALANCE_CONSECUTIVE_INTERVALS}):` +
                            ` self=${selfRate.toFixed(2)}/s peer=${peerRate.toFixed(2)}/s` +
                            ` direction=${direction}` +
                            (_imbalanceDirectionChanges
                                ? ` changes=${_imbalanceDirectionChanges}`
                                : '')
                    );
                    if (_imbalanceCount >= IMBALANCE_CONSECUTIVE_INTERVALS) {
                        isImbalanced = true;
                        _imbalanceCount = 0;
                        _imbalanceDirectionChanges = 0;
                        _imbalanceDirection = null;
                        console.log('[coord] Imbalance confirmed, requesting LLM rebalance');
                    }
                }
            } else {
                _imbalanceCount = 0;
                _imbalanceDirectionChanges = 0;
                _imbalanceDirection = null;
            }
        }
    }
    _scoreSnapshot = { selfScore, peerScore, ts: now };

    const maxScore = Math.max(selfScore, peerScore);
    if (!isImbalanced && maxScore >= SCORE_GAP_MIN_SCORE) {
        const ratio = Math.min(selfScore, peerScore) / maxScore;
        if (ratio < SCORE_GAP_RATIO_THRESHOLD) {
            _gapImbalanceCount++;
            console.log(
                `[coord] Score gap (${_gapImbalanceCount}/${IMBALANCE_CONSECUTIVE_INTERVALS}):` +
                    ` self=${selfScore} peer=${peerScore} ratio=${ratio.toFixed(2)}`
            );
            if (_gapImbalanceCount >= IMBALANCE_CONSECUTIVE_INTERVALS) {
                isImbalanced = true;
                _gapImbalanceCount = 0;
                console.log('[coord] Persistent score gap, requesting LLM rebalance');
            }
        } else {
            _gapImbalanceCount = 0;
        }
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

    const scoreGapRatio =
        Math.min(selfScore, peerScore) / Math.max(1, Math.max(selfScore, peerScore));
    if (
        Math.max(selfScore, peerScore) >= SCORE_GAP_MIN_SCORE &&
        scoreGapRatio < SCORE_GAP_FORCE_RATIO
    ) {
        laggingAgentId = selfScore <= peerScore ? selfId : peerId;
    }

    const timeSinceLastLlm = now - _lastLlmCallTs;
    const rebalanceCooldownReady = now - _lastRebalanceTs >= REBALANCE_MIN_INTERVAL_MS;
    if (isImbalanced && !rebalanceCooldownReady) {
        console.log('[coord] Rebalance skipped: recent LLM rebalance still cooling down');
        isImbalanced = false;
    }

    const relayActive =
        _lastHandoffActivityTs > 0 && now - _lastHandoffActivityTs < RELAY_FREEZE_TTL_MS;
    if (
        relayActive &&
        _lastAssignment &&
        (isImbalanced || timeSinceLastLlm >= LLM_MIN_INTERVAL_MS)
    ) {
        console.log('[coord] Zone re-split suppressed: relay active (assignment frozen)');
        isImbalanced = false;
    }

    const needsLlm =
        !_lastAssignment ||
        (!relayActive && (isImbalanced || timeSinceLastLlm >= LLM_MIN_INTERVAL_MS));

    if (!needsLlm) {
        if (now - _lastAssignmentAppliedTs < ASSIGNMENT_REFRESH_GRACE_MS) {
            console.log('[coord] Periodic zone refresh skipped: assignment changed recently');
            return;
        }
        console.log('[coord] Periodic zone refresh (re-applying last assignment, no LLM call)');
        _lastAssignment = uncrossAssignment(_lastAssignment, selfId, selfPos, peerId, peerPos);
        applyAssignment(_lastAssignment, zoneStats, selfId, selfPos, peerId, peerPos, {
            forceNavigation: false,
        });
        return;
    }

    const { callZoneAssignment } = await import('../../llm/llmAgent.js');
    _lastLlmCallTs = now;
    const assignment = await callZoneAssignment(zoneStats, selfId, selfPos, peerId, peerPos, {
        selfRate,
        peerRate,
        isImbalanced,
        currentAssignment: _lastAssignment,
    });
    if (!assignment) return;
    if (isImbalanced) _lastRebalanceTs = now;
    _lastAssignment = repairAssignment(assignment, zoneStats, selfId, peerId, { laggingAgentId });
    _lastAssignment = uncrossAssignment(_lastAssignment, selfId, selfPos, peerId, peerPos);

    applyAssignment(_lastAssignment, zoneStats, selfId, selfPos, peerId, peerPos);
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
