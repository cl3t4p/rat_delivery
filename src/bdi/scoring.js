/**
 * scoring.js
 *
 * Central scoring functions for BDI deliberation.
 * All value estimates account for parcel decay during travel.
 *
 * Used by deliberation.js to evaluate pickup, delivery, and detour decisions.
 */

import { beliefs, manhattanDistance } from './beliefs.js';
import { llmMemory } from '../llm/llmAgent.js';

/**
 * Default milliseconds per step, used before dynamic measurement kicks in.
 * Deliveroo agents move at roughly one tile per 500ms.
 */
const DEFAULT_MS_PER_STEP = 500;

/**
 * Estimates how many times a parcel will decay during a journey of `steps` tiles.
 *
 * Uses PARCEL_DECADING_INTERVAL from the server config and MS_PER_STEP
 * (measured dynamically in beliefs.config, falling back to the default).
 *
 * Returns 0 if decay interval is unknown (safe fallback — no decay assumed).
 *
 * @param {number} steps - Number of tiles to travel.
 * @returns {number} Number of decay events during the journey.
 */
export function estimateDecay(steps) {
    const decayInterval = beliefs.config?.PARCEL_DECADING_INTERVAL;
    if (!decayInterval || decayInterval <= 0) return 0;

    const msPerStep = beliefs.config?.MS_PER_STEP ?? DEFAULT_MS_PER_STEP;
    return Math.floor((steps * msPerStep) / decayInterval);
}

/**
 * Estimates the reward a parcel will have when it reaches the delivery tile.
 *
 * Subtracts the expected decay over the full journey (me → parcel → delivery).
 * Returns at least 0 — a parcel cannot have negative reward.
 *
 * @param {number} currentReward - Current reward of the parcel.
 * @param {number} totalSteps - Total steps of the journey (me→parcel + parcel→delivery).
 * @returns {number} Estimated reward at delivery time.
 */
export function estimatedRewardAtDelivery(currentReward, totalSteps) {
    return Math.max(0, currentReward - estimateDecay(totalSteps));
}

/**
 * Computes the net value of picking up a parcel.
 *
 * Accounts for decay over the full journey (me → parcel → delivery)
 * and subtracts the cost of reaching the parcel.
 *
 * Returns -Infinity if the parcel will be worth 0 at delivery time,
 * so it is automatically excluded from the best-pickup search.
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
 * Computes the net value of delivering all currently carried parcels immediately.
 *
 * Estimates the reward of each carried parcel at delivery time,
 * accounting for decay during the walk from myPos to the delivery tile.
 *
 * @param {string[]} carriedIds - IDs of parcels currently being carried.
 * @param {{ x: number, y: number }} myPos - Current agent position.
 * @param {{ x: number, y: number }} deliveryTile - Target delivery tile.
 * @returns {number} Total estimated reward at delivery time.
 */
export function deliveryValue(carriedIds, myPos, deliveryTile) {
    const distToDelivery = manhattanDistance(myPos, deliveryTile);

    const baseValue = carriedIds.reduce((total, id) => {
        const parcel = beliefs.parcels.get(id);
        if (!parcel) return total;
        return total + estimatedRewardAtDelivery(parcel.reward, distToDelivery);
    }, 0);

    return applyDeliveryRewardRules(baseValue, carriedIds.length, deliveryTile);
}

export function applyDeliveryRewardRules(baseValue, stackSize, deliveryTile) {
    if (!Number.isFinite(baseValue) || baseValue <= 0) return baseValue;

    const rules = llmMemory.rewardRules;
    if (!rules) return baseValue;

    if (rules.forbiddenDeliveryTiles?.some((cell) => sameCell(cell, deliveryTile))) {
        return 0;
    }

    if (rules.maxDeliveryReward !== null && baseValue > rules.maxDeliveryReward) {
        return 0;
    }

    let value = baseValue;
    if (rules.stackRule && stackSize === rules.stackRule.exact) {
        value *= rules.stackRule.multiplier;
    }

    const tileMultiplier = deliveryTileMultiplier(deliveryTile);
    if (tileMultiplier !== 1) value *= tileMultiplier;

    return value;
}

export function deliveryTileMultiplier(deliveryTile) {
    const rules = llmMemory.rewardRules;
    if (!rules?.deliveryMultipliers) return 1;

    let multiplier = 1;
    for (const rule of rules.deliveryMultipliers) {
        if (rule.cells?.some((cell) => sameCell(cell, deliveryTile))) {
            multiplier = Math.max(multiplier, rule.multiplier);
        }
    }
    return multiplier;
}

export function isForbiddenDeliveryTile(deliveryTile) {
    return !!llmMemory.rewardRules?.forbiddenDeliveryTiles?.some((cell) => sameCell(cell, deliveryTile));
}

function sameCell(a, b) {
    return a && b && Number(a.x) === Number(b.x) && Number(a.y) === Number(b.y);
}

/**
 * Estimates the net gain of making a detour to pick up an extra parcel
 * before delivering, compared to delivering immediately.
 *
 * A positive return value means the detour is worth it.
 * A negative or zero return value means delivering now is better.
 *
 * @param {{ reward: number, x: number, y: number }} parcel - Candidate parcel to pick up.
 * @param {{ x: number, y: number }} myPos - Current agent position.
 * @param {string[]} carriedIds - IDs of parcels currently being carried.
 * @param {{ x: number, y: number }} deliveryTile - Target delivery tile.
 * @returns {number} Gain from detour minus gain from delivering now.
 */
export function detourValue(parcel, myPos, carriedIds, deliveryTile) {
    // Scenario A: deliver now
    const valueDeliverNow = deliveryValue(carriedIds, myPos, deliveryTile);

    // Scenario B: detour to parcel, then deliver everything
    const stepsToParcel = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    const stepsParcelToDelivery = manhattanDistance(
        { x: parcel.x, y: parcel.y },
        deliveryTile
    );

    // Carried parcels decay during the walk to the new parcel
    const rewardCarriedAfterDetour = carriedIds.reduce((total, id) => {
        const p = beliefs.parcels.get(id);
        if (!p) return total;
        return total + estimatedRewardAtDelivery(p.reward, stepsToParcel + stepsParcelToDelivery);
    }, 0);

    // New parcel decays over the full detour journey
    const rewardNewParcel = estimatedRewardAtDelivery(
        parcel.reward,
        stepsToParcel + stepsParcelToDelivery
    );

    const valueWithDetour = applyDeliveryRewardRules(
        rewardCarriedAfterDetour + rewardNewParcel,
        carriedIds.length + 1,
        deliveryTile
    );

    return valueWithDetour - valueDeliverNow;
}
