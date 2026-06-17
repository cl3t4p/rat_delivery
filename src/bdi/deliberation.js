/**
 * deliberation.js
 *
 * The agent's decision-making layer: given the Belief Store, chooses what to do.
 *
 */

import { beliefs, isWalkable } from './beliefs.js';
import { llmMemory, getStackMultiplier, getBestStackTarget } from '../llm/llmAgent.js';
import { shouldYieldParcel } from './coordination.js';
import { deliveryValue, detourValue, estimatedRewardAtDelivery } from './scoring.js';
import { aStar } from './pathfinding.js';
import { getHalfPoint } from '../shared/zones.js';
import {
    _zoneConstraint,
    setZoneConstraint,
    _isInZone,
    _matchesZoneOpportunity,
} from './components/zone.js';
import {
    USE_PDDL,
    sameTile,
    costToReachPath,
    manhattanDistance,
    findBestReachable,
} from './helper.js';

import {
    findSpawnerTiles,
    findBestReachableSpawnerTile,
    spawnersAreSparse,
    findNearestDeliveryTile,
    findBestDeliveryTile,
    findBestDeliveryPathFrom,
    isTileOccupiedByOtherAgent,
} from './components/tilesearch.js';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */
/** @typedef {import('../shared/types.js').IntentionType} IntentionType */
/** @typedef {import('../shard/types.js').ZoneName} ZoneName*/

// When parcels spawn at least this rarely, camping one spawner is wasteful, so
// we roam between spawn points instead. Compared against the already-parsed
const SLOW_SPAWN_THRESHOLD_MS = Number(process.env.SLOW_SPAWN_MS) || 5000;

// In sparse-spawner maps, stay committed to a patrol target long enough to
// actually observe it before rotating. This prevents oscillation between nearby
// spawners caused by re-scoring the nearest target on every sensing tick.
const SPAWNER_DWELL_MS = Number(process.env.SPAWNER_DWELL_MS) || 300;

const DETOUR_NEAR_EXTRA_STEPS = 3;
const DETOUR_MAX_EXTRA_STEPS = 8;
const DETOUR_HIGH_EFFECTIVE_GAIN = 10;

const MIN_PICKUP_SCORE =
    process.env.MIN_PICKUP_SCORE === undefined ? -Infinity : Number(process.env.MIN_PICKUP_SCORE);

const LOCAL_PICKUP_MAX_DISTANCE = Number(process.env.LOCAL_PICKUP_MAX_DISTANCE ?? 3);
const LOCAL_PICKUP_MIN_REWARD = Number(process.env.LOCAL_PICKUP_MIN_REWARD ?? 15);
const LOCAL_PICKUP_MIN_SCORE = Number(process.env.LOCAL_PICKUP_MIN_SCORE ?? -25);

// Cache for detour evaluations: invalidated whenever the agent moves to a new tile.
let _detourCachePos = { x: null, y: null };
/**
 * Memoized detour evaluations, keyed by parcel id. A null value means the detour
 * was found impossible (some leg unreachable); the whole map is cleared whenever
 * the agent moves to a new tile.
 *
 * @type {Map<string, {extraSteps: number, effectiveGain: number, accepted: boolean} | null>}
 */
const _detourCache = new Map();

let _lastDelibLog = null;
/**
 * Print only if the key is changed
 * @param {*} key
 * @param {*} msg to print
 */
function printLog(key, msg) {
    if (_lastDelibLog !== key) {
        _lastDelibLog = key;
        console.log(msg);
    }
}

/** @type {Position|null} */
let _roamTarget = null;
let _roamTargetZone = null;
let _roamArrivalTs = 0;
// Position in the (deterministically sorted) spawner cycle of the current patrol
// target. Persists across ticks so the rotation resumes where it left off after
// an interruption (e.g. a pickup) instead of restarting at the nearest spawner,
// which would let the agent double back and never cover the whole loop.
let _roamIndex = null;

export function resetRoamTarget() {
    _roamTarget = null;
    _roamTargetZone = null;
    _roamArrivalTs = 0;
    _roamIndex = null;
}

/**
 * Finds a reachable walkable tile at (or nearest to) the map's half point — the
 * parking spot for an agent whose assigned half has no spawner.
 *
 * @param {Position} me
 * @returns {Position|null}
 */
function halfPointTarget(me) {
    const half = getHalfPoint(beliefs.grid);
    if (isWalkable(half.x, half.y) && costToReachPath(me, half) != null) {
        return half;
    }

    // Half point is a wall or unreachable: snap to the nearest reachable walkable
    // tile, scanning closest-first and capping the path checks.
    const candidates = [];
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (!isWalkable(x, y)) {
            continue;
        }
        candidates.push({ x, y, d: Math.abs(x - half.x) + Math.abs(y - half.y) });
    }
    candidates.sort((a, b) => a.d - b.d);

    const MAX_CHECKS = 25;
    for (let i = 0; i < candidates.length && i < MAX_CHECKS; i++) {
        const c = candidates[i];
        if (costToReachPath(me, { x: c.x, y: c.y }) != null) {
            return { x: c.x, y: c.y };
        }
    }
    return null;
}

/**
 * Creates a standard Intention object.
 *
 * @param {IntentionType} type - Intention type.
 * @param {string|null} parcelId - Target parcel id, or null if not applicable.
 * @param {Position|null} targetPos - Destination position, or null if not applicable.
 * @param {number} [score=0] - Utility score assigned to this intention.
 * @returns {Intention}
 */
export function createIntention(type, parcelId, targetPos, score = 0) {
    return {
        type,
        parcelId,
        targetPos,
        plan: [],
        status: 'pending',
        createdAt: Date.now(),
        score,
    };
}

/**
 * Computes and returns the best possible Intention based on the current beliefs.
 *
 * Priority:
 *   1. If carrying parcels, deliver them.
 *   2. If free parcels are available, pick up the best one.
 *   3. Otherwise, explore.
 *
 * @returns {Intention}
 */
export function getBestIntention() {
    // Current position
    if (beliefs.me.x === null || beliefs.me.y === null) {
        console.log('[deliberation] Position unknown, waiting...');
        return createIntention('wait', null, null, 0);
    }

    const me = { x: beliefs.me.x, y: beliefs.me.y };

    // ----------------------------------------------------------------
    // Case 1: carrying parcels, so consider delivery.
    // ----------------------------------------------------------------
    if (beliefs.me.carrying.length > 0) {
        // Check that carried parcels still exist in the beliefs.
        const realCarrying = beliefs.me.carrying.filter((id) => beliefs.parcels.has(id));
        if (realCarrying.length === 0) {
            beliefs.me.carrying = []; // Cleanup: sensing has not updated this state yet.
        } else {
            // Maximum number of parcels the agent can carry.
            const capacity = beliefs.config?.MAX_PARCELS ?? 1;

            // Stack rules: hold back for the best target size while more parcels are reachable.
            if (llmMemory.stackRules.size > 0) {
                const bestTarget = getBestStackTarget(capacity);
                const carrying = beliefs.me.carrying.length;
                if (bestTarget !== null && carrying < bestTarget && carrying < capacity) {
                    const pickUp = findBestPickUp(me, { log: false });
                    if (pickUp) return pickUp;
                }
            }

            // If at full capacity, deliver immediately.
            if (beliefs.me.carrying.length >= capacity) {
                const target = findBestDeliveryTile(me);
                if (target) {
                    const stackMult = getStackMultiplier(beliefs.me.carrying.length);
                    const dvScore = deliveryValue(beliefs.me.carrying, me, target) * stackMult;
                    printLog(
                        `deliver:${target.x},${target.y}`,
                        `[deliberation] go_deliver (full) to (${target.x},${target.y}) ` +
                            `estimatedReward=${dvScore.toFixed(1)} stackMult=${stackMult}`
                    );
                    return createIntention('go_deliver', null, target, dvScore);
                }
            }

            // If not at full capacity, check whether a detour to pick up an extra parcel is worth more than delivering immediately.
            const target = findBestDeliveryTile(me);

            if (target) {
                const pickUp = findBestPickUp(me, { log: false });
                if (pickUp) {
                    const parcel = beliefs.parcels.get(pickUp.parcelId);
                    if (parcel) {
                        //Other agent on the delivery tile
                        if (isTileOccupiedByOtherAgent({ x: parcel.x, y: parcel.y })) {
                            printLog(
                                `detour_occupied:${pickUp.parcelId}`,
                                `[deliberation] Detour skipped parcel=${pickUp.parcelId} ` +
                                    'pickup tile occupied by another agent'
                            );
                        } else {
                            const parcelDelivery = findNearestDeliveryTile({
                                x: parcel.x,
                                y: parcel.y,
                            });
                            if (parcelDelivery) {
                                const gain = detourValue(
                                    parcel,
                                    me,
                                    beliefs.me.carrying,
                                    parcelDelivery
                                );
                                const detour = evaluateDetour(
                                    me,
                                    parcel,
                                    target,
                                    parcelDelivery,
                                    gain
                                );

                                if (detour?.accepted) {
                                    const deliveryScore = deliveryValue(
                                        beliefs.me.carrying,
                                        me,
                                        target
                                    );
                                    pickUp.score = deliveryScore + detour.effectiveGain;

                                    console.log(
                                        `[deliberation] Detour accepted parcel=${pickUp.parcelId} ` +
                                            `gain=${gain.toFixed(1)} ` +
                                            `extraSteps=${detour.extraSteps} ` +
                                            `effectiveGain=${detour.effectiveGain.toFixed(1)} ` +
                                            `score=${pickUp.score.toFixed(1)}`
                                    );
                                    return pickUp;
                                }
                            }
                        }
                    }
                }

                const stackMult = getStackMultiplier(beliefs.me.carrying.length);
                const dvScore = deliveryValue(beliefs.me.carrying, me, target) * stackMult;
                printLog(
                    `deliver:${target.x},${target.y}`,
                    `[deliberation] go_deliver to (${target.x},${target.y}) ` +
                        `estimatedReward=${dvScore.toFixed(1)} stackMult=${stackMult}`
                );
                return createIntention('go_deliver', null, target, dvScore);
            }
        }

        // Carrying but no delivery tile is reachable — wait rather than falling
        // through to findBestPickUp, which would try to grab more parcels while
        // holding items we cannot drop.
        return createIntention('wait', null, null, 0);
    }

    // ----------------------------------------------------------------
    // Case 2: free parcels are available, so pick one up.
    // ----------------------------------------------------------------

    // A free parcel on the tile we're standing on is free to grab — take it
    // immediately instead of letting the delivery-value gate make us hesitate
    // (which matters with relay, where we only carry it partway, and would
    // otherwise leave us waiting on the spawner on top of the parcel).
    const mx = Math.round(me.x);
    const my = Math.round(me.y);
    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy || parcel.reward <= 0) {
            continue;
        }
        if (Math.round(parcel.x) !== mx || Math.round(parcel.y) !== my) {
            continue;
        }
        if (shouldYieldParcel(parcel.id, me)) {
            continue;
        }
        return createIntention(
            'go_pick_up',
            parcel.id,
            { x: parcel.x, y: parcel.y },
            parcel.reward
        );
    }

    let pickUp = findBestPickUp(me);
    if (!pickUp && _zoneConstraint) {
        // Zone is empty — fall back to unclaimed parcels outside the zone rather
        // than waiting indefinitely at a spawner
        pickUp = findBestPickUp(me, { allowOutOfZone: true });
        if (pickUp) {
            printLog(
                `pickup_ooz:${pickUp.parcelId}`,
                `[deliberation] Zone empty — out-of-zone fallback: go_pick_up ${pickUp.parcelId}`
            );
        }
    }
    if (pickUp) return pickUp;

    // ----------------------------------------------------------------
    // Case 3: nothing else to do, so head for the spawners.
    // ----------------------------------------------------------------

    _lastDelibLog = null; // reset dedup when entering exploration path
    const genMs = beliefs.config?.PARCEL_GENERATION_INTERVAL ?? null;
    const spawnsAreRare = genMs !== null && genMs >= SLOW_SPAWN_THRESHOLD_MS;
    const allSpawners = findSpawnerTiles();

    // Respect zone constraint: use only in-zone spawners. If the assigned zone
    // has no spawner, stay near the delivery area as a relay receiver

    const preferredSpawners = _zoneConstraint
        ? allSpawners.filter((s) => _isInZone(s))
        : allSpawners;

    if (_zoneConstraint && preferredSpawners.length === 0) {
        resetRoamTarget();
        // This half has no spawner to patrol: park at the map's half point and
        // wait there, positioned to receive handoffs from the peer working the
        // other half.
        const parkSpot = halfPointTarget(me);
        if (parkSpot && !sameTile(me, parkSpot)) {
            printLog(
                `relay_half:${parkSpot.x},${parkSpot.y}`,
                `[deliberation] No spawner in zone ${_zoneConstraint}, ` +
                    `going to half point (${parkSpot.x},${parkSpot.y})`
            );
            return createIntention('go_to', null, parkSpot, 0);
        }
        printLog(
            'relay_half_wait',
            `[deliberation] No spawner in zone ${_zoneConstraint}, waiting at half point`
        );
        return createIntention('wait', null, null, 0);
    }

    const spawners = preferredSpawners;

    // With several spawners that fire rarely or are spread far apart, camping a
    // single one wastes time: patrol between them in a round-robin instead.
    if (spawners.length > 1 && (spawnsAreRare || spawnersAreSparse(spawners))) {
        // Sort into a stable order so the rotation visits spawners deterministically.
        spawners.sort((a, b) => a.x - b.x || a.y - b.y);

        // Index of the spawner we're currently standing on, or -1 if none.
        const mx = Math.round(me.x);
        const my = Math.round(me.y);
        const onIdx = spawners.findIndex((s) => s.x === mx && s.y === my);

        // Drop a stale roam target: it belonged to a different zone, or it is no
        // longer one of the spawners we're patrolling.
        if (_roamTarget && _roamTargetZone !== _zoneConstraint) {
            resetRoamTarget();
        }

        if (_roamTarget && !spawners.some((s) => s.x === _roamTarget.x && s.y === _roamTarget.y)) {
            resetRoamTarget();
        }

        // Already committed to a roam target we haven't reached yet: keep heading
        // there rather than re-choosing every tick (prevents oscillation). Only
        // bail if it has become unreachable.
        if (_roamTarget && onIdx === -1 && !sameTile(me, _roamTarget)) {
            const result = costToReachPath(me, _roamTarget);
            if (result != null) {
                const reason = spawnsAreRare
                    ? `spawns rare (${genMs}ms)`
                    : 'spawners spread beyond view range';
                console.log(
                    `[deliberation] ${reason}, continuing to spawner ` +
                        `(${_roamTarget.x},${_roamTarget.y})`
                );
                return createIntention('go_to', null, _roamTarget, 0);
            }
            resetRoamTarget();
        }

        // Standing on a spawner.
        if (onIdx !== -1) {
            // Grab a nearby parcel if one is visible and reachable before moving on.
            const opportunisticPickUp = findBestLocalPickUp(me);
            if (opportunisticPickUp) {
                console.log(
                    `[deliberation] On a sparse spawner but visible parcel is reachable, ` +
                        `go_pick_up ${opportunisticPickUp.parcelId}`
                );
                return opportunisticPickUp;
            }

            // Dwell only while we're sitting on our actual patrol target, so we
            // observe it for SPAWNER_DWELL_MS before rotating on.
            if (sameTile(me, _roamTarget)) {
                const now = Date.now();
                if (!_roamArrivalTs) _roamArrivalTs = now;
                if (now - _roamArrivalTs < SPAWNER_DWELL_MS) {
                    console.log('[deliberation] On a sparse spawner, waiting');
                    return createIntention('wait', null, null, 0);
                }
            }
        }

        // Pick the next spawner to head for, advancing the rotation pointer.
        if (onIdx !== -1) {
            _roamIndex = nextReachableSpawnerIndex(me, spawners, onIdx + 1);
        } else if (_roamIndex !== null) {
            _roamIndex = nextReachableSpawnerIndex(me, spawners, _roamIndex);
        } else {
            const best = findBestReachable(me, spawners);
            _roamIndex = best ? spawners.indexOf(best.tile) : -1;
        }

        const target = _roamIndex === -1 ? null : spawners[_roamIndex];

        // Nothing reachable to patrol: wait until something becomes reachable.
        if (!target) {
            resetRoamTarget();
            console.log('[deliberation] No reachable in-zone spawner, waiting');
            return createIntention('wait', null, null, 0);
        }

        // Commit to the chosen spawner; _roamArrivalTs resets so the dwell timer
        // starts fresh once we arrive.
        _roamTarget = target;
        _roamTargetZone = _zoneConstraint;
        _roamArrivalTs = 0;
        const reason = spawnsAreRare
            ? `spawns rare (${genMs}ms)`
            : 'spawners spread beyond view range';
        console.log(
            `[deliberation] ${reason}, roaming to spawner #${_roamIndex}/${spawners.length} ` +
                `(${target.x},${target.y})`
        );
        return createIntention('go_to', null, target, 0);
    }

    // Frequent spawns (or a single spawner): camp the nearest in-zone one,
    // without falling back to another zone.
    const spawner = findBestReachableSpawnerTile(me, spawners);
    if (spawner) {
        if (manhattanDistance(me, spawner) < 1) {
            const opportunisticPickUp = findBestLocalPickUp(me);
            if (opportunisticPickUp) {
                console.log(
                    `[deliberation] On a spawner but visible parcel is reachable, ` +
                        `go_pick_up ${opportunisticPickUp.parcelId}`
                );
                return opportunisticPickUp;
            }
            console.log('[deliberation] On a spawner, wait');
            return createIntention('wait', null, null, 0);
        }
        console.log(`[deliberation] Heading to spawner (${spawner.x},${spawner.y})`);
        return createIntention('explore', null, spawner, 0);
    }

    return createIntention('wait', null, null, 0);
}

function pickupValueByPath(parcel, stepsToParcel, stepsToDelivery) {
    const totalSteps = stepsToParcel + stepsToDelivery;
    const rewardAtDelivery = estimatedRewardAtDelivery(parcel.reward, totalSteps);

    if (rewardAtDelivery <= 0) return -Infinity;

    return rewardAtDelivery - totalSteps;
}

/**
 * Index of the first reachable spawner scanning cyclically forward from `start`.
 * Skips unreachable spawners; returns -1 if none are reachable. Used to advance
 * the patrol rotation while still covering every spawner in order.
 *
 * @param {Position} from
 * @param {Position[]} spawners - Deterministically sorted spawner list.
 * @param {number} start - Index to begin scanning from (may equal spawners.length; wraps).
 * @returns {number}
 */
function nextReachableSpawnerIndex(from, spawners, start) {
    const n = spawners.length;
    for (let i = 0; i < n; i++) {
        const idx = (start + i) % n;
        if (costToReachPath(from, spawners[idx]) != null) return idx;
    }
    return -1;
}

/**
 * Decides whether grabbing an extra parcel on the way to a delivery tile is
 * worthwhile, comparing the direct delivery against the detour route
 * (me to parcel to delivery).
 *
 * Result is cached per parcel
 *
 * @param {Position} myPos - Current position.
 * @param {{id: string, x: number, y: number}} parcel - Candidate parcel to grab on the way.
 * @param {Position} directDelivery - Delivery tile targeted without the detour.
 * @param {Position} parcelDelivery - Delivery tile reached after picking up the parcel.
 * @param {number} gain - Extra reward (from detourValue) for taking the detour.
 * @returns {{extraSteps: number, effectiveGain: number, accepted: boolean} | null}
 *          The evaluation, or null if any leg of the route is unreachable.
 */
function evaluateDetour(myPos, parcel, directDelivery, parcelDelivery, gain) {
    const rx = Math.round(myPos.x);
    const ry = Math.round(myPos.y);

    // Clear the cache whenever the agent steps to a new tile: every cached
    // result was computed from the old position and is now stale.
    if (_detourCachePos.x !== rx || _detourCachePos.y !== ry) {
        _detourCache.clear();
        _detourCachePos = { x: rx, y: ry };
    }

    // Same tile, same parcel: reuse the stored result (incl. cached null) and
    // skip the three A* calls below.
    if (_detourCache.has(parcel.id)) {
        return _detourCache.get(parcel.id);
    }

    // Step counts for the two competing routes:
    //   direct           = me to delivery (no detour)
    //   toParcel         = me to parcel
    //   parcelToDelivery = parcel to delivery
    const direct = costToReachPath(myPos, directDelivery);
    const toParcel = costToReachPath(myPos, { x: parcel.x, y: parcel.y });
    const parcelToDelivery = costToReachPath({ x: parcel.x, y: parcel.y }, parcelDelivery);

    // If any leg is unreachable the detour is impossible; cache the null so we
    // don't retry the pathfinding while standing on this tile.
    if (direct == null || toParcel == null || parcelToDelivery == null) {
        _detourCache.set(parcel.id, null);
        return null;
    }

    // Extra distance the detour costs over delivering directly, and the reward
    // gain net of that cost.
    const directSteps = direct;
    const detourSteps = toParcel + parcelToDelivery;
    const extraSteps = detourSteps - directSteps;
    const effectiveGain = gain - extraSteps;

    // Accept a near detour as long as it nets any positive gain; accept a longer
    const accepted =
        (extraSteps <= DETOUR_NEAR_EXTRA_STEPS && effectiveGain > 0) ||
        (extraSteps <= DETOUR_MAX_EXTRA_STEPS && effectiveGain >= DETOUR_HIGH_EFFECTIVE_GAIN);

    // Log only on first evaluation at this tile (cache miss)
    if (!accepted && extraSteps <= DETOUR_MAX_EXTRA_STEPS + 4) {
        console.log(
            `[deliberation] Detour rejected parcel=${parcel.id} ` +
                `gain=${gain.toFixed(1)} ` +
                `extraSteps=${extraSteps} effectiveGain=${effectiveGain.toFixed(1)}`
        );
    }

    const result = { extraSteps, effectiveGain, accepted };
    _detourCache.set(parcel.id, result);
    return result;
}

/**
 * Finds the free parcel with the highest utility score.
 *
 * @param {Position} myPos - Current position.
 * @param {{ allowOutOfZone?: boolean, minScore?: number, log?: boolean, maxDistanceToParcel?: number, minReward?: number }} [options]
 * @returns {Intention|null}
 */
export function findBestPickUp(myPos, options = {}) {
    const {
        allowOutOfZone = false,
        minScore = MIN_PICKUP_SCORE,
        log = true,
        maxDistanceToParcel = Infinity,
        minReward = 0,
    } = options;
    let bestScore = -Infinity;
    let bestIntention = null;

    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy) continue; // Skip parcels that have already been picked up by another agent.
        if (parcel.reward <= 0) continue; // Skip parcels with no remaining reward.
        if (parcel.reward < minReward) continue;
        // LLM pickup-cap rule: parcels above this reward give nothing, so skip them.
        const pickCap = llmMemory.maxPickupReward;
        if (pickCap != null && parcel.reward > pickCap) continue;
        if (shouldYieldParcel(parcel.id, myPos)) continue; // Peer claimed it and is closer.

        const parcelPos = { x: parcel.x, y: parcel.y };
        if (manhattanDistance(myPos, parcelPos) > maxDistanceToParcel) continue;

        let adjustedScore;
        if (USE_PDDL) {
            // Old single-agent PDDL model: the planner owns pathing
            adjustedScore = parcel.reward - manhattanDistance(myPos, parcelPos);
        } else {
            const stepsToParcel = costToReachPath(myPos, parcelPos);
            if (stepsToParcel == null) continue;

            const delivery = findBestDeliveryPathFrom(parcelPos);
            if (!delivery) continue;
            if (!allowOutOfZone && !_matchesZoneOpportunity(parcelPos, delivery.tile)) continue;

            adjustedScore = pickupValueByPath(parcel, stepsToParcel, delivery.dist);
        }

        if (adjustedScore > bestScore) {
            bestScore = adjustedScore;
            bestIntention = createIntention(
                'go_pick_up',
                parcel.id,
                { x: parcel.x, y: parcel.y },
                adjustedScore
            );
        }
    }

    // Reject only if every candidate parcel would be worthless at delivery.
    if (bestScore === -Infinity || bestScore <= minScore) return null;

    if (bestIntention && log) {
        const parcel = beliefs.parcels.get(bestIntention.parcelId);
        const delivery = parcel ? findBestDeliveryPathFrom({ x: parcel.x, y: parcel.y }) : null;
        const deliveryTile = delivery?.tile ?? null;

        printLog(
            `pickup:${bestIntention.parcelId}`,
            `[deliberation] go_pick_up parcel=${bestIntention.parcelId} ` +
                `score=${bestIntention.score.toFixed(1)} ` +
                `parcelReward=${parcel?.reward ?? '?'} ` +
                `target=(${bestIntention.targetPos.x},${bestIntention.targetPos.y})` +
                (deliveryTile ? ` delivery=(${deliveryTile.x},${deliveryTile.y})` : '')
        );
    }

    return bestIntention;
}

export function findBestLocalPickUp(myPos) {
    return findBestPickUp(myPos, {
        minScore: LOCAL_PICKUP_MIN_SCORE,
        maxDistanceToParcel: LOCAL_PICKUP_MAX_DISTANCE,
        minReward: LOCAL_PICKUP_MIN_REWARD,
    });
}
