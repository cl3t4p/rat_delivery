/**
 * deliberation.js — Person A
 *
 * The agent's decision-making layer: given the Belief Store, chooses what to do.
 *
 */

import { beliefs, manhattanDistance } from './beliefs.js';
import { shouldYieldParcel } from '../multi/coordinator.js';

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

    // Case 3: nothing else to do, so move to the nearest spawner.
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
