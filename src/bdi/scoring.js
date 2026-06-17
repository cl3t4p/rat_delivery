/**
 * scoring.js
 *
 * Value estimates for BDI deliberation.
 */

import { beliefs } from './beliefs.js';
import { manhattanDistance } from './helper.js';

/** Default step duration before runtime measurement is available. */
const DEFAULT_MS_PER_STEP = 500;

/** Cross-agent handoff delivery bonus. */
export const HANDOFF_DELIVERY_BONUS = 200;

/**
 * Estimated decay ticks during a trip.
 *
 * @param {number} steps - Number of tiles to travel.
 * @returns {number}
 */
export function estimateDecay(steps) {
    const decayInterval = beliefs.config?.PARCEL_DECADING_INTERVAL;
    if (!decayInterval || decayInterval <= 0) return 0;

    const msPerStep = beliefs.config?.MS_PER_STEP ?? DEFAULT_MS_PER_STEP;
    return Math.floor((steps * msPerStep) / decayInterval);
}

/**
 * Estimated parcel reward at delivery time.
 *
 * @param {number} currentReward - Current reward of the parcel.
 * @param {number} totalSteps - Total steps of the journey (me-to-parcel plus parcel-to-delivery).
 * @returns {number} Estimated reward at delivery time.
 */
export function estimatedRewardAtDelivery(currentReward, totalSteps) {
    return Math.max(0, currentReward - estimateDecay(totalSteps));
}

/**
 * Pickup value after travel cost and expected decay.
 *
 * @param {{ reward: number, x: number, y: number }} parcel - Parcel to evaluate.
 * @param {{ x: number, y: number }} myPos - Current agent position.
 * @param {{ x: number, y: number }} deliveryTile - Nearest delivery tile from the parcel.
 * @returns {number} Net pickup value.
 */
export function pickupValue(parcel, myPos, deliveryTile) {
    const distToParcel = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    const distToDelivery = manhattanDistance({ x: parcel.x, y: parcel.y }, deliveryTile);
    const totalSteps = distToParcel + distToDelivery;

    const rewardAtDelivery = estimatedRewardAtDelivery(parcel.reward, totalSteps);
    if (rewardAtDelivery <= 0) return -Infinity;

    return rewardAtDelivery - totalSteps;
}

/**
 * Delivery value for the currently carried parcel IDs.
 *
 * @param {string[]} carriedIds - IDs of parcels currently being carried.
 * @param {{ x: number, y: number }} myPos - Current agent position.
 * @param {{ x: number, y: number }} deliveryTile - Target delivery tile.
 * @returns {number} Total estimated reward at delivery time.
 */
export function deliveryValue(carriedIds, myPos, deliveryTile) {
    const distToDelivery = manhattanDistance(myPos, deliveryTile);

    return carriedIds.reduce((total, id) => {
        const parcel = beliefs.parcels.get(id);
        if (!parcel) return total;
        const bonus =
            beliefs.me.handoffBonusActive && beliefs.me.handoffReceivedParcels.has(id)
                ? HANDOFF_DELIVERY_BONUS
                : 0;
        return total + estimatedRewardAtDelivery(parcel.reward, distToDelivery) + bonus;
    }, 0);
}

/**
 * Extra value of picking up one more parcel before delivery.
 *
 * @param {{ reward: number, x: number, y: number }} parcel - Candidate parcel to pick up.
 * @param {{ x: number, y: number }} myPos - Current agent position.
 * @param {string[]} carriedIds - IDs of parcels currently being carried.
 * @param {{ x: number, y: number }} deliveryTile - Target delivery tile.
 * @returns {number} Gain from detour minus gain from delivering now.
 */
export function detourValue(parcel, myPos, carriedIds, deliveryTile) {
    // Deliver now.
    const valueDeliverNow = deliveryValue(carriedIds, myPos, deliveryTile);

    // Detour to parcel, then deliver everything.
    const stepsToParcel = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    const stepsParcelToDelivery = manhattanDistance({ x: parcel.x, y: parcel.y }, deliveryTile);

    // Carried parcels keep decaying during the detour.
    const rewardCarriedAfterDetour = carriedIds.reduce((total, id) => {
        const p = beliefs.parcels.get(id);
        if (!p) return total;
        return total + estimatedRewardAtDelivery(p.reward, stepsToParcel + stepsParcelToDelivery);
    }, 0);

    // The new parcel decays over its own pickup-to-delivery path.
    const rewardNewParcel = estimatedRewardAtDelivery(
        parcel.reward,
        stepsToParcel + stepsParcelToDelivery
    );

    const valueWithDetour = rewardCarriedAfterDetour + rewardNewParcel;

    return valueWithDetour - valueDeliverNow;
}
