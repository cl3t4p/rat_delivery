/**
 * deliberation.js — Person A
 *
 * The agent's decision-making layer: given the Belief Store, chooses what to do.
 *
 */

import { beliefs, manhattanDistance } from './beliefs.js';
import { shouldYieldParcel } from '../multi/coordinator.js';

// When parcels spawn at least this rarely, camping one spawner is wasteful, so
// we roam between spawn points instead. Compared against the already-parsed
// beliefs.config.PARCEL_GENERATION_INTERVAL (ms, via clockEventToMs). Tunable.
const SLOW_SPAWN_THRESHOLD_MS = Number(process.env.SLOW_SPAWN_MS) || 5000;

// Normalised spawner spread (0 = single tight blob, 1 = across the whole map)
// above which we roam regardless of spawn rate: sparse spawners mean parcels can
// appear far apart, so we patrol them. Below it the spawners are one blob and we
// just camp it. Tunable via SPAWNER_SPARSE_THRESHOLD.
const SPARSE_THRESHOLD = Number(process.env.SPAWNER_SPARSE_THRESHOLD) || 0.25;

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
                const target = findNearestDeliveryTile(me);
                if (target) {
                    const dist = manhattanDistance(me, target);
                    const totalReward = beliefs.me.carrying
                        .map((id) => beliefs.parcels.get(id)?.reward ?? 0)
                        .reduce((a, b) => a + b, 0);
                    console.log(`[deliberation] go_deliver (full) to (${target.x},${target.y})`);
                    return createIntention('go_deliver', null, target, totalReward - dist);
                }
            }

            // If not at full capacity, check whether a nearby free parcel is worth picking up.
            const pickUp = findBestPickUp(me);
            if (pickUp && pickUp.score > 0) {
                return pickUp;
            }

            // No convenient parcel found, so deliver the currently carried parcels.
            const target = findNearestDeliveryTile(me);
            if (target) {
                const dist = manhattanDistance(me, target);
                const totalReward = beliefs.me.carrying
                    .map((id) => beliefs.parcels.get(id)?.reward ?? 0)
                    .reduce((a, b) => a + b, 0);
                console.log(`[deliberation] go_deliver to (${target.x},${target.y})`);
                return createIntention('go_deliver', null, target, totalReward - dist);
            }
        }
    }

    // Case 2: free parcels are available, so pick one up.
    const pickUp = findBestPickUp(me);
    if (pickUp) return pickUp;

    // Case 3: nothing else to do, so head for the spawners.
    const genMs = beliefs.config?.PARCEL_GENERATION_INTERVAL ?? null;
    const spawnsAreRare = genMs !== null && genMs >= SLOW_SPAWN_THRESHOLD_MS;
    const spawners = findSpawnerTiles();
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
        const onIdx = spawners.findIndex((s) => s.x === me.x && s.y === me.y);
        let target;
        if (onIdx !== -1) {
            target = spawners[(onIdx + 1) % spawners.length];
        } else {
            target = spawners.reduce((best, s) =>
                manhattanDistance(me, s) < manhattanDistance(me, best) ? s : best
            );
        }
        const reason = spawnsAreRare
            ? `spawns rare (${genMs}ms)`
            : 'spawners spread beyond view range';
        console.log(
            `[deliberation] ${reason} → roam to spawner (${target.x},${target.y})`
        );
        return createIntention('go_to', null, target, 0);
    }

    // Frequent spawns (or a single spawner): camp the nearest one.
    const spawner = findNearestSpawnerTile(me);
    if (spawner) {
        if (manhattanDistance(me, spawner) === 0) {
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
 * Finds the free parcel with the highest utility score.
 *
 * @param {Position} myPos - Current position.
 * @returns {Intention|null}
 */
export function findBestPickUp(myPos) {
    let bestScore = -Infinity;
    let bestIntention = null;

    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy) continue; // Skip parcels that have already been picked up by another agent.
        if (parcel.reward <= 0) continue; // Skip parcels with no remaining reward.
        if (shouldYieldParcel(parcel.id, myPos)) continue; // Peer claimed it and is closer.

        const dist = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
        const score = parcel.reward - dist;

        if (score > bestScore) {
            bestScore = score;
            bestIntention = createIntention(
                'go_pick_up',
                parcel.id,
                { x: parcel.x, y: parcel.y },
                score
            );
        }
    }

    if (bestIntention) {
        console.log(
            `[deliberation] go_pick_up parcel=${bestIntention.parcelId} score=${bestIntention.score.toFixed(1)}`
        );
    }

    return bestIntention;
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

    let maxX = 0;
    let maxY = 0;
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
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
