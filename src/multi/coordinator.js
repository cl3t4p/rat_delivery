/**
 * coordinator.js
 *
 * Policy layer built on top of communication.js. Maintains a registry
 * of peer state derived from incoming messages and exposes helpers that
 * the BDI deliberation/revision loop can consult to answer
 * "who picks which parcel?".
 *
 * Tracked state per peer:
 *   - last-known position and carrying count          (from belief_update)
 *   - last-known intention                            (from intention_update)
 * Plus a parcel reservation table keyed by `parcelId`.
 */

import { beliefs, manhattanDistance, canEnter, isWalkable, suppressClaimedParcel, clearParcelSuppressions } from '../bdi/beliefs.js';
import { MSG_TYPE, onMessage, replyTo, sendDirect, sendBroadcast } from './communication.js';
import { findNearestDeliveryTile, createIntention, setZoneConstraint, findSpawnerTiles } from '../bdi/deliberation.js';
import { deliveryValue, estimatedRewardAtDelivery } from '../bdi/scoring.js';
import { aStar } from '../bdi/pathfinding.js';
import { getZone, getMapBounds } from '../shared/zones.js';

/** @typedef {import('../shared/types.js').Envelope} Envelope */
/** @typedef {import('../shared/types.js').Position} Position */

const PEER_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 1500;
const HANDOFF_GAIN_THRESHOLD = 2;
const HANDOFF_MAX_REWARD_LOSS = 2;
const YIELDED_PARCEL_TTL_MS = Number(process.env.YIELDED_PARCEL_TTL_MS) || 2000;

const DIR_DELTA_COORD = {
    up:    { dx: 0,  dy: 1  },
    down:  { dx: 0,  dy: -1 },
    left:  { dx: -1, dy: 0  },
    right: { dx: 1,  dy: 0  },
};

function hasKnownPosition(pos) {
    return Number.isFinite(pos?.x) && Number.isFinite(pos?.y);
}

const PERP_DIRS = {
    left:  ['up', 'down'],
    right: ['up', 'down'],
    up:    ['left', 'right'],
    down:  ['left', 'right'],
};

/** @type {string|null} */
let _pendingYield = null;

/**
 * @typedef {Object} PeerRecord
 * @property {string} id
 * @property {string} [name]
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} carrying
 * @property {number} score
 * @property {number} lastSeen
 * @property {{ type: string, parcelId: string|null, targetPos: Position|null, status: string, ts: number } | null} intention
 */

const state = {
    /** @type {Map<string, PeerRecord>} */
    peers: new Map(),
    /** @type {Map<string, { peerId: string, ts: number, status: string }>} */
    reservations: new Map(),
    /** @type {Map<string, { peerId: string|null, expiresAt: number }>} */
    yieldedParcels: new Map(),
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    pendingRequests: new Map(),
};

/**
 * Computes aggregated stats for each of the four map zones.
 * Includes bestScoreForSelf (coordinator) and bestScoreForPeer using
 * pickupValue from scoring.js.
 *
 * @returns {Record<string, { totalReward: number, freeParcels: number, spawnerCount: number, bestScoreForSelf: number, bestScoreForPeer: number }>}
 */
async function computeZoneStats() {
    const zones = {
        topLeft:     { totalReward: 0, freeParcels: 0, spawnerCount: 0, bestScoreForSelf: 0, bestScoreForPeer: 0 },
        topRight:    { totalReward: 0, freeParcels: 0, spawnerCount: 0, bestScoreForSelf: 0, bestScoreForPeer: 0 },
        bottomLeft:  { totalReward: 0, freeParcels: 0, spawnerCount: 0, bestScoreForSelf: 0, bestScoreForPeer: 0 },
        bottomRight: { totalReward: 0, freeParcels: 0, spawnerCount: 0, bestScoreForSelf: 0, bestScoreForPeer: 0 },
    };

    // Import scoring functions dynamically to avoid circular dependencies.
    const { pickupValue } = await import('../bdi/scoring.js');
    const { findNearestDeliveryTile } = await import('../bdi/deliberation.js');

    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    const selfKnown = hasKnownPosition(selfPos);
    const peers = getPeers();
    const peer = peers[0] ?? null;
    const peerPos = peer && hasKnownPosition(peer) ? { x: peer.x, y: peer.y } : selfPos;
    const peerKnown = hasKnownPosition(peerPos);

    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy) continue;
        const zone = getZone({ x: p.x, y: p.y }, beliefs.grid);
        zones[zone].freeParcels++;
        zones[zone].totalReward += p.reward;

        const deliveryTile = findNearestDeliveryTile({ x: p.x, y: p.y });
        if (deliveryTile && selfKnown) {
            const scoreSelf = pickupValue(p, selfPos, deliveryTile);
            if (scoreSelf > zones[zone].bestScoreForSelf) zones[zone].bestScoreForSelf = scoreSelf;
        }
        if (deliveryTile && peerKnown) {
            const scorePeer = pickupValue(p, peerPos, deliveryTile);
            if (scorePeer > zones[zone].bestScoreForPeer) zones[zone].bestScoreForPeer = scorePeer;
        }
    }

    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        const zone = getZone({ x, y }, beliefs.grid);
        zones[zone].spawnerCount++;
    }

    return zones;
}

/**
 * Returns the center tile of a named zone.
 *
 * @param {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'} zoneName
 * @returns {{ x: number, y: number }}
 */
function getZoneCenter(zoneName) {
    const { maxX, maxY } = getMapBounds(beliefs.grid);
    const midX = maxX / 2;
    const midY = maxY / 2;

    const centers = {
        topLeft:     { x: Math.round(midX / 2),         y: Math.round(midY + midY / 2) },
        topRight:    { x: Math.round(midX + midX / 2),  y: Math.round(midY + midY / 2) },
        bottomLeft:  { x: Math.round(midX / 2),         y: Math.round(midY / 2)        },
        bottomRight: { x: Math.round(midX + midX / 2),  y: Math.round(midY / 2)        },
    };

    return centers[zoneName];
}

/**
 * Finds the best reachable navigation target within a zone.
 *
 * Priority:
 *   1. In-zone spawner tiles (walkable by definition), nearest to fromPos.
 *   2. Walkable tiles nearest to the geometric zone centre, reachable via A*.
 *   3. Geometric centre as last resort (executor will report no-path if still
 *      unreachable, but at least we tried everything).
 *
 * This prevents zone assignments from forcing `go_to` to a non-walkable cell
 * (e.g. the computed geometric centre of a diamond-shaped map quadrant may fall
 * on an obstacle tile).
 *
 * @param {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'} zoneName
 * @param {{ x: number, y: number }} fromPos
 * @returns {{ x: number, y: number }}
 */
export function getNearestReachableZoneTarget(zoneName, fromPos) {
    // 1. Spawner tiles in the zone (few in number, cheap to check).
    const spawners = findSpawnerTiles().filter((s) => getZone(s, beliefs.grid) === zoneName);
    spawners.sort((a, b) => manhattanDistance(fromPos, a) - manhattanDistance(fromPos, b));
    for (const s of spawners) {
        if (aStar(fromPos, s, { avoidAgents: false })) return s;
    }

    // 2. Nearest walkable tiles to geometric centre, checked in order.
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
        if (aStar(fromPos, tile, { avoidAgents: false })) return tile;
    }

    // 3. Geometric centre (last resort).
    return center;
}

/**
 * Returns the walkable tile nearest (by Manhattan distance) to `target`.
 * Returns null if the grid is empty.
 *
 * @param {{ x: number, y: number }} target
 * @returns {{ x: number, y: number } | null}
 */
function findNearestWalkableTile(target) {
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
 * Evaluates whether handing off carried parcels to a peer is worthwhile.
 *
 * Uses the nearest delivery tile as the simplified meetTile.
 * Returns the meetTile if handoff is beneficial, null otherwise.
 *
 * Conditions (both must hold):
 *   1. dist(A→meet) + dist(B→meet) + dist(meet→delivery) < dist(A→delivery)
 *   2. dist(B→meet) + dist(meet→delivery) < dist(B→currentDelivery or nearestDelivery)
 *
 * @returns {{ meetTile: {x,y}, peerId: string } | null}
 */
export function evaluateHandoff() {
    if (beliefs.me.carrying.length < 1) return null;

    const peers = getPeers();
    const peer = peers[0] ?? null;
    if (!peer || peer.x === null || peer.y === null) return null;

    const posA = { x: beliefs.me.x, y: beliefs.me.y };
    const posB = { x: peer.x, y: peer.y };

    // meetTile = midpoint between A and B, snapped to nearest walkable tile
    const rawMeet = {
        x: Math.round((posA.x + posB.x) / 2),
        y: Math.round((posA.y + posB.y) / 2),
    };
    const meetTile = isWalkable(rawMeet.x, rawMeet.y) ? rawMeet : findNearestWalkableTile(rawMeet);
    if (!meetTile) return null;

    const delivery = findNearestDeliveryTile(meetTile);
    if (!delivery) return null;

    const distADel    = manhattanDistance(posA, delivery);
    const distAMeet   = manhattanDistance(posA, meetTile);
    const distBMeet   = manhattanDistance(posB, meetTile);
    const distMeetDel = manhattanDistance(meetTile, delivery);

    // Condition 1: A should save enough travel before direct delivery. The
    // handoff may not deliver the parcel earlier, but it can free A to keep
    // collecting while B completes delivery.
    const parallelTime = Math.max(distAMeet, distBMeet);
    const savedASteps = distADel - distAMeet;
    const condition1 = savedASteps > HANDOFF_GAIN_THRESHOLD;

    // Condition 2: B's detour to meetTile costs less than its current active path.
    // If B is idle/roaming, treat it as available for the handoff.
    const peerTarget =
        peer.intention?.status === 'active' &&
        (peer.intention.type === 'go_pick_up' || peer.intention.type === 'go_deliver') &&
        peer.intention.targetPos
            ? peer.intention.targetPos
            : null;
    const distBCurrent = peerTarget
        ? manhattanDistance(posB, peerTarget)
        : Infinity;
    const condition2 = distBMeet + distMeetDel < distBCurrent;

    // Condition 3: handoff should free A significantly before direct delivery,
    // without losing more than a tiny amount of parcel value. Handoff usually
    // cannot improve parcel reward by itself (A→meet→delivery is not shorter
    // than A→delivery), but it can improve team throughput by letting A resume
    // pickup work while B finishes delivery.
    const valueAAlone = deliveryValue(beliefs.me.carrying, posA, delivery);
    const handoffSteps = distAMeet + distMeetDel;
    const valueHandoff = beliefs.me.carrying.reduce((total, id) => {
        const parcel = beliefs.parcels.get(id);
        if (!parcel) return total;
        return total + estimatedRewardAtDelivery(parcel.reward, handoffSteps);
    }, 0);
    const conditionValue =
        savedASteps > HANDOFF_GAIN_THRESHOLD &&
        valueHandoff + HANDOFF_MAX_REWARD_LOSS >= valueAAlone;

    if (!condition1 || !condition2 || !conditionValue) {
        if (condition1 && condition2) {
            // Route is shorter but reward does not improve — log and skip.
            console.log(
                `[coord] Handoff rejected: Aalone=${valueAAlone.toFixed(1)} ` +
                `handoff=${valueHandoff.toFixed(1)} savedA=${savedASteps}`
            );
        }
        return null;
    }

    console.log(
        `[coord] Handoff viable: Aalone=${valueAAlone.toFixed(1)} ` +
        `handoff=${valueHandoff.toFixed(1)} savedA=${savedASteps} ` +
        `route=max(${distAMeet},${distBMeet})+${distMeetDel} ` +
        `parcelDecay=${distAMeet}+${distMeetDel}`
    );
    return { meetTile, peerId: peer.id };
}

export function resetCoordinatorForTests() {
    for (const pending of state.pendingRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer);
    }
    state.peers.clear();
    state.reservations.clear();
    state.yieldedParcels.clear();
    state.pendingRequests.clear();
    _pendingYield = null;
}

/**
 * Returns and clears the pending yield direction, if any.
 * Called by the executor at the top of each loop tick.
 *
 * @returns {string|null}
 */
export function consumeYieldRequest() {
    const dir = _pendingYield;
    _pendingYield = null;
    return dir;
}

// Initialization

/** @type {() => (import('../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../shared/types.js').Intention) => void} */
let _forceIntention = () => {};
/** @type {(force?: boolean) => void} */
let _requestRevision = () => {};

/**
 * Initialises the coordinator.
 *
 * @param {{ getCurrentIntention: Function, forceIntention: Function, requestRevision?: Function }} callbacks
 */
export function initCoordinator({ getCurrentIntention, forceIntention, requestRevision }) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
    if (requestRevision) _requestRevision = requestRevision;
    onMessage(MSG_TYPE.BELIEF_UPDATE, handleBeliefUpdate);
    onMessage(MSG_TYPE.INTENTION_UPDATE, handleIntentionUpdate);
    onMessage(MSG_TYPE.REQUEST, handleRequest);
    onMessage(MSG_TYPE.RESPONSE, handleResponse);
    onMessage(MSG_TYPE.HANDOFF_REQUEST, handleHandoffRequest);
    onMessage(MSG_TYPE.BLOCKED_AT, handleBlockedAt);
    onMessage(MSG_TYPE.PARCEL_CLAIMED, handleParcelClaimed);
    console.log('[coord] init ok');
}
// Zone assignment

const ZONE_ASSIGN_INTERVAL_MS        = 15_000;
const BOTH_BUSY_SCORE_THRESHOLD      = 10;
const PEER_DISCOVERY_ASSIGN_DELAY_MS = 500;
const ASSIGNMENT_REFRESH_GRACE_MS     = 3000;
const USE_HEURISTIC_PREASSIGN         = process.env.USE_HEURISTIC_PREASSIGN === 'true';

const SCORE_IMBALANCE_THRESHOLD       = 0.7;
// Require 3 consecutive imbalanced intervals before acting: reduces false
// positives caused by one agent temporarily being in transit between zones.
const IMBALANCE_CONSECUTIVE_INTERVALS = 3;

// Minimum ms between LLM calls; routine ticks re-apply the last assignment
// deterministically instead of paying LLM latency every 15 s.
// 90 s gives the agents enough time to actually work in a zone before the LLM
// is asked again, preventing oscillation caused by short-lived rate snapshots.
const LLM_MIN_INTERVAL_MS       = 90_000;
const REBALANCE_MIN_INTERVAL_MS = 60_000;
// Trigger a rebalance when the trailing agent has less than this fraction
// of the leading agent's score (and both have scored enough to be reliable).
// Raised from 0.55 to 0.60 so minor asymmetries don't trigger unnecessary swaps.
const SCORE_GAP_RATIO_THRESHOLD = 0.60;
const SCORE_GAP_MIN_SCORE       = 50;
const SCORE_GAP_FORCE_RATIO     = 0.45;

/** @type {{ selfScore: number, peerScore: number, ts: number } | null} */
let _scoreSnapshot = null;
let _imbalanceCount = 0;
/** @type {'self_slower'|'peer_slower'|null} */
let _imbalanceDirection = null;
let _imbalanceDirectionChanges = 0;
let _gapImbalanceCount = 0;

/** True only on Agent B — the agent that owns the LLM coordination loop. */
let _isCoordinator = false;

/** @type {Record<string, string> | null} Last zone assignment sent by the LLM. */
let _lastAssignment = null;
let _lastAssignmentAppliedTs = 0;

/** Timestamp of the last actual LLM call (ms). */
let _lastLlmCallTs = 0;
let _lastRebalanceTs = 0;

/**
 * Marks this agent as the LLM coordinator.
 * Must be called once from multiagent_b.js after initCoordinator().
 */
export function setCoordinatorRole() {
    _isCoordinator = true;
}

/**
 * Cheap, deterministic zone split used immediately on peer discovery
 * (before the LLM responds) so agents start covering complementary areas
 * right away rather than roaming randomly for several seconds.
 *
 * When both agents happen to be in the same quadrant the tiebreak is the
 * lexicographic order of their IDs, assigning them to diagonal opposites
 * (topLeft / bottomRight) for maximum initial spread.
 *
 * @param {string} selfId
 * @param {{ x: number, y: number }} selfPos
 * @param {string} peerId
 * @param {{ x: number, y: number }} peerPos
 * @returns {Record<string, string> | null}
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

    // Both in the same zone: split diagonally via ID tiebreak.
    const [first, second] = [selfId, peerId].sort();
    return { [first]: 'topLeft', [second]: 'bottomRight' };
}

function zoneOpportunityForAgent(stats, agentKey) {
    const bestScore = agentKey === 'self'
        ? stats.bestScoreForSelf
        : stats.bestScoreForPeer;
    return Math.max(0, bestScore) + stats.totalReward + stats.spawnerCount * 5;
}

function zoneHasOpportunity(stats, agentKey) {
    return zoneOpportunityForAgent(stats, agentKey) > 0;
}

function zoneSide(zoneName) {
    return zoneName?.endsWith('Left') ? 'left' : 'right';
}

function oppositeSide(zoneName) {
    return zoneSide(zoneName) === 'left' ? 'right' : 'left';
}

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

function repairAssignment(assignment, zoneStats, selfId, peerId, options = {}) {
    const { laggingAgentId = null } = options;
    const zones = Object.keys(zoneStats);
    const repaired = { ...assignment };

    for (const [agentId, agentKey] of [[selfId, 'self'], [peerId, 'peer']]) {
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
                `${currentZone ?? 'none'} → ${bestZone} (no useful opportunity)`
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
        const bestZone = bestZoneOnSide(zoneStats, targetSide, moveKey, new Set([repaired[stayId]]));

        if (bestZone && bestZone !== repaired[moveId]) {
            console.log(
                `[coord] Zone assignment side-repaired for ${moveId}: ` +
                `${repaired[moveId]} → ${bestZone} (same side coverage)`
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
                `${repaired[laggingAgentId]} → ${bestZone}`
            );
            repaired[laggingAgentId] = bestZone;
        }
    }

    return repaired;
}

/**
 * Applies a zone assignment (from LLM or heuristic) to self and the peer:
 * sets the zone constraint, optionally forces a go_to waypoint, and broadcasts
 * ZONE_ASSIGN messages so intentionRevision on both agents updates.
 *
 * selfBusy is re-evaluated live here rather than taken as a parameter: the
 * caller may have captured it before an async LLM call, so it can be stale
 * by the time the assignment is ready to apply (e.g. the agent finished a
 * pickup and started a high-value delivery during the LLM round-trip).
 *
 * @param {Record<string, string>} assignment
 * @param {Record<string, { totalReward: number, freeParcels: number, spawnerCount: number, bestScoreForSelf: number, bestScoreForPeer: number }>} zoneStats
 * @param {string} selfId
 * @param {{ x: number, y: number }} selfPos
 * @param {string} peerId
 * @param {{ x: number, y: number }} peerPos
 * @param {{ forceNavigation?: boolean }} [options]
 */
function applyAssignment(assignment, zoneStats, selfId, selfPos, peerId, peerPos, options = {}) {
    const { forceNavigation = true } = options;

    // Re-evaluate live so a stale pre-LLM snapshot cannot interrupt an active delivery.
    const liveIntention = _getCurrentIntention();
    const selfBusy = liveIntention?.status === 'active' &&
        (liveIntention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    const selfZoneName = assignment[selfId];
    if (!selfZoneName) return;
    _lastAssignmentAppliedTs = Date.now();

    const selfCenter = getNearestReachableZoneTarget(selfZoneName, selfPos);
    const selfEffectiveScore = Math.max(
        zoneStats[selfZoneName]?.bestScoreForSelf ?? 0,
        zoneStats[selfZoneName]?.totalReward      ?? 0,
        (zoneStats[selfZoneName]?.spawnerCount    ?? 0) * 2
    );

    console.log(`[coord] Zone assignment → self (${selfId}): ${selfZoneName} (${selfCenter.x},${selfCenter.y})`);

    setZoneConstraint(selfZoneName);
    if (forceNavigation && !selfBusy) {
        _forceIntention(createIntention('go_to', null, selfCenter, selfEffectiveScore));
    }

    if (assignment[peerId]) {
        const peerZoneName = assignment[peerId];
        const peerCenter   = getNearestReachableZoneTarget(peerZoneName, peerPos);
        const peerEffectiveScore = Math.max(
            zoneStats[peerZoneName]?.bestScoreForPeer ?? 0,
            zoneStats[peerZoneName]?.totalReward      ?? 0,
            (zoneStats[peerZoneName]?.spawnerCount    ?? 0) * 2
        );
        console.log(`[coord] Zone assignment → peer (${peerId}): ${peerZoneName}`);
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
 * Runs an immediate heuristic zone split as soon as the peer's position
 * becomes known — no LLM call, no network round-trip.  The LLM override
 * arrives shortly after via the normal scheduleZoneAssignment path.
 *
 * @returns {Promise<void>}
 */
async function runHeuristicZoneAssignment() {
    if (!_isCoordinator) return;
    if (!USE_HEURISTIC_PREASSIGN) return;
    if (beliefs.me.x === null) return;

    const peers = getPeers();
    const peer  = peers[0] ?? null;
    if (!peer || peer.x === null) return;

    const selfId  = beliefs.me.id;
    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    const peerId  = peer.id;
    const peerPos = { x: peer.x, y: peer.y };

    const assignment = computeHeuristicAssignment(selfId, selfPos, peerId, peerPos);
    if (!assignment) return;
    const zoneStats = await computeZoneStats();
    const repaired = repairAssignment(assignment, zoneStats, selfId, peerId);
    _lastAssignment = repaired;

    const HEURISTIC_SCORE = 10;
    const selfZoneName = repaired[selfId];
    const peerZoneName = repaired[peerId];

    console.log(`[coord] Heuristic zone split: ${selfId}→${selfZoneName} ${peerId}→${peerZoneName}`);

    // For the heuristic split, also apply live-selfBusy so we never interrupt
    // an active delivery just to reposition toward a zone center.
    const liveIntentionH = _getCurrentIntention();
    const selfBusyH = liveIntentionH?.status === 'active' &&
        (liveIntentionH.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    const selfCenter = getNearestReachableZoneTarget(selfZoneName, selfPos);
    setZoneConstraint(selfZoneName);
    if (!selfBusyH) {
        _forceIntention(createIntention('go_to', null, selfCenter, HEURISTIC_SCORE));
    }

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

// Debounce flag: prevents stacking multiple rapid assignment calls
// (e.g. if several messages from the same new peer arrive in quick succession).
let _zoneAssignPending = false;

/**
 * Schedules a single zone assignment attempt after `delayMs`, debounced.
 * Multiple calls within the debounce window collapse into one.
 *
 * @param {number} [delayMs]
 */
function scheduleZoneAssignment(delayMs = PEER_DISCOVERY_ASSIGN_DELAY_MS) {
    if (!_isCoordinator) return;
    if (_zoneAssignPending) return;
    _zoneAssignPending = true;
    setTimeout(async () => {
        _zoneAssignPending = false;
        await runZoneAssignment();
    }, delayMs);
}

/**
 * Executes one zone assignment cycle: computes zone stats, calls the LLM,
 * and dispatches the resulting assignments to self and the peer.
 *
 * Skips gracefully when:
 *   - this agent's position is not yet known
 *   - no peer has been discovered yet
 *   - both agents are executing high-value intentions (no point interrupting)
 *
 * @returns {Promise<void>}
 */
async function runZoneAssignment() {
    if (beliefs.me.x === null) return;

    const peers = getPeers();
    const peer  = peers[0] ?? null;
    if (!peer) {
        console.log('[coord] Zone assignment skipped: no peer known yet');
        return;
    }

    const intention = _getCurrentIntention();
    const selfBusy  = intention?.status === 'active' &&
        (intention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;
    const peerBusy  = peer.intention?.status === 'active' &&
        (peer.intention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    if (selfBusy && peerBusy) {
        console.log('[coord] Both agents busy with high-score intentions → skipping assignment');
        return;
    }

    // Scoring-rate tracking and imbalance detection
    const now       = Date.now();
    const selfScore = beliefs.me.score ?? 0;
    const peerScore = peer.score ?? 0;
    let selfRate = null, peerRate = null;
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
                    if (_imbalanceDirection && _imbalanceDirection !== direction) _imbalanceDirectionChanges++;
                    _imbalanceDirection = direction;
                    _imbalanceCount++;
                    console.log(
                        `[coord] Score imbalance (${_imbalanceCount}/${IMBALANCE_CONSECUTIVE_INTERVALS}):` +
                        ` self=${selfRate.toFixed(2)}/s peer=${peerRate.toFixed(2)}/s` +
                        ` direction=${direction}` +
                        (_imbalanceDirectionChanges ? ` changes=${_imbalanceDirectionChanges}` : '')
                    );
                    if (_imbalanceCount >= IMBALANCE_CONSECUTIVE_INTERVALS) {
                        isImbalanced = true;
                        _imbalanceCount = 0;
                        _imbalanceDirectionChanges = 0;
                        _imbalanceDirection = null;
                        console.log('[coord] Imbalance confirmed → requesting LLM rebalance');
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

    // Also rebalance when the absolute score gap is large, even if both
    // agents have been active (rate-based check can miss persistent asymmetry).
    // Requires IMBALANCE_CONSECUTIVE_INTERVALS consecutive ticks to avoid
    // reacting to momentary fluctuations (mirrors the rate-based guard).
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
                console.log('[coord] Persistent score gap → requesting LLM rebalance');
            }
        } else {
            _gapImbalanceCount = 0;
        }
    }

    const selfId  = beliefs.me.id;
    const selfPos = { x: beliefs.me.x, y: beliefs.me.y };
    if (!selfId || !hasKnownPosition(selfPos)) {
        console.log('[coord] Zone assignment skipped: own position unknown');
        return;
    }
    const peerId  = peer.id;
    const peerPos = hasKnownPosition(peer)
        ? { x: peer.x, y: peer.y }
        : selfPos; // fallback: treat peer as co-located until position arrives

    const zoneStats = await computeZoneStats();

    const scoreGapRatio = Math.min(selfScore, peerScore) / Math.max(1, Math.max(selfScore, peerScore));
    if (Math.max(selfScore, peerScore) >= SCORE_GAP_MIN_SCORE && scoreGapRatio < SCORE_GAP_FORCE_RATIO) {
        laggingAgentId = selfScore <= peerScore ? selfId : peerId;
    }

    // Only call the LLM when truly necessary: on detected imbalance, when there
    // is no previous assignment to fall back on, or once per LLM_MIN_INTERVAL_MS.
    // Routine ticks simply re-apply the last assignment with refreshed zone centers
    // (agents may have moved since the previous call).
    const timeSinceLastLlm = now - _lastLlmCallTs;
    const rebalanceCooldownReady = now - _lastRebalanceTs >= REBALANCE_MIN_INTERVAL_MS;
    if (isImbalanced && !rebalanceCooldownReady) {
        console.log('[coord] Rebalance skipped: recent LLM rebalance still cooling down');
        isImbalanced = false;
    }
    const needsLlm = isImbalanced || !_lastAssignment || timeSinceLastLlm >= LLM_MIN_INTERVAL_MS;

    if (!needsLlm) {
        if (now - _lastAssignmentAppliedTs < ASSIGNMENT_REFRESH_GRACE_MS) {
            console.log('[coord] Periodic zone refresh skipped: assignment changed recently');
            return;
        }
        console.log('[coord] Periodic zone refresh (re-applying last assignment, no LLM call)');
        applyAssignment(_lastAssignment, zoneStats, selfId, selfPos, peerId, peerPos, {
            forceNavigation: false,
        });
        return;
    }

    const { callZoneAssignment } = await import('../llm/llmAgent.js');
    _lastLlmCallTs = now;
    const assignment = await callZoneAssignment(
        zoneStats, selfId, selfPos, peerId, peerPos,
        { selfRate, peerRate, isImbalanced, currentAssignment: _lastAssignment }
    );
    if (!assignment) return;
    if (isImbalanced) _lastRebalanceTs = now;
    _lastAssignment = repairAssignment(assignment, zoneStats, selfId, peerId, { laggingAgentId });

    applyAssignment(_lastAssignment, zoneStats, selfId, selfPos, peerId, peerPos);
}

/**
 * Starts the periodic zone re-assignment loop.
 *
 * The FIRST assignment is now triggered by peer discovery (inside touchPeer),
 * so this loop only handles periodic re-assignments to adapt to game-state
 * changes over time. It fires every ZONE_ASSIGN_INTERVAL_MS.
 *
 * Call once from multiagent_b.js after initCoordinator().
 */
export function startZoneAssignmentLoop() {
    if (!_isCoordinator) return;
    async function tick() {
        await runZoneAssignment();
        setTimeout(tick, ZONE_ASSIGN_INTERVAL_MS);
    }

    // First periodic tick fires after a full interval: the initial assignment
    // is handled by scheduleZoneAssignment() in touchPeer().
    setTimeout(tick, ZONE_ASSIGN_INTERVAL_MS);
    console.log('[coord] Zone assignment loop started');
}

// Public helpers (consumed by deliberation / intentionRevision)

/**
 * Returns true if any peer has an active `go_pick_up` intention on the parcel.
 *
 * @param {string} parcelId
 * @returns {boolean}
 */
export function isParcelClaimedByPeer(parcelId) {
    pruneStale();
    return state.reservations.has(parcelId);
}

/**
 * Manhattan distance from the claiming peer to the parcel, or null if
 * the parcel is not claimed or peer position is unknown.
 *
 * @param {string} parcelId
 * @returns {number|null}
 */
export function peerDistanceToParcel(parcelId) {
    const r = state.reservations.get(parcelId);
    if (!r) return null;
    const peer = state.peers.get(r.peerId);
    if (!peer || peer.x === null || peer.y === null) return null;
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return null;
    return manhattanDistance({ x: peer.x, y: peer.y }, { x: parcel.x, y: parcel.y });
}

/**
 * True iff the parcel is claimed by a peer who is strictly closer than I am.
 * BDI deliberation calls this to skip parcels it should yield.
 *
 * @param {string} parcelId
 * @param {Position} myPos
 * @returns {boolean}
 */
const CLAIM_MARGIN = 2;

export function shouldYieldParcel(parcelId, myPos) {
    if (!hasKnownPosition(myPos)) return false;

    const held = state.yieldedParcels.get(parcelId);
    if (held) {
        if (held.expiresAt > Date.now()) return true;
        state.yieldedParcels.delete(parcelId);
    }

    if (!isParcelClaimedByPeer(parcelId)) return false;
    const peerDist = peerDistanceToParcel(parcelId);
    if (peerDist === null) {
        rememberYieldedParcel(parcelId, null);
        return true; // unknown peer distance — be conservative and yield
    }
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return false;
    const myDist = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    const shouldYield = peerDist < myDist + CLAIM_MARGIN;
    if (shouldYield) {
        const reservation = state.reservations.get(parcelId);
        rememberYieldedParcel(parcelId, reservation?.peerId ?? null);
    }
    return shouldYield;
}

function rememberYieldedParcel(parcelId, peerId) {
    state.yieldedParcels.set(parcelId, {
        peerId,
        expiresAt: Date.now() + YIELDED_PARCEL_TTL_MS,
    });
}

/**
 * Asks the claiming peer to step aside so we can take the parcel.
 *
 * Resolves with the response envelope on acceptance/refusal, rejects
 * on timeout. Intended fire-and-forget from intentionRevision.
 *
 * @param {string} parcelId
 * @returns {Promise<{accepted: boolean, reason: string}>}
 */
export function requestTakeover(parcelId) {
    const reservation = state.reservations.get(parcelId);
    if (!reservation) {
        return Promise.resolve({ accepted: true, reason: 'ok' });
    }

    return new Promise((resolve, reject) => {
        const payload = { action: 'take_parcel', parcelId };
        sendDirect(reservation.peerId, MSG_TYPE.REQUEST, payload)
            .then((ts) => {
                if (ts === null) { reject(new Error('send_failed')); return; }
                const timer = setTimeout(() => {
                    state.pendingRequests.delete(ts);
                    reject(new Error('takeover_timeout'));
                }, REQUEST_TIMEOUT_MS);

                state.pendingRequests.set(ts, {
                    resolve,
                    reject,
                    timer,
                    parcelId,
                    peerId: reservation.peerId,
                });

                console.log(`[coord] → request take_parcel ${parcelId} to=${reservation.peerId} ts=${ts}`);
            })
            .catch(reject);
    });
}

/**
 * Proposes a parcel handoff to the first known peer.
 *
 * Sends a handoff_request with the meetTile and waits for acceptance.
 * Resolves with { accepted, meetTile } or rejects on timeout.
 *
 * @param {{ x: number, y: number }} meetTile
 * @param {string} peerId
 * @returns {Promise<{ accepted: boolean, meetTile: {x,y} }>}
 */
export function requestHandoff(meetTile, peerId) {
    return new Promise((resolve, reject) => {
        sendDirect(peerId, MSG_TYPE.HANDOFF_REQUEST, { meetTile })
            .then((ts) => {
                if (ts === null) { reject(new Error('send_failed')); return; }
                const timer = setTimeout(() => {
                    state.pendingRequests.delete(ts);
                    reject(new Error('handoff_timeout'));
                }, REQUEST_TIMEOUT_MS);

                state.pendingRequests.set(ts, {
                    resolve: (res) => {
                        clearTimeout(timer);
                        resolve({ accepted: res.accepted, meetTile });
                    },
                    reject,
                    timer,
                    peerId,
                });
            })
            .catch(reject);
    });
}

/** Read-only access for debugging / tests. */
export function getPeers() {
    pruneStale();
    return [...state.peers.values()];
}

export function getReservations() {
    pruneStale();
    return [...state.reservations.entries()].map(([parcelId, r]) => ({ parcelId, ...r }));
}

// Message handlers

function handleBeliefUpdate(envelope, senderId, senderName) {
    const wasPositionUnknown = (state.peers.get(senderId)?.x ?? null) === null;
    const peer = touchPeer(senderId, senderName);
    if (!peer) return;
    const me = envelope.payload?.me;
    if (me) {
        if (typeof me.x === 'number') peer.x = me.x;
        if (typeof me.y === 'number') peer.y = me.y;
        if (typeof me.carrying === 'number') peer.carrying = me.carrying;
        if (typeof me.score === 'number') peer.score = me.score;
    }

    // First time we learn this peer's position: apply an immediate heuristic
    // zone split so both agents diverge before the LLM call completes.
    if (_isCoordinator && wasPositionUnknown && peer.x !== null && beliefs.me.x !== null) {
        runHeuristicZoneAssignment().catch(() => {});
    }
}

function handleIntentionUpdate(envelope, senderId, senderName) {
    const peer = touchPeer(senderId, senderName);
    if (!peer) return;
    const intention = envelope.payload?.intention;
    if (!intention) return;

    peer.intention = {
        type: intention.type,
        parcelId: intention.parcelId ?? null,
        targetPos: intention.targetPos ?? null,
        status: intention.status,
        score: intention.score ?? 0,
        ts: envelope.ts,
    };

    // Reservation table maintenance
    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const isActive = intention.status === 'pending' || intention.status === 'active';
        if (isActive) {
            state.reservations.set(intention.parcelId, {
                peerId: senderId,
                ts: envelope.ts,
                status: intention.status,
            });
        } else {
            // done / failed → release the reservation if it was ours
            const existing = state.reservations.get(intention.parcelId);
            if (existing?.peerId === senderId) {
                state.reservations.delete(intention.parcelId);
            }
        }
    }
}

function handleRequest(envelope, senderId, senderName, reply) {
    if (!touchPeer(senderId, senderName)) return;
    const { action, parcelId } = envelope.payload ?? {};

    if (action === 'take_parcel') {
        const decision = evaluateTakeover(parcelId);
        replyTo(envelope, decision.accepted, decision.reason);
        if (decision.accepted && parcelId) {
            // Release our own reservation hold (if any) since we agreed to yield.
            const r = state.reservations.get(parcelId);
            if (r?.peerId === senderId) state.reservations.delete(parcelId);
        }
        return;
    }

    // avoid_tile / status_check — not implemented.
    replyTo(envelope, false, 'unknown');
}

function handleResponse(envelope, senderId) {
    const { requestId, accepted, reason } = envelope.payload ?? {};
    const pending = state.pendingRequests.get(requestId);
    if (pending && pending.peerId === senderId) {
        clearTimeout(pending.timer);
        state.pendingRequests.delete(requestId);
        pending.resolve({ accepted: !!accepted, reason: reason ?? 'ok', requestId });
    }
}

function handleParcelClaimed(envelope, senderId, senderName) {
    if (!touchPeer(senderId, senderName)) return;
    const parcelId = envelope.payload?.parcelId;
    if (!parcelId) return;

    state.reservations.delete(parcelId);
    state.yieldedParcels.delete(parcelId);

    suppressClaimedParcel(parcelId);

    const current = _getCurrentIntention();
    if (current?.type === 'go_pick_up' && current.parcelId === parcelId) {
        current.status = 'failed';
        console.log(`[coord] Parcel ${parcelId} claimed by ${senderId}; abandoning local pickup`);
        _requestRevision(true);
    }
}

function handleBlockedAt(envelope) {
    if (isSelfMessage(envelope, null)) return;

    const { x: bx, y: by, direction: blockedDir } = envelope.payload ?? {};
    if (bx === undefined || by === undefined || !blockedDir) return;

    const myX = Math.round(beliefs.me.x ?? -1);
    const myY = Math.round(beliefs.me.y ?? -1);
    if (myX !== bx || myY !== by) return; // we are not the blocker

    if (_pendingYield) return; // already scheduled a yield

    const candidates = PERP_DIRS[blockedDir] ?? [];
    for (const dir of candidates) {
        const { dx, dy } = DIR_DELTA_COORD[dir];
        if (canEnter(myX, myY, myX + dx, myY + dy)) {
            _pendingYield = dir;
            console.log(`[coord] Right-of-way: yielding ${dir} from (${myX},${myY})`);
            return;
        }
    }

    console.log(`[coord] Right-of-way: no free perpendicular direction at (${myX},${myY}), staying`);
}

function handleHandoffRequest(envelope, senderId) {
    if (!touchPeer(senderId)) return;
    const { meetTile } = envelope.payload ?? {};
    if (!meetTile) {
        replyTo(envelope, false, 'unknown');
        return;
    }

    const myIntention = _getCurrentIntention();
    // Handoff intentions are a bilateral commitment even in pending state;
    // go_pick_up / go_deliver only block when actively executing.
    const isHandoffCommitted =
        myIntention &&
        (myIntention.status === 'active' || myIntention.status === 'pending') &&
        (myIntention.type === 'go_handoff' || myIntention.type === 'go_handoff_receive');
    const isBusy =
        isHandoffCommitted ||
        (myIntention &&
            myIntention.status === 'active' &&
            (myIntention.type === 'go_pick_up' || myIntention.type === 'go_deliver'));

    if (isBusy) {
        replyTo(envelope, false, 'busy');
        console.log(`[coord] Handoff request refused: busy (${myIntention.type})`);
        return;
    }

    replyTo(envelope, true, 'ok');
    console.log(`[coord] Handoff request accepted: meet at (${meetTile.x},${meetTile.y})`);
    // Clear any local suppression so the dropped parcel is visible when B delivers it.
    clearParcelSuppressions();

    const stagingTile = findHandoffStagingTile(meetTile, {
        x: beliefs.me.x,
        y: beliefs.me.y,
    }) ?? meetTile;
    const receiveIntention = createIntention('go_handoff_receive', null, stagingTile, 0);
    receiveIntention._meetTile = meetTile;
    _forceIntention(receiveIntention);
}

function findHandoffStagingTile(meetTile, myPos) {
    const candidates = Object.values(DIR_DELTA_COORD)
        .map(({ dx, dy }) => ({ x: meetTile.x + dx, y: meetTile.y + dy }))
        .filter((tile) => isWalkable(tile.x, tile.y));

    candidates.sort((a, b) =>
        manhattanDistance(myPos, a) - manhattanDistance(myPos, b)
    );

    return candidates[0] ?? null;
}

// Helpers

function touchPeer(id, name) {
    if (isSelfMessage(null, id)) return null;

    let peer = state.peers.get(id);
    if (!peer) {
        peer = {
            id,
            name,
            x: null,
            y: null,
            carrying: 0,
            score: 0,
            lastSeen: Date.now(),
            intention: null,
        };
        state.peers.set(id, peer);
        console.log(`[coord] new peer ${id} (${name ?? '?'}) → scheduling zone assignment`);
        // Trigger the first zone assignment as soon as the peer is discovered.
        // The short delay lets the peer's initial belief_update (which carries
        // its position) arrive before the LLM call is made.
        scheduleZoneAssignment(PEER_DISCOVERY_ASSIGN_DELAY_MS);
    } else {
        peer.lastSeen = Date.now();
        if (name && !peer.name) peer.name = name;
    }
    return peer;
}

function isSelfMessage(envelope, senderId) {
    const selfId = beliefs.me.id;
    if (!selfId) return false;
    return senderId === selfId || envelope?.from === selfId;
}

function pruneStale() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const [id, peer] of state.peers) {
        if (peer.lastSeen < cutoff) {
            state.peers.delete(id);
            for (const [parcelId, r] of state.reservations) {
                if (r.peerId === id) state.reservations.delete(parcelId);
            }
            console.log(`[coord] peer ${id} pruned`);
        }
    }
    // Also drop reservations on parcels we no longer know about.
    for (const parcelId of state.reservations.keys()) {
        if (!beliefs.parcels.has(parcelId)) state.reservations.delete(parcelId);
    }
}

function evaluateTakeover(parcelId) {
    if (!parcelId) return { accepted: false, reason: 'unknown' };
    const parcel = beliefs.parcels.get(parcelId);
    if (parcel?.carriedBy === beliefs.me.id) {
        return { accepted: false, reason: 'already_carrying' };
    }
    if (beliefs.me.carrying.includes(parcelId)) {
        return { accepted: false, reason: 'already_carrying' };
    }
    if (!parcel) {
        return { accepted: true, reason: 'out_of_range' };
    }
    return { accepted: true, reason: 'ok' };
}

// Re-exports for convenience
export { sendBroadcast, sendDirect };
