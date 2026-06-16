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

import {
    beliefs,
    manhattanDistance,
    canEnter,
    isWalkable,
    suppressClaimedParcel,
    clearParcelSuppressions,
    suppressHandoffDrop,
} from '../bdi/beliefs.js';
import {
    MSG_TYPE,
    onMessage,
    replyTo,
    sendDirect,
    sendBroadcast,
    prepareDirect,
} from './communication.js';
import {
    createIntention,
} from '../bdi/deliberation.js';
import { setZoneConstraint } from '../bdi/components/zone.js';
import {
    findSpawnerTiles,
    findNearestSpawnerTile,
    findNearestDeliveryTile,
} from '../bdi/components/tilesearch.js';

import { notifyIntentionDone, notifyActionFailed } from '../bdi/intentionRevision.js';
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

// Handoff request retry pacing: fast retries first, then a slower cadence while
// the peer stays busy.
const HANDOFF_BUSY_RETRY_MS = 300;
const HANDOFF_BUSY_SLOW_RETRY_MS = 1000;
const HANDOFF_BUSY_FAST_RETRIES = 6;

// Handoff execution pacing (sender drop / receiver pickup).
const HANDOFF_STAGING_MAX_WAIT = 20; // 20 × 500 ms = 10 s max wait at staging tile
const HANDOFF_SENDER_RELEASE_TIMEOUT_MS = 2000;
const HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS = 5;

// Reactive handoff when a delivery is blocked by an empty teammate.
const BLOCKED_HANDOFF_COOLDOWN_MS = 3000;

// Zone-assignment acceptance: a new assignment must beat the current intention
// by at least IMPROVEMENT_THRESHOLD to preempt it; an assigned centre within
// SAME_ZONE_TARGET_DISTANCE of the current target is treated as a no-op.
const IMPROVEMENT_THRESHOLD = 5;
const SAME_ZONE_TARGET_DISTANCE = 0;

const DIR_DELTA_COORD = {
    up: { dx: 0, dy: 1 },
    down: { dx: 0, dy: -1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
};

function hasKnownPosition(pos) {
    return Number.isFinite(pos?.x) && Number.isFinite(pos?.y);
}

const PERP_DIRS = {
    left: ['up', 'down'],
    right: ['up', 'down'],
    up: ['left', 'right'],
    down: ['left', 'right'],
};

/** @type {string|null} */
let _pendingYield = null;

// Push-chain detection: if we're forced to back off in the same direction
// N consecutive times (narrow corridor, no perpendicular exit), force a
// proper navigation intention to escape instead of being walked to spawn.
let _pushChainDir = null;
let _pushChainCount = 0;
let _pushChainTs = 0;
const PUSH_CHAIN_THRESHOLD = 2;
const PUSH_CHAIN_WINDOW_MS = 2500;

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

    // Import scoring functions dynamically to avoid circular dependencies.
    const { pickupValue } = await import('../bdi/scoring.js');

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
        topLeft: { x: Math.round(midX / 2), y: Math.round(midY + midY / 2) },
        topRight: { x: Math.round(midX + midX / 2), y: Math.round(midY + midY / 2) },
        bottomLeft: { x: Math.round(midX / 2), y: Math.round(midY / 2) },
        bottomRight: { x: Math.round(midX + midX / 2), y: Math.round(midY / 2) },
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
        if (aStar(fromPos, s, { avoidAgents: true })) return s;
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
        if (aStar(fromPos, tile, { avoidAgents: true })) return tile;
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
 *   1. dist(A to meet) + dist(B to meet) + dist(meet to delivery) < dist(A to delivery)
 *   2. dist(B to meet) + dist(meet to delivery) < dist(B to currentDelivery or nearestDelivery)
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

    const distADel = manhattanDistance(posA, delivery);
    const distAMeet = manhattanDistance(posA, meetTile);
    const distBMeet = manhattanDistance(posB, meetTile);
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
    const distBCurrent = peerTarget ? manhattanDistance(posB, peerTarget) : Infinity;
    const condition2 = distBMeet + distMeetDel < distBCurrent;

    // Condition 3: handoff should free A significantly before direct delivery,
    // without losing more than a tiny amount of parcel value. Handoff usually
    // cannot improve parcel reward by itself (A to meet to delivery is not shorter
    // than A to delivery), but it can improve team throughput by letting A resume
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
/** @type {(intention: import('../shared/types.js').Intention) => void} */
let _commitIntention = () => {};
/** @type {() => void} */
let _clearIntention = () => {};

/**
 * Initialises the coordinator.
 *
 * The intention-control callbacks (getCurrentIntention / forceIntention /
 * requestRevision / commitIntention / clearIntention) are how the multi layer
 * drives the BDI intention lifecycle without the BDI core importing multi/.
 *
 * @param {{ getCurrentIntention: Function, forceIntention: Function, requestRevision?: Function, commitIntention?: Function, clearIntention?: Function }} callbacks
 */
export function initCoordinator({
    getCurrentIntention,
    forceIntention,
    requestRevision,
    commitIntention,
    clearIntention,
}) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
    if (requestRevision) _requestRevision = requestRevision;
    if (commitIntention) _commitIntention = commitIntention;
    if (clearIntention) _clearIntention = clearIntention;
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

const ZONE_ASSIGN_INTERVAL_MS = 15_000;
const BOTH_BUSY_SCORE_THRESHOLD = 10;
const PEER_DISCOVERY_ASSIGN_DELAY_MS = 500;
const ASSIGNMENT_REFRESH_GRACE_MS = 3000;
const USE_HEURISTIC_PREASSIGN = process.env.USE_HEURISTIC_PREASSIGN !== 'false';

const SCORE_IMBALANCE_THRESHOLD = 0.7;
// Require 3 consecutive imbalanced intervals before acting: reduces false
// positives caused by one agent temporarily being in transit between zones.
const IMBALANCE_CONSECUTIVE_INTERVALS = 3;

// Minimum ms between LLM calls; routine ticks re-apply the last assignment
// deterministically instead of paying LLM latency every 15 s.
// 90 s gives the agents enough time to actually work in a zone before the LLM
// is asked again, preventing oscillation caused by short-lived rate snapshots.
const LLM_MIN_INTERVAL_MS = 90_000;
const REBALANCE_MIN_INTERVAL_MS = 60_000;
// Once agents are actively relaying (handing off), the deliverer scores and the
// feeder scores 0 — a permanent imbalance that would otherwise keep triggering a
// zone re-split and flip the roles mid-relay. While a handoff happened within
// this window, freeze the assignment (no LLM re-split). It releases on its own
// once handoffs stop (e.g. a peer drops) and the window lapses.
const RELAY_FREEZE_TTL_MS = 12_000;
// Trigger a rebalance when the trailing agent has less than this fraction
// of the leading agent's score (and both have scored enough to be reliable).
// Raised from 0.55 to 0.60 so minor asymmetries don't trigger unnecessary swaps.
const SCORE_GAP_RATIO_THRESHOLD = 0.6;
const SCORE_GAP_MIN_SCORE = 50;
const SCORE_GAP_FORCE_RATIO = 0.45;

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
// True once any zone assignment has been applied. Before this, the agent has
// never been coordinated, so a parcel it grabbed greedily while solo must not
// block the very first zone split (see the selfBusy override below).
let _hasEverAssigned = false;

/** Timestamp of the last actual LLM call (ms). */
let _lastLlmCallTs = 0;
let _lastRebalanceTs = 0;
// Last time this agent took part in a handoff (as sender or receiver). Drives the
// relay freeze in runZoneAssignment.
let _lastHandoffActivityTs = 0;

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
    const bestScore = agentKey === 'self' ? stats.bestScoreForSelf : stats.bestScoreForPeer;
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

    // On the very first assignment, override selfBusy as long as the agent is
    // not yet carrying: a pickup it locked onto while solo (before any
    // coordination existed) must not outrank the initial zone split, or the
    // first-to-connect agent keeps chasing an out-of-zone parcel. An in-flight
    // delivery (carrying > 0) is still respected.
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
        const peerCenter = getNearestReachableZoneTarget(peerZoneName, peerPos);
        const peerEffectiveScore = Math.max(
            zoneStats[peerZoneName]?.bestScoreForPeer ?? 0,
            zoneStats[peerZoneName]?.totalReward ?? 0,
            (zoneStats[peerZoneName]?.spawnerCount ?? 0) * 2
        );
        console.log(`[coord] Zone assignment for peer (${peerId}): ${peerZoneName}`);
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

    // For the heuristic split, also apply live-selfBusy so we never interrupt
    // an active delivery just to reposition toward a zone center.
    const liveIntentionH = _getCurrentIntention();
    const selfBusyH =
        liveIntentionH?.status === 'active' &&
        (liveIntentionH.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;

    // First assignment: a parcel grabbed greedily while solo must not block the
    // initial split (the first-to-connect agent would otherwise keep heading
    // onto an out-of-zone parcel). An in-flight delivery is still respected.
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
 * If an assignment sends each agent to the other's current zone (they would
 * have to cross paths on a narrow corridor), swap the assignments to keep
 * each agent on its own side.
 *
 * Only triggers when the two agents are in genuinely different zones, so it
 * does not interfere when both agents are on the same side (e.g. both in
 * topLeft during an active handoff transit).
 *
 * @param {Record<string, string>} assignment
 * @param {string} selfId
 * @param {{ x: number, y: number }} selfPos
 * @param {string} peerId
 * @param {{ x: number, y: number }} peerPos
 * @returns {Record<string, string>}
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
    return assignment;
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

    // Scoring-rate tracking and imbalance detection
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
    const peerPos = hasKnownPosition(peer) ? { x: peer.x, y: peer.y } : selfPos; // fallback: treat peer as co-located until position arrives

    const zoneStats = await computeZoneStats();

    const scoreGapRatio =
        Math.min(selfScore, peerScore) / Math.max(1, Math.max(selfScore, peerScore));
    if (
        Math.max(selfScore, peerScore) >= SCORE_GAP_MIN_SCORE &&
        scoreGapRatio < SCORE_GAP_FORCE_RATIO
    ) {
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

    // Relay freeze: while agents are actively handing off, keep the current
    // assignment frozen. The feeder/deliverer score gap is inherent to a relay,
    // not a real imbalance, so a re-split here only flip-flops the roles. The
    // first assignment still proceeds (no handoff can have happened yet); the
    // freeze lifts once handoffs stop (e.g. a peer drops) and the window lapses.
    const relayActive = _lastHandoffActivityTs > 0 && now - _lastHandoffActivityTs < RELAY_FREEZE_TTL_MS;
    if (relayActive && _lastAssignment && (isImbalanced || timeSinceLastLlm >= LLM_MIN_INTERVAL_MS)) {
        console.log('[coord] Zone re-split suppressed: relay active (assignment frozen)');
        isImbalanced = false;
    }

    const needsLlm =
        !_lastAssignment || (!relayActive && (isImbalanced || timeSinceLastLlm >= LLM_MIN_INTERVAL_MS));

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

    const { callZoneAssignment } = await import('../llm/llmAgent.js');
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
        // Register the handler BEFORE sending so a fast peer response is never dropped.
        const { ts, send } = prepareDirect(reservation.peerId, MSG_TYPE.REQUEST, payload);
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

        console.log(`[coord] sending request take_parcel ${parcelId} to=${reservation.peerId} ts=${ts}`);

        send()
            .then((result) => {
                if (result === null) {
                    clearTimeout(timer);
                    state.pendingRequests.delete(ts);
                    reject(new Error('send_failed'));
                }
            })
            .catch((err) => {
                clearTimeout(timer);
                state.pendingRequests.delete(ts);
                reject(err);
            });
    });
}

/**
 * Proposes a parcel handoff to the first known peer.
 *
 * Sends a handoff_request with the meetTile and waits for acceptance.
 * Resolves with { accepted, reason, meetTile } or rejects on timeout.
 *
 * @param {{ x: number, y: number }} meetTile
 * @param {string} peerId
 * @returns {Promise<{ accepted: boolean, reason: string, meetTile: {x,y}, stagingTile?: {x,y}|null }>}
 */
export function requestHandoff(meetTile, peerId) {
    return new Promise((resolve, reject) => {
        // Register the handler BEFORE sending so a fast peer response is never
        // dropped. The old pattern (register in sendDirect's .then) had a race:
        // if the peer responded before the .then ran, handleResponse found no
        // pending entry and silently discarded the reply, leaving the sender stuck.
        const { ts, send } = prepareDirect(peerId, MSG_TYPE.HANDOFF_REQUEST, { meetTile });
        const timer = setTimeout(() => {
            state.pendingRequests.delete(ts);
            reject(new Error('handoff_timeout'));
        }, REQUEST_TIMEOUT_MS);

        state.pendingRequests.set(ts, {
            resolve: (res) => {
                clearTimeout(timer);
                if (res.accepted) _lastHandoffActivityTs = Date.now();
                resolve({
                    accepted: res.accepted,
                    reason: res.reason ?? 'ok',
                    meetTile,
                    stagingTile: res.stagingTile ?? null,
                });
            },
            reject,
            timer,
            peerId,
        });

        send()
            .then((result) => {
                if (result === null) {
                    clearTimeout(timer);
                    state.pendingRequests.delete(ts);
                    reject(new Error('send_failed'));
                }
            })
            .catch((err) => {
                clearTimeout(timer);
                state.pendingRequests.delete(ts);
                reject(err);
            });
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

// Handoff protocol (sender side)
//
// After a pickup the BDI core asks evaluateHandoff() whether passing the load
// to the peer is worthwhile; if so it calls proposeHandoff() (via the
// coordination seam). proposeHandoff parks the agent on a placeholder `wait`
// (flagged _handoffRetry so revise() won't preempt it), negotiates with the
// peer through requestHandoff, and on acceptance commits the go_handoff
// intention the executor carries out. All intention mutation goes through the
// injected _commitIntention / _clearIntention / _requestRevision callbacks so
// this module never imports the BDI core.

/** True for the placeholder `wait` held while a handoff request is in flight. */
export function isHandoffRetryWait(intention) {
    return intention?.type === 'wait' && intention._handoffRetry === true;
}

// Clears a stuck _handoffRetry wait so revise() can produce a fresh intention.
// Called when a handoff attempt fails or times out, since requestRevision(true)
// alone cannot replace an already-active wait (revise skips the comparison block
// when force=true and an active intention exists).
function abandonHandoffRetryWait() {
    if (isHandoffRetryWait(_getCurrentIntention())) {
        _clearIntention();
    }
}

/**
 * Proposes a handoff to the peer, retrying while the peer is busy.
 *
 * @param {{ peerId: string, meetTile: Position }} handoff
 * @param {number} [attempt]
 */
export function proposeHandoff(handoff, attempt = 0) {
    if (beliefs.me.carrying.length < 1) {
        _requestRevision(true);
        return;
    }

    let current = _getCurrentIntention();
    if (!current || current.status === 'failed' || current.status === 'done') {
        const hold = createIntention(
            'wait',
            null,
            beliefs.me.x !== null && beliefs.me.y !== null
                ? { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) }
                : null,
            0
        );
        hold._handoffRetry = true;
        hold._handoffRetryPeerId = handoff.peerId;
        _commitIntention(hold);
        current = _getCurrentIntention();
    } else if (!isHandoffRetryWait(current)) {
        return;
    }

    if (current) current.createdAt = Date.now();

    console.log(`[coord] Proposing handoff to ${handoff.peerId}`);
    requestHandoff(handoff.meetTile, handoff.peerId)
        .then((res) => {
            if (res.accepted) {
                const live = _getCurrentIntention();
                if (live && !isHandoffRetryWait(live)) return;
                console.log(`[coord] Handoff accepted, go_handoff`);
                const intention = createIntention('go_handoff', null, handoff.meetTile, 0);
                intention._peerStagingTile = res.stagingTile ?? null;
                intention._peerId = handoff.peerId;
                intention._peerCarryBefore =
                    getPeers().find((p) => p.id === handoff.peerId)?.carrying ?? 0;
                _commitIntention(intention);
                return;
            }

            if (res.reason === 'busy') {
                const live = _getCurrentIntention();
                if (live && !isHandoffRetryWait(live)) return;
                const delay =
                    attempt < HANDOFF_BUSY_FAST_RETRIES
                        ? HANDOFF_BUSY_RETRY_MS
                        : HANDOFF_BUSY_SLOW_RETRY_MS;
                console.log(
                    `[coord] Handoff peer busy, retry ` +
                        `${attempt + 1}${attempt >= HANDOFF_BUSY_FAST_RETRIES ? ' (slow)' : `/${HANDOFF_BUSY_FAST_RETRIES}`}`
                );
                setTimeout(() => proposeHandoff(handoff, attempt + 1), delay);
                return;
            }

            abandonHandoffRetryWait();
            _requestRevision(true);
        })
        .catch(() => {
            abandonHandoffRetryWait();
            _requestRevision(true);
        });
}

// Handoff execution (executor seam)
//
// Executing a go_handoff / go_handoff_receive intention is a multi-agent
// concern, so the bodies live here rather than in the BDI executor. The
// executor dispatches its switch cases to runHandoff(), passing an execCtx
// of the two executor primitives the handoff needs — stepTowardsTarget (to
// walk to the meet tile) and safeSocketAction (the transport-aware action
// wrapper). Everything else (beliefs mutation, peer lookups, intention
// lifecycle) is reached directly, keeping the executor free of handoff logic.

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the agent stands on `tile`. */
function isAtTile(tile) {
    if (!tile) return false;
    return Math.round(beliefs.me.x) === tile.x && Math.round(beliefs.me.y) === tile.y;
}

/** Cardinal direction from `from` to an orthogonally adjacent `to`, or null. */
function directionTo(from, to) {
    if (!from || !to) return null;
    const dx = Math.round(to.x) - Math.round(from.x);
    const dy = Math.round(to.y) - Math.round(from.y);
    return Object.entries(DIR_DELTA_COORD).find(([, d]) => d.dx === dx && d.dy === dy)?.[0] ?? null;
}

function isPeerId(agentId) {
    return getPeers().some((p) => p.id === agentId);
}

function peerCarryingCount(agentId) {
    return getPeers().find((p) => p.id === agentId)?.carrying ?? 0;
}

// Reactive blocked-delivery handoff: at most one in flight, rate-limited.
let _blockedHandoffInFlight = false;
let _lastBlockedHandoffAt = 0;

/**
 * When the agent is delivering but an empty teammate blocks the path, propose
 * handing the load to that teammate at the agent's current tile instead of
 * fighting for the route. Returns true when the situation was handled (a
 * handoff was committed, or a retry/cooldown sleep was taken), false when the
 * caller should fall through to its normal blocked-move handling.
 *
 * @param {import('../shared/types.js').Intention} intention
 * @param {{ id: string, x: number, y: number } | null} blockingAgent
 * @param {number} blockerCarryCount
 * @returns {Promise<boolean>}
 */
export async function tryBlockedDeliveryHandoff(intention, blockingAgent, blockerCarryCount) {
    if (
        intention.type !== 'go_deliver' ||
        beliefs.me.carrying.length === 0 ||
        !blockingAgent ||
        !isPeerId(blockingAgent.id) ||
        blockerCarryCount > 0
    ) {
        return false;
    }

    const now = Date.now();
    if (_blockedHandoffInFlight || now - _lastBlockedHandoffAt < BLOCKED_HANDOFF_COOLDOWN_MS) {
        await sleep(250);
        return true;
    }

    const meetTile = {
        x: Math.round(beliefs.me.x),
        y: Math.round(beliefs.me.y),
    };
    _blockedHandoffInFlight = true;
    _lastBlockedHandoffAt = now;

    console.log(
        `[coord] Blocked delivery: proposing handoff at (${meetTile.x},${meetTile.y}) ` +
            `to blocker ${blockingAgent.id}`
    );

    try {
        const res = await requestHandoff(meetTile, blockingAgent.id);
        if (!res.accepted) {
            console.log(
                `[coord] Blocked delivery handoff refused by ${blockingAgent.id} ` +
                    `(${res.reason ?? 'unknown'})`
            );
            if (res.reason === 'busy') {
                await sleep(300);
                return true;
            }
            return false;
        }

        const handoff = createIntention('go_handoff', null, meetTile, 0);
        handoff._peerId = blockingAgent.id;
        handoff._peerCarryBefore = blockerCarryCount;
        handoff._peerStagingTile = res.stagingTile ?? {
            x: Math.round(blockingAgent.x),
            y: Math.round(blockingAgent.y),
        };
        console.log(
            `[coord] Blocked delivery handoff accepted by ${blockingAgent.id}, ` +
                `go_handoff at (${meetTile.x},${meetTile.y})`
        );
        _forceIntention(handoff);
        return true;
    } catch (err) {
        console.log(`[coord] Blocked delivery handoff failed: ${err?.message ?? err}`);
        return false;
    } finally {
        _blockedHandoffInFlight = false;
    }
}

/**
 * Dispatches a handoff intention to its executor body.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {import('../shared/types.js').Intention} intention
 * @param {{ stepTowardsTarget: Function, safeSocketAction: Function }} execCtx
 */
export async function runHandoff(socket, intention, execCtx) {
    if (intention.type === 'go_handoff_receive') {
        await executeHandoffReceive(socket, intention, execCtx);
    } else {
        await executeHandoff(socket, intention, execCtx);
    }
}

/**
 * Executes a handoff intention: walks to the meetTile and puts down all parcels.
 * The peer will pick them up and deliver them. After put_down, A resumes normal
 * deliberation.
 */
async function executeHandoff(socket, intention, execCtx) {
    if (!isAtTile(intention.targetPos)) {
        await execCtx.stepTowardsTarget(socket, intention);
        return;
    }

    // At meetTile: drop all parcels
    const dropped = await execCtx.safeSocketAction('handoff putdown', () => socket.emitPutdown());
    if (dropped === null) return;
    const droppedIds = [...beliefs.me.carrying];
    beliefs.me.carrying = [];
    for (const id of droppedIds) suppressHandoffDrop(id);

    console.log(
        `[coord] Handoff: parcels dropped at (${intention.targetPos.x},${intention.targetPos.y})`
    );

    // Vacate the meet tile so B can enter and pick up.
    // Try each direction; pick the first walkable tile that is NOT the staging
    // tile B is coming from (i.e., avoid moving toward B).
    const stagingDir =
        intention._peerApproachDir ?? directionTo(intention.targetPos, intention._peerStagingTile);
    for (const dir of ['right', 'left', 'up', 'down']) {
        if (dir === stagingDir) continue;
        const fx = Math.round(beliefs.me.x);
        const fy = Math.round(beliefs.me.y);
        const { dx, dy } = DIR_DELTA_COORD[dir];
        const nx = fx + dx;
        const ny = fy + dy;
        if (canEnter(fx, fy, nx, ny)) {
            await execCtx.safeSocketAction(`handoff vacate ${dir}`, () => socket.emitMove(dir));
            console.log(`[coord] Handoff: vacated meet tile, moved ${dir}`);
            break;
        }
    }

    await waitForHandoffReceiver(intention);

    notifyIntentionDone();
}

async function waitForHandoffReceiver(intention) {
    if (!intention._peerId) {
        await sleep(500);
        return;
    }

    const startedAt = Date.now();
    const peerCarryBefore = intention._peerCarryBefore ?? peerCarryingCount(intention._peerId);
    while (Date.now() - startedAt < HANDOFF_SENDER_RELEASE_TIMEOUT_MS) {
        const peerCarryNow = peerCarryingCount(intention._peerId);
        if (peerCarryNow > peerCarryBefore) {
            console.log(
                `[coord] Handoff: receiver ${intention._peerId} picked up; releasing sender`
            );
            return;
        }
        await sleep(100);
    }

    console.log(
        `[coord] Handoff: receiver confirmation timeout after ` +
            `${HANDOFF_SENDER_RELEASE_TIMEOUT_MS}ms; releasing sender`
    );
}

/**
 * Executes a handoff-receive intention: B walks to the meetTile, picks up all
 * parcels dropped there by A, then delivers them.
 *
 * After emitPickup the normal BDI loop takes over: the next revise() call will
 * see carrying > 0 and produce go_deliver.
 */
async function executeHandoffReceive(socket, intention, execCtx) {
    const meetTile = intention._meetTile ?? intention.targetPos;

    if (!isAtTile(intention.targetPos)) {
        await execCtx.stepTowardsTarget(socket, intention);
        return;
    }

    // With a staged handoff, B waits next to the meet tile so A can enter,
    // put down the parcels, and leave. Once the dropped parcels are visible,
    // B switches target to the meet tile and picks them up.
    if (intention._meetTile && !isAtTile(meetTile)) {
        // The receiver may have suppressed the parcel while A was carrying it.
        // Keep clearing normal claim suppressions during the staged wait so A's
        // dropped parcel becomes visible immediately after putdown.
        clearParcelSuppressions();

        const parcelReady = [...beliefs.parcels.values()].some(
            (parcel) =>
                !parcel.carriedBy &&
                Math.round(parcel.x) === meetTile.x &&
                Math.round(parcel.y) === meetTile.y
        );

        if (!parcelReady) {
            intention._stagingWait = (intention._stagingWait ?? 0) + 1;
            if (intention._stagingWait >= HANDOFF_STAGING_MAX_WAIT) {
                console.log(
                    '[coord] Handoff receive: timed out waiting at staging tile, failing'
                );
                notifyActionFailed('handoff_timeout');
                return;
            }
            console.log(
                `[coord] Handoff receive: waiting near meet tile ` +
                    `(${meetTile.x},${meetTile.y}) [${intention._stagingWait}/${HANDOFF_STAGING_MAX_WAIT}]`
            );
            await sleep(500);
            return;
        }

        intention.targetPos = meetTile;
        intention._pickupAttempts = 0;
        return;
    }

    // At meetTile: try to pick up parcels dropped by A.
    // A may not have arrived yet — retry up to HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS
    // times before giving up and letting BDI re-deliberate.
    intention._pickupAttempts = (intention._pickupAttempts ?? 0) + 1;

    const picked = await execCtx.safeSocketAction('handoff pickup', () => socket.emitPickup());
    if (picked === null) return;

    if (!picked || picked.length === 0) {
        if (intention._pickupAttempts >= HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS) {
            console.log('[coord] Handoff receive: no parcels after max attempts, failing');
            notifyActionFailed('pickup_empty');
        } else {
            console.log(
                `[coord] Handoff receive: nothing yet, attempt ${intention._pickupAttempts}/${HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS} — waiting`
            );
            await sleep(500);
        }
        return;
    }

    // Update beliefs before the next sensing event
    for (const p of picked) {
        const id = p.id;
        const parcel = beliefs.parcels.get(id);
        if (parcel) parcel.carriedBy = beliefs.me.id;
        if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
    }

    console.log(`[coord] Handoff receive OK: picked up ${picked.length} parcel(s)`);
    notifyIntentionDone(); // triggers revise(), then go_deliver
}

// Zone assignment (receiver side)

/**
 * Registers the handler for incoming ZONE_ASSIGN messages.
 *
 * Converts a zone assignment into a go_to intention toward the zone center.
 * Accepted only if the assignment score exceeds the current intention score
 * by at least IMPROVEMENT_THRESHOLD, so the LLM cannot interrupt a
 * high-value pickup mid-execution.
 *
 * Call once from multiagent_a.js / multiagent_b.js after initCoordinator().
 */
export function initZoneAssignHandler() {
    onMessage(MSG_TYPE.ZONE_ASSIGN, (envelope) => {
        const { targetId, center, score: payloadScore, totalReward } = envelope.payload ?? {};

        // Ignore assignments meant for the other agent.
        if (targetId !== beliefs.me.id) return;
        if (!center) return;

        const score = payloadScore ?? totalReward ?? 0;

        const current = _getCurrentIntention();
        const currentScore = current?.score ?? 0;
        const currentType = current?.type ?? null;

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

        // Resolve the navigation target: use the assigned centre if reachable,
        // otherwise find the nearest reachable tile in the zone (spawner first,
        // then the closest walkable tile to the geometric centre).
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

        // Persist the zone so every future deliberation cycle stays within it,
        // not just the one-shot go_to waypoint.
        if (envelope.payload?.zone) setZoneConstraint(envelope.payload.zone);

        if (envelope.payload?.forceNavigation === false) {
            console.log(`[coord] Zone assign refreshed constraint only: ${envelope.payload.zone}`);
            return;
        }

        const intention = createIntention('go_to', null, target, score);
        console.log(
            `[coord] Zone assign accepted, go_to (${target.x},${target.y}) score=${score}`
        );

        // Replace the current intention (fails + broadcasts it, then commits).
        _forceIntention(intention);
    });
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
            // done or failed: release the reservation if it was ours
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
    const { requestId, accepted, reason, ...extraPayload } = envelope.payload ?? {};
    const pending = state.pendingRequests.get(requestId);
    if (pending && pending.peerId === senderId) {
        clearTimeout(pending.timer);
        state.pendingRequests.delete(requestId);
        pending.resolve({
            accepted: !!accepted,
            reason: reason ?? 'ok',
            requestId,
            ...extraPayload,
        });
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

function handleBlockedAt(envelope, senderId) {
    if (isSelfMessage(envelope, null)) return;

    const { x: bx, y: by, direction: blockedDir, carrying } = envelope.payload ?? {};
    if (bx === undefined || by === undefined || !blockedDir) return;

    const myX = Math.round(beliefs.me.x ?? -1);
    const myY = Math.round(beliefs.me.y ?? -1);
    if (myX !== bx || myY !== by) return; // we are not the blocker

    if (_pendingYield) return; // already scheduled a yield

    const requesterCarry = Number.isFinite(carrying)
        ? carrying
        : (state.peers.get(senderId)?.carrying ?? 0);
    const myCarry = beliefs.me.carrying.length;
    if (myCarry > requesterCarry) {
        console.log(
            `[coord] Right-of-way: keeping priority at (${myX},${myY}) ` +
                `mine=${myCarry} requester=${requesterCarry}`
        );
        return;
    }

    const candidates = PERP_DIRS[blockedDir] ?? [];
    for (const dir of candidates) {
        const { dx, dy } = DIR_DELTA_COORD[dir];
        if (canEnter(myX, myY, myX + dx, myY + dy)) {
            _pendingYield = dir;
            _pushChainCount = 0;
            _pushChainDir = null;
            console.log(`[coord] Right-of-way: yielding ${dir} from (${myX},${myY})`);
            return;
        }
    }

    // Fallback for narrow corridors (e.g. 1D): no perpendicular tile available.
    // Back off in the same direction the blocked agent is travelling so it can
    // pass through our current tile.
    const { dx: bfDx, dy: bfDy } = DIR_DELTA_COORD[blockedDir] ?? {};
    const fallbackX = myX + (bfDx ?? 0);
    const fallbackY = myY + (bfDy ?? 0);
    const fallbackTile = beliefs.grid.get(`${fallbackX},${fallbackY}`);
    const wouldRetreatIntoDelivery = fallbackTile?.type === '2' && beliefs.me.carrying.length === 0;
    if (
        bfDx !== undefined &&
        !wouldRetreatIntoDelivery &&
        canEnter(myX, myY, fallbackX, fallbackY)
    ) {
        // Push-chain detection: if we keep backing off in the same direction
        // (narrow 1D corridor), escape laterally to the zone center after N steps.
        const nowPc = Date.now();
        if (_pushChainDir === blockedDir && nowPc - _pushChainTs < PUSH_CHAIN_WINDOW_MS) {
            _pushChainCount++;
        } else {
            _pushChainCount = 1;
            _pushChainDir = blockedDir;
        }
        _pushChainTs = nowPc;

        if (_pushChainCount >= PUSH_CHAIN_THRESHOLD) {
            _pushChainCount = 0;
            _pushChainDir = null;
            const myPos = { x: myX, y: myY };
            const zone = getZone(myPos, beliefs.grid);
            const target = getNearestReachableZoneTarget(zone, myPos);
            if (target && (target.x !== myX || target.y !== myY)) {
                console.log(
                    `[coord] Push-chain break (${PUSH_CHAIN_THRESHOLD}×${blockedDir}), ` +
                        `go_to (${target.x},${target.y})`
                );
                _forceIntention(createIntention('go_to', null, target, 5));
            } else {
                _requestRevision(true);
            }
            return;
        }

        _pendingYield = blockedDir;
        console.log(`[coord] Right-of-way: backing off ${blockedDir} from (${myX},${myY})`);
        return;
    }
    if (wouldRetreatIntoDelivery) {
        console.log(
            `[coord] Right-of-way: not backing off ${blockedDir} into delivery ` +
                `from (${myX},${myY}) while empty`
        );
        return;
    }

    console.log(`[coord] Right-of-way: no free direction at (${myX},${myY}), staying`);
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

    const stagingTile =
        findHandoffStagingTile(meetTile, {
            x: beliefs.me.x,
            y: beliefs.me.y,
        }) ?? meetTile;

    replyTo(envelope, true, 'ok', { stagingTile });
    _lastHandoffActivityTs = Date.now();
    console.log(`[coord] Handoff request accepted: meet at (${meetTile.x},${meetTile.y})`);
    // Clear any local suppression so the dropped parcel is visible when B delivers it.
    clearParcelSuppressions();

    const receiveIntention = createIntention('go_handoff_receive', null, stagingTile, 0);
    receiveIntention._meetTile = meetTile;
    _forceIntention(receiveIntention);
}

function findHandoffStagingTile(meetTile, myPos) {
    const candidates = Object.values(DIR_DELTA_COORD)
        .map(({ dx, dy }) => ({ x: meetTile.x + dx, y: meetTile.y + dy }))
        .filter((tile) => isWalkable(tile.x, tile.y));

    candidates.sort((a, b) => manhattanDistance(myPos, a) - manhattanDistance(myPos, b));

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
        console.log(`[coord] new peer ${id} (${name ?? '?'}), scheduling zone assignment`);
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
