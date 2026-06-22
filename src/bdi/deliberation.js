/**
 * deliberation.js
 *
 * Chooses the next BDI intention from the current beliefs.
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
/** @typedef {import('../shard/types.js').ZoneName} ZoneName */

// Slow spawns make fixed camping less useful.
const SLOW_SPAWN_THRESHOLD_MS = Number(process.env.SLOW_SPAWN_MS) || 5000;

// Small dwell time to avoid bouncing between sparse spawners.
const SPAWNER_DWELL_MS = Number(process.env.SPAWNER_DWELL_MS) || 300;

const DETOUR_NEAR_EXTRA_STEPS = 3;
const DETOUR_MAX_EXTRA_STEPS = 8;
const DETOUR_HIGH_EFFECTIVE_GAIN = 10;

const MIN_PICKUP_SCORE =
    process.env.MIN_PICKUP_SCORE === undefined ? -Infinity : Number(process.env.MIN_PICKUP_SCORE);

const LOCAL_PICKUP_MAX_DISTANCE = Number(process.env.LOCAL_PICKUP_MAX_DISTANCE ?? 3);
const LOCAL_PICKUP_MIN_REWARD = Number(process.env.LOCAL_PICKUP_MIN_REWARD ?? 15);
const LOCAL_PICKUP_MIN_SCORE = Number(process.env.LOCAL_PICKUP_MIN_SCORE ?? -25);

let _detourCachePos = { x: null, y: null };
/**
 * Cached detour scores for the current tile.
 *
 * @type {Map<string, {extraSteps: number, effectiveGain: number, accepted: boolean} | null>}
 */
const _detourCache = new Map();

let _lastDelibLog = null;
/**
 * Logs only when the key changes.
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
// Patrol index survives temporary interruptions.
let _roamIndex = null;

export function resetRoamTarget() {
    _roamTarget = null;
    _roamTargetZone = null;
    _roamArrivalTs = 0;
    _roamIndex = null;
}

/**
 * Finds a reachable parking tile near the map half point.
 *
 * @param {Position} me
 * @returns {Position|null}
 */
function halfPointTarget(me) {
    const half = getHalfPoint(beliefs.grid);
    if (isWalkable(half.x, half.y) && costToReachPath(me, half) != null) {
        return half;
    }

    // Snap to the nearest reachable walkable tile.
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
 * Computes the next intention.
 *
 * @returns {Intention}
 */
export function getBestIntention() {
    const me = beliefs.me;
    if (me.x === null || me.y === null) {
        console.log('[deliberation] Position unknown, waiting...');
        return createIntention('wait', null, null, 0);
    }

    const mePos = { x: me.x, y: me.y };

    // Drop carried ids no longer in the store.
    if (me.carrying.length > 0 && !me.carrying.some((id) => beliefs.parcels.has(id))) {
        me.carrying = []; // sensing has not updated this state yet
    }

    // Carrying: deliver, unless a worthwhile pickup detour exists.
    if (me.carrying.length > 0) {
        const capacity = beliefs.config?.MAX_PARCELS ?? 1;

        // Stack rules can delay delivery until the best count is reached.
        let _stackTarget = null;
        if (llmMemory.stackRules.size > 0) {
            _stackTarget = getBestStackTarget(capacity);
            const carrying = me.carrying.length;
            if (_stackTarget !== null && carrying < _stackTarget && carrying < capacity) {
                const pickUp = findBestPickUp(mePos, { log: false });
                if (pickUp) return pickUp;
            }
        }

        // Full capacity means no more detours.
        if (me.carrying.length >= capacity) {
            const target = findBestDeliveryTile(mePos);
            if (target) {
                const stackMult = getStackMultiplier(me.carrying.length);
                const dvScore = deliveryValue(me.carrying, mePos, target) * stackMult;
                printLog(
                    `deliver:${target.x},${target.y}`,
                    `[deliberation] go_deliver (full) to (${target.x},${target.y}) ` +
                        `estimatedReward=${dvScore.toFixed(1)} stackMult=${stackMult}`
                );
                return createIntention('go_deliver', null, target, dvScore);
            }
        }

        const target = findBestDeliveryTile(mePos);

        if (target) {
            // Exact stack targets should not be exceeded.
            const _atStackTarget =
                _stackTarget !== null && me.carrying.length >= _stackTarget;
            const pickUp = _atStackTarget ? null : findBestPickUp(mePos, { log: false });
            if (pickUp) {
                const parcel = beliefs.parcels.get(pickUp.parcelId);
                if (parcel) {
                    // Do not path to an occupied pickup tile.
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
                                mePos,
                                me.carrying,
                                parcelDelivery
                            );
                            const detour = evaluateDetour(
                                mePos,
                                parcel,
                                target,
                                parcelDelivery,
                                gain
                            );

                            if (detour?.accepted) {
                                const deliveryScore = deliveryValue(
                                    me.carrying,
                                    mePos,
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

            const stackMult = getStackMultiplier(me.carrying.length);
            const dvScore = deliveryValue(me.carrying, mePos, target) * stackMult;
            printLog(
                `deliver:${target.x},${target.y}`,
                `[deliberation] go_deliver to (${target.x},${target.y}) ` +
                    `estimatedReward=${dvScore.toFixed(1)} stackMult=${stackMult}`
            );
            return createIntention('go_deliver', null, target, dvScore);
        }

        // Do not pick up more if carried parcels cannot be delivered.
        return createIntention('wait', null, null, 0);
    }

    // Same-tile pickup is always worth checking before scoring.
    const mx = Math.round(mePos.x);
    const my = Math.round(mePos.y);
    const _sameTilePickCap = llmMemory.maxPickupReward;
    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy || parcel.reward <= 0) {
            continue;
        }
        if (_sameTilePickCap != null && parcel.reward > _sameTilePickCap) {
            continue;
        }
        if (Math.round(parcel.x) !== mx || Math.round(parcel.y) !== my) {
            continue;
        }
        if (shouldYieldParcel(parcel.id, mePos)) {
            continue;
        }
        return createIntention(
            'go_pick_up',
            parcel.id,
            { x: parcel.x, y: parcel.y },
            parcel.reward
        );
    }

    let pickUp = findBestPickUp(mePos);
    if (!pickUp && _zoneConstraint) {
        // Empty zone: leave it rather than waiting forever.
        pickUp = findBestPickUp(mePos, { allowOutOfZone: true });
        if (pickUp) {
            printLog(
                `pickup_ooz:${pickUp.parcelId}`,
                `[deliberation] Zone empty — out-of-zone fallback: go_pick_up ${pickUp.parcelId}`
            );
        }
    }
    if (pickUp) return pickUp;

    // No parcel target: explore or patrol spawners.

    _lastDelibLog = null; // reset dedup when entering exploration path
    const genMs = beliefs.config?.PARCEL_GENERATION_INTERVAL ?? null;
    const spawnsAreRare = genMs !== null && genMs >= SLOW_SPAWN_THRESHOLD_MS;
    const allSpawners = findSpawnerTiles();

    // Zone constraints apply to spawners too.

    const preferredSpawners = _zoneConstraint
        ? allSpawners.filter((s) => _isInZone(s))
        : allSpawners;

    if (_zoneConstraint && preferredSpawners.length === 0) {
        resetRoamTarget();
        // No spawner in this half: wait near the relay point.
        const parkSpot = halfPointTarget(mePos);
        if (parkSpot && !sameTile(mePos, parkSpot)) {
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

    // Sparse spawners are patrolled in a stable order.
    if (spawners.length > 1 && (spawnsAreRare || spawnersAreSparse(spawners))) {
        spawners.sort((a, b) => a.x - b.x || a.y - b.y);

        const mx = Math.round(mePos.x);
        const my = Math.round(mePos.y);
        const onIdx = spawners.findIndex((s) => s.x === mx && s.y === my);

        // Drop stale patrol targets.
        if (_roamTarget && _roamTargetZone !== _zoneConstraint) {
            resetRoamTarget();
        }

        if (_roamTarget && !spawners.some((s) => s.x === _roamTarget.x && s.y === _roamTarget.y)) {
            resetRoamTarget();
        }

        // Keep heading to a valid patrol target.
        if (_roamTarget && onIdx === -1 && !sameTile(mePos, _roamTarget)) {
            const result = costToReachPath(mePos, _roamTarget);
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

        if (onIdx !== -1) {
            // Do not walk away from an easy parcel.
            const opportunisticPickUp = findBestLocalPickUp(mePos);
            if (opportunisticPickUp) {
                console.log(
                    `[deliberation] On a sparse spawner but visible parcel is reachable, ` +
                        `go_pick_up ${opportunisticPickUp.parcelId}`
                );
                return opportunisticPickUp;
            }

            // Dwell only on the committed patrol target.
            if (sameTile(mePos, _roamTarget)) {
                const now = Date.now();
                if (!_roamArrivalTs) _roamArrivalTs = now;
                if (now - _roamArrivalTs < SPAWNER_DWELL_MS) {
                    console.log('[deliberation] On a sparse spawner, waiting');
                    return createIntention('wait', null, null, 0);
                }
            }
        }

        // Advance the patrol pointer.
        if (onIdx !== -1) {
            _roamIndex = nextReachableSpawnerIndex(mePos, spawners, onIdx + 1);
        } else if (_roamIndex !== null) {
            _roamIndex = nextReachableSpawnerIndex(mePos, spawners, _roamIndex);
        } else {
            const best = findBestReachable(mePos, spawners);
            _roamIndex = best ? spawners.indexOf(best.tile) : -1;
        }

        const target = _roamIndex === -1 ? null : spawners[_roamIndex];

        // Nothing reachable to patrol.
        if (!target) {
            resetRoamTarget();
            console.log('[deliberation] No reachable in-zone spawner, waiting');
            return createIntention('wait', null, null, 0);
        }

        // Dwell starts once this target is reached.
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

    // Frequent spawns: camp the nearest in-zone spawner.
    const spawner = findBestReachableSpawnerTile(mePos, spawners);
    if (spawner) {
        if (manhattanDistance(mePos, spawner) < 1) {
            const opportunisticPickUp = findBestLocalPickUp(mePos);
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
 * Next reachable spawner in the patrol cycle.
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
 * Scores a pickup detour before delivery.
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

    // Cached paths are tied to the current tile.
    if (_detourCachePos.x !== rx || _detourCachePos.y !== ry) {
        _detourCache.clear();
        _detourCachePos = { x: rx, y: ry };
    }

    // Cache null too: unreachable detours are expensive to rediscover.
    if (_detourCache.has(parcel.id)) {
        return _detourCache.get(parcel.id);
    }

    // Compare direct delivery against me -> parcel -> delivery.
    const direct = costToReachPath(myPos, directDelivery);
    const toParcel = costToReachPath(myPos, { x: parcel.x, y: parcel.y });
    const parcelToDelivery = costToReachPath({ x: parcel.x, y: parcel.y }, parcelDelivery);

    // Any unreachable leg makes the detour impossible.
    if (direct == null || toParcel == null || parcelToDelivery == null) {
        _detourCache.set(parcel.id, null);
        return null;
    }

    // Reward gain after paying the extra distance.
    const directSteps = direct;
    const detourSteps = toParcel + parcelToDelivery;
    const extraSteps = detourSteps - directSteps;
    const effectiveGain = gain - extraSteps;

    // Longer detours need a stronger gain.
    const accepted =
        (extraSteps <= DETOUR_NEAR_EXTRA_STEPS && effectiveGain > 0) ||
        (extraSteps <= DETOUR_MAX_EXTRA_STEPS && effectiveGain >= DETOUR_HIGH_EFFECTIVE_GAIN);

    // Log only on cache misses.
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
