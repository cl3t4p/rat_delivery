/**
 * deliberation.js — Person A
 *
 * The agent's decision-making layer: given the Belief Store, chooses what to do.
 *
 */

import { beliefs, manhattanDistance } from './beliefs.js';
import { shouldYieldParcel } from '../multi/coordinator.js';
import {
    deliveryValue,
    detourValue,
    estimatedRewardAtDelivery,
} from './scoring.js';
import { aStar } from './pathfinding.js';
import { getZone as _sharedGetZone, getMapBounds as _getMapBounds, onBoundsInvalidated } from '../shared/zones.js';

/** @type {Map<string, boolean>} Cache for spawner→delivery reachability (static per map load). */
const _spawnerDeliveryCache = new Map();
onBoundsInvalidated(() => _spawnerDeliveryCache.clear());

// When parcels spawn at least this rarely, camping one spawner is wasteful, so
// we roam between spawn points instead. Compared against the already-parsed
// beliefs.config.PARCEL_GENERATION_INTERVAL (ms, via clockEventToMs). Tunable.
const SLOW_SPAWN_THRESHOLD_MS = Number(process.env.SLOW_SPAWN_MS) || 5000;

// Normalised spawner spread (0 = single tight blob, 1 = across the whole map)
// above which we roam regardless of spawn rate: sparse spawners mean parcels can
// appear far apart, so we patrol them. Below it the spawners are one blob and we
// just camp it. Tunable via SPAWNER_SPARSE_THRESHOLD.
const SPARSE_THRESHOLD = Number(process.env.SPAWNER_SPARSE_THRESHOLD) || 0.25;

// In sparse-spawner maps, stay committed to a patrol target long enough to
// actually observe it before rotating. This prevents oscillation between nearby
// spawners caused by re-scoring the nearest target on every sensing tick.
const SPAWNER_DWELL_MS = Number(process.env.SPAWNER_DWELL_MS) || 1500;

// ── Zone constraint ──────────────────────────────────────────────────────────
// Set by intentionRevision when a ZONE_ASSIGN message is accepted.
// Persists across deliberation cycles so the agent stays in its zone even
// after the one-shot go_to waypoint has been consumed.

/** @type {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'|null} */
let _zoneConstraint = null;

/**
 * Persists the zone the agent should prefer for roaming and pickup.
 * Pass null to restore full-map behaviour (no zone preference).
 *
 * @param {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'|null} zoneName
 */
export function setZoneConstraint(zoneName) {
    if (_zoneConstraint !== zoneName) resetRoamTarget();
    _zoneConstraint = zoneName;
    if (zoneName) console.log(`[deliberation] Zone constraint set: ${zoneName}`);
}

/** @returns {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'|null} */
export function getZoneConstraint() {
    return _zoneConstraint;
}

/** True if pos is inside the assigned zone, or no zone constraint is active. */
function _isInZone(pos) {
    return !_zoneConstraint || _sharedGetZone(pos, beliefs.grid) === _zoneConstraint;
}

function _matchesZoneOpportunity(parcelPos, deliveryTile) {
    if (!_zoneConstraint) return true;
    return _isInZone(parcelPos) || (deliveryTile && _isInZone(deliveryTile));
}

const DETOUR_NEAR_EXTRA_STEPS = 3;
const DETOUR_MAX_EXTRA_STEPS = 8;
const DETOUR_HIGH_EFFECTIVE_GAIN = 10;
const MIN_PICKUP_SCORE =
    process.env.MIN_PICKUP_SCORE === undefined
        ? -Infinity
        : Number(process.env.MIN_PICKUP_SCORE);
const LOCAL_PICKUP_MAX_DISTANCE = Number(process.env.LOCAL_PICKUP_MAX_DISTANCE ?? 3);
const LOCAL_PICKUP_MIN_REWARD = Number(process.env.LOCAL_PICKUP_MIN_REWARD ?? 15);
const LOCAL_PICKUP_MIN_SCORE = Number(process.env.LOCAL_PICKUP_MIN_SCORE ?? -25);

// Cache for detour evaluations: invalidated whenever the agent moves to a new tile.
// Eliminates redundant A* triples and "Detour rejected" log spam on every sensing tick.
let _detourCachePos = { x: null, y: null };
const _detourCache = new Map(); // parcelId → result | null

// Deliberation deduplication: suppress identical consecutive decisions so the
// log only shows meaningful changes, not the same choice repeated every tick.
let _lastDelibLog = null;

/** @type {Position|null} */
let _roamTarget = null;
let _roamTargetZone = null;
let _roamArrivalTs = 0;

function sameTile(a, b) {
    return !!a && !!b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

export function resetRoamTarget() {
    _roamTarget = null;
    _roamTargetZone = null;
    _roamArrivalTs = 0;
}

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */
/** @typedef {import('../shared/types.js').IntentionType} IntentionType */

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

    // Case 1: carrying parcels, so consider delivery.
    if (beliefs.me.carrying.length > 0) {
        // Check that carried parcels still exist in the beliefs.
        const realCarrying = beliefs.me.carrying.filter((id) => beliefs.parcels.has(id));
        if (realCarrying.length === 0) {
            beliefs.me.carrying = []; // Cleanup: sensing has not updated this state yet.
        } else {
            // Maximum number of parcels the agent can carry.
            const capacity = beliefs.config?.MAX_PARCELS ?? 1;

            // If at full capacity, deliver immediately.
            if (beliefs.me.carrying.length >= capacity) {
                const target = findBestDeliveryTile(me);
                if (target) {
                    const dvScore = deliveryValue(beliefs.me.carrying, me, target);
                    const key = `deliver:${target.x},${target.y}`;
                    if (_lastDelibLog !== key) {
                        _lastDelibLog = key;
                        console.log(
                            `[deliberation] go_deliver (full) to (${target.x},${target.y}) ` +
                            `estimatedReward=${dvScore.toFixed(1)}`
                        );
                    }
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
                        const parcelDelivery = findNearestDeliveryTile({ x: parcel.x, y: parcel.y });
                        if (parcelDelivery) {
                            const gain = detourValue(parcel, me, beliefs.me.carrying, parcelDelivery);
                            const detour = evaluateDetour(me, parcel, target, parcelDelivery, gain);

                            if (detour?.accepted) {
                                const deliveryScore = deliveryValue(beliefs.me.carrying, me, target);
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

                const dvScore = deliveryValue(beliefs.me.carrying, me, target);
                const key = `deliver:${target.x},${target.y}`;
                if (_lastDelibLog !== key) {
                    _lastDelibLog = key;
                    console.log(
                        `[deliberation] go_deliver to (${target.x},${target.y}) ` +
                        `estimatedReward=${dvScore.toFixed(1)}`
                    );
                }
                return createIntention('go_deliver', null, target, dvScore);
            }
        }

        // Carrying but no delivery tile is reachable — wait rather than falling
        // through to findBestPickUp, which would try to grab more parcels while
        // holding items we cannot drop.
        return createIntention('wait', null, null, 0);
    }

    // Case 2: free parcels are available, so pick one up.
    let pickUp = findBestPickUp(me);
    if (!pickUp && _zoneConstraint) {
        // Zone is empty — fall back to unclaimed parcels outside the zone rather
        // than waiting indefinitely at a spawner that isn't producing anything.
        // shouldYieldParcel still filters parcels already claimed by the peer.
        pickUp = findBestPickUp(me, { allowOutOfZone: true });
        if (pickUp) {
            const key = `pickup_ooz:${pickUp.parcelId}`;
            if (_lastDelibLog !== key) {
                _lastDelibLog = key;
                console.log(
                    `[deliberation] Zone empty — out-of-zone fallback: go_pick_up ${pickUp.parcelId}`
                );
            }
        }
    }
    if (pickUp) return pickUp;

    // Case 3: nothing else to do, so head for the spawners.
    _lastDelibLog = null; // reset dedup when entering exploration path
    const genMs = beliefs.config?.PARCEL_GENERATION_INTERVAL ?? null;
    const spawnsAreRare = genMs !== null && genMs >= SLOW_SPAWN_THRESHOLD_MS;
    const allSpawners = findSpawnerTiles().filter(spawnerCanReachDelivery);

    // Respect zone constraint: use only in-zone spawners. Falling back to all
    // spawners makes an assigned zone meaningless and can send the agent into
    // its peer's area. If the zone has no spawner, stay in-zone and wait for a
    // rebalance or visible parcel instead.
    const preferredSpawners = _zoneConstraint
        ? allSpawners.filter((s) => _isInZone(s))
        : allSpawners;
    const spawners = preferredSpawners;

    if (_zoneConstraint && spawners.length === 0) {
        resetRoamTarget();
        console.log(`[deliberation] No spawner in assigned zone ${_zoneConstraint} → wait`);
        return createIntention('wait', null, null, 0);
    }

    // Roam when spawners are scattered beyond what the agent can watch from one
    // spot (parcels can appear out of sight) even if the spawn rate is fine; a
    // single blob that fits in the view range is worth camping instead.
    const sparse = spawnersAreSparse(spawners);

    if (spawners.length > 1 && (spawnsAreRare || sparse)) {
        // Don't camp one tile: roam between spawn points.
        // Standing on a spawner → move to the next one (round-robin over a stable
        // order); otherwise go to the nearest to start the rotation. go_to is used
        // so arrival completes the intention and the next spawner is picked.
        spawners.sort((a, b) => a.x - b.x || a.y - b.y);

        const mx = Math.round(me.x);
        const my = Math.round(me.y);
        const onIdx = spawners.findIndex((s) => s.x === mx && s.y === my);

        if (_roamTarget && _roamTargetZone !== _zoneConstraint) {
            resetRoamTarget();
        }

        if (_roamTarget && !spawners.some((s) => s.x === _roamTarget.x && s.y === _roamTarget.y)) {
            resetRoamTarget();
        }

        if (_roamTarget && onIdx === -1 && !sameTile(me, _roamTarget)) {
            const result = aStar(me, _roamTarget, { avoidAgents: false });
            if (result) {
                const reason = spawnsAreRare
                    ? `spawns rare (${genMs}ms)`
                    : 'spawners spread beyond view range';
                console.log(
                    `[deliberation] ${reason} → continue to spawner ` +
                    `(${_roamTarget.x},${_roamTarget.y})`
                );
                return createIntention('go_to', null, _roamTarget, 0);
            }
            resetRoamTarget();
        }

        if (onIdx !== -1) {
            const opportunisticPickUp = findBestLocalPickUp(me);
            if (opportunisticPickUp) {
                console.log(
                    `[deliberation] On a sparse spawner but visible parcel is reachable → ` +
                    `go_pick_up ${opportunisticPickUp.parcelId}`
                );
                return opportunisticPickUp;
            }

            const now = Date.now();
            if (!_roamArrivalTs || !sameTile(me, _roamTarget)) {
                _roamArrivalTs = now;
                _roamTarget = spawners[onIdx];
                _roamTargetZone = _zoneConstraint;
            }
            if (now - _roamArrivalTs < SPAWNER_DWELL_MS) {
                console.log('[deliberation] On a sparse spawner → wait');
                return createIntention('wait', null, null, 0);
            }
        }

        let target;
        if (onIdx !== -1) {
            const rotated = [
                ...spawners.slice(onIdx + 1),
                ...spawners.slice(0, onIdx),
            ];
            target = findFirstReachableSpawnerTile(me, rotated);
        } else {
            target = findBestReachableSpawnerTile(me, spawners);
        }

        if (!target) {
            resetRoamTarget();
            console.log('[deliberation] No reachable in-zone spawner → wait');
            return createIntention('wait', null, null, 0);
        }
        _roamTarget = target;
        _roamTargetZone = _zoneConstraint;
        _roamArrivalTs = 0;
        const reason = spawnsAreRare
            ? `spawns rare (${genMs}ms)`
            : 'spawners spread beyond view range';
        console.log(
            `[deliberation] ${reason} → roam to spawner (${target.x},${target.y})`
        );
        return createIntention('go_to', null, target, 0);
    }

    // Frequent spawns (or a single spawner): camp the nearest in-zone one,
    // without falling back to another zone.
    const spawner = findBestReachableSpawnerTile(me, spawners);
    if (spawner) {
        // Use < 1 instead of === 0 to treat mid-step positions (e.g. y=18.6 near
        // spawner at y=19) as "on the spawner", preventing a spurious explore
        // intention that would immediately complete and cause oscillation.
        if (manhattanDistance(me, spawner) < 1) {
            const opportunisticPickUp = findBestLocalPickUp(me);
            if (opportunisticPickUp) {
                console.log(
                    `[deliberation] On a spawner but visible parcel is reachable → ` +
                    `go_pick_up ${opportunisticPickUp.parcelId}`
                );
                return opportunisticPickUp;
            }
            console.log('[deliberation] On a spawner → wait');
            return createIntention('wait', null, null, 0);
        }
        console.log(`[deliberation] Heading to spawner (${spawner.x},${spawner.y})`);
        return createIntention('explore', null, spawner, 0);
    }

    return createIntention('wait', null, null, 0);
}

// Helper function

/**
 * Finds the delivery tile nearest to the current position.
 *
 * @param {Position} myPos - Current position.
 * @returns {Position|null}
 */
export function findNearestDeliveryTile(myPos) {
    if (beliefs.deliveryTiles.length === 0) return null;

    let nearest = null;
    let nearestDist = Infinity;

    for (const tile of beliefs.deliveryTiles) {
        const dist = manhattanDistance(myPos, tile);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = tile;
        }
    }

    return nearest;
}

/**
 * Finds the reachable delivery tile with the shortest real path.
 *
 * Falls back to Manhattan nearest if A* cannot find any reachable delivery.
 *
 * @param {Position} myPos - Current or candidate position.
 * @returns {Position|null}
 */
export function findBestDeliveryTile(myPos) {
    if (beliefs.deliveryTiles.length === 0) return null;

    const bestFree = findBestDeliveryTileMatching(myPos, (tile) => !isDeliveryOccupied(tile));
    if (bestFree) return bestFree;

    const bestAny = findBestDeliveryTileMatching(myPos, () => true);
    if (bestAny) return bestAny;

    return findNearestDeliveryTile(myPos);
}

function findBestDeliveryTileMatching(myPos, predicate) {
    let best = null;
    let bestLen = Infinity;

    for (const tile of beliefs.deliveryTiles) {
        if (!predicate(tile)) continue;
        const result = aStar(myPos, tile, { avoidAgents: false });
        if (!result) continue;

        if (result.moves.length < bestLen) {
            bestLen = result.moves.length;
            best = tile;
        }
    }

    return best;
}

function isDeliveryOccupied(tile) {
    return [...beliefs.agents.values()].some((agent) =>
        !agent.stale &&
        agent.id !== beliefs.me.id &&
        Math.round(agent.x) === tile.x &&
        Math.round(agent.y) === tile.y
    );
}

function pickupValueByPath(parcel, pathToParcel, pathToDelivery) {
    const totalSteps = pathToParcel.moves.length + pathToDelivery.moves.length;
    const rewardAtDelivery = estimatedRewardAtDelivery(parcel.reward, totalSteps);

    if (rewardAtDelivery <= 0) return -Infinity;

    return rewardAtDelivery - totalSteps;
}

function findBestDeliveryPathFrom(pos) {
    const bestFree = findBestDeliveryPathMatching(pos, (tile) => !isDeliveryOccupied(tile));
    if (bestFree) return bestFree;

    return findBestDeliveryPathMatching(pos, () => true);
}

function findBestDeliveryPathMatching(pos, predicate) {
    let best = null;
    let bestLen = Infinity;

    for (const tile of beliefs.deliveryTiles) {
        if (!predicate(tile)) continue;
        const result = aStar(pos, tile, { avoidAgents: false });
        if (!result) continue;

        if (result.moves.length < bestLen) {
            bestLen = result.moves.length;
            best = { tile, path: result };
        }
    }

    return best;
}

function evaluateDetour(myPos, parcel, directDelivery, parcelDelivery, gain) {
    const rx = Math.round(myPos.x);
    const ry = Math.round(myPos.y);

    // Clear cache whenever the agent steps to a new tile.
    if (_detourCachePos.x !== rx || _detourCachePos.y !== ry) {
        _detourCache.clear();
        _detourCachePos = { x: rx, y: ry };
    }

    if (_detourCache.has(parcel.id)) {
        return _detourCache.get(parcel.id);
    }

    const direct = aStar(myPos, directDelivery, { avoidAgents: false });
    const toParcel = aStar(myPos, { x: parcel.x, y: parcel.y }, { avoidAgents: false });
    const parcelToDelivery = aStar(
        { x: parcel.x, y: parcel.y },
        parcelDelivery,
        { avoidAgents: false }
    );

    if (!direct || !toParcel || !parcelToDelivery) {
        _detourCache.set(parcel.id, null);
        return null;
    }

    const directSteps = direct.moves.length;
    const detourSteps = toParcel.moves.length + parcelToDelivery.moves.length;
    const extraSteps = detourSteps - directSteps;
    const effectiveGain = gain - extraSteps;
    const accepted =
        (extraSteps <= DETOUR_NEAR_EXTRA_STEPS && effectiveGain > 0) ||
        (extraSteps <= DETOUR_MAX_EXTRA_STEPS && effectiveGain >= DETOUR_HIGH_EFFECTIVE_GAIN);

    // Log only on first evaluation at this tile (cache miss) and only when the
    // rejection is non-obvious: once extraSteps is way beyond the hard cap the
    // parcel is clearly unreachable on a detour, and logging it every step
    // produces hundreds of identical lines (e.g. delivering while a parcel sits
    // on the opposite side of the map).
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
        if (shouldYieldParcel(parcel.id, myPos)) continue; // Peer claimed it and is closer.

        const parcelPos = { x: parcel.x, y: parcel.y };
        if (manhattanDistance(myPos, parcelPos) > maxDistanceToParcel) continue;

        const pathToParcel = aStar(myPos, parcelPos, { avoidAgents: false });
        if (!pathToParcel) continue;

        const delivery = findBestDeliveryPathFrom(parcelPos);
        if (!delivery) continue;
        if (!allowOutOfZone && !_matchesZoneOpportunity(parcelPos, delivery.tile)) continue;

        const score = pickupValueByPath(parcel, pathToParcel, delivery.path);
        const adjustedScore = score;

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
    // A finite negative score means the trip is long but the parcel still
    // delivers some value — better to pick it up than to idle.
    if (bestScore === -Infinity || bestScore <= minScore) return null;

    if (bestIntention && log) {
        const parcel = beliefs.parcels.get(bestIntention.parcelId);
        const delivery = parcel
            ? findBestDeliveryPathFrom({ x: parcel.x, y: parcel.y })
            : null;
        const deliveryTile = delivery?.tile ?? null;

        const key = `pickup:${bestIntention.parcelId}`;
        if (_lastDelibLog !== key) {
            _lastDelibLog = key;
            console.log(
                `[deliberation] go_pick_up parcel=${bestIntention.parcelId} ` +
                `score=${bestIntention.score.toFixed(1)} ` +
                `parcelReward=${parcel?.reward ?? '?'} ` +
                `target=(${bestIntention.targetPos.x},${bestIntention.targetPos.y})` +
                (deliveryTile ? ` delivery=(${deliveryTile.x},${deliveryTile.y})` : '')
            );
        }
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

/**
 * Finds the reachable spawner with the shortest real path.
 *
 * @param {Position} myPos
 * @param {Position[]} [spawners]
 * @returns {Position|null}
 */
export function findBestReachableSpawnerTile(myPos, spawners = findSpawnerTiles()) {
    let best = null;
    let bestLen = Infinity;

    for (const spawner of spawners) {
        const result = aStar(myPos, spawner, { avoidAgents: false });
        if (!result) continue;

        if (result.moves.length < bestLen) {
            best = spawner;
            bestLen = result.moves.length;
        }
    }

    return best;
}

function findFirstReachableSpawnerTile(myPos, spawners) {
    for (const spawner of spawners) {
        const result = aStar(myPos, spawner, { avoidAgents: false });
        if (result) return spawner;
    }

    return null;
}

/**
 * Returns every spawner tile on the known map.
 *
 * @returns {Position[]}
 */
export function findSpawnerTiles() {
    const out = [];
    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        out.push({ x, y });
    }
    return out;
}

function spawnerCanReachDelivery(spawner) {
    // A spawner that cannot reach any delivery tile creates parcels the agent
    // cannot score. Do not camp or patrol these pockets.
    if (beliefs.deliveryTiles.length === 0) return false;
    const key = `${spawner.x},${spawner.y}`;
    if (_spawnerDeliveryCache.has(key)) return _spawnerDeliveryCache.get(key);
    const result = beliefs.deliveryTiles.some((delivery) =>
        aStar(spawner, delivery, { avoidAgents: false })
    );
    _spawnerDeliveryCache.set(key, result);
    return result;
}

/**
 * Measures how spread out the spawner tiles are, normalised to [0, 1].
 *
 * 0 means every spawner sits on (essentially) one tile — a single blob;
 * values near 1 mean they are scattered across the whole map. Computed as the
 * mean distance of spawners from their centroid, divided by the map's
 * half-extent so it is comparable across map sizes.
 *
 * @param {Position[]} [spawners] - Precomputed spawners (defaults to all).
 * @returns {number}
 */
export function spawnerSparseness(spawners = findSpawnerTiles()) {
    if (spawners.length < 2) return 0;

    const cx = spawners.reduce((s, p) => s + p.x, 0) / spawners.length;
    const cy = spawners.reduce((s, p) => s + p.y, 0) / spawners.length;
    const meanRadius =
        spawners.reduce((s, p) => s + Math.abs(p.x - cx) + Math.abs(p.y - cy), 0) /
        spawners.length;

    const { maxX, maxY } = _getMapBounds(beliefs.grid);
    const halfExtent = (maxX + maxY) / 2 || 1;
    return Math.min(1, meanRadius / halfExtent);
}

/**
 * Decides whether the spawners are spread out enough to warrant roaming rather
 * than camping, taking the agent's view range into account.
 *
 * With a finite view range the key question is visibility: if a single vantage
 * point can't keep every spawner in sight (cluster radius > view range) the
 * agent must patrol them. With unlimited vision (OBSERVATION_DISTANCE < 0 or
 * unset) visibility never forces roaming, so we fall back to the normalised
 * geometric spread.
 *
 * @param {Position[]} [spawners] - Precomputed spawners (defaults to all).
 * @returns {boolean}
 */
export function spawnersAreSparse(spawners = findSpawnerTiles()) {
    if (spawners.length < 2) return false;

    const view = beliefs.config?.OBSERVATION_DISTANCE ?? null;

    const cx = spawners.reduce((s, p) => s + p.x, 0) / spawners.length;
    const cy = spawners.reduce((s, p) => s + p.y, 0) / spawners.length;
    // Cluster radius: farthest spawner from the centroid.
    const radius = Math.max(
        ...spawners.map((p) => Math.abs(p.x - cx) + Math.abs(p.y - cy))
    );

    if (view !== null && view > 0) {
        // Finite vision: sparse if one vantage point can't watch them all.
        return radius > view;
    }
    // Unlimited vision: fall back to normalized geometric spread.
    return spawnerSparseness(spawners) >= SPARSE_THRESHOLD;
}

/**
 * Finds the spawner tile nearest to the current position.
 *
 * @param {Position} myPos - Current position.
 * @returns {Position|null}
 */
export function findNearestSpawnerTile(myPos) {
    let nearest = null;
    let nearestDist = Infinity;

    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        const dist = manhattanDistance(myPos, { x, y });
        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = { x, y };
        }
    }
    return nearest;
}
