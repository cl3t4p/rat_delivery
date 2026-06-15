/**
 * policyAgent.js
 *
 * Deprecated policy-codegen strategy.
 *
 * Earlier versions asked the LLM to write JavaScript policy code at runtime.
 * That path is intentionally disabled: generated code is not executed in this
 * process. The exported entry point remains for compatibility and always falls
 * back to the deterministic heuristic.
 */

import {
    beliefs,
    manhattanDistance,
    isWalkable,
    blacklistCell,
    unblacklistCell,
    isBlacklisted,
    clearBlacklist,
} from '../bdi/beliefs.js';
import {
    createIntention,
    findNearestDeliveryTile,
    findBestDeliveryTile,
    findNearestSpawnerTile,
    getBestIntention,
} from '../bdi/deliberation.js';
import { llmMemory } from './llmAgent.js';
import { buildStateSnapshot } from './intentionAgent.js';
import {
    pickupValue,
    deliveryValue,
} from '../bdi/scoring.js';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */

const VALID_TYPES = new Set(['go_pick_up', 'go_deliver', 'explore', 'go_to', 'wait']);

let warnedDisabled = false;

const SYSTEM_PROMPT = `
You write the decision logic for a Deliveroo.js BDI agent.

Produce the BODY of a JavaScript function with this exact signature:

    function chooseIntention(state, actions) { /* your code — body only */ }

You MUST end every path by \`return\`ing exactly one intention, obtained by
calling one of the builders in \`actions\`. Never build intentions yourself.

state (read-only) shape:
{
  me: { x, y, carrying /* number held */, carryingIds: string[] },
  freeParcels: [ { id, x, y, reward, distanceToParcel, distanceToDelivery, estimatedRewardAtDelivery, score } ],
  deliveryTiles: [ { x, y } ],
  otherAgents: [ { x, y } ],
  blacklist: [ { x, y } ]   // cells currently marked impassable (avoided by movement)
  world: { parcelGenerationMs /* ms between spawns, may be null */, maxCarry }
}

actions API (each returns an intention, or null when not applicable):
  actions.goPickUp(parcelId) -> intention | null   // parcelId from state.freeParcels[].id
  actions.goDeliver()        -> intention | null   // only if carrying > 0
  actions.explore()          -> intention          // head to nearest spawner
  actions.goTo(x, y)         -> intention | null    // walk to a walkable cell, no pickup/deliver
  actions.wait()             -> intention          // last resort
  actions.manhattanDistance(a, b) -> number
  actions.blacklist(x, y)                          // mark a cell impassable; pathfinding,
                                                   //   go_to and the executor route around it
  actions.unblacklist(x, y)                        // remove a cell from the blacklist
  actions.isBlacklisted(x, y) -> boolean
  actions.clearBlacklist()                         // clear all blacklisted cells

Decision guidance:
- Each parcel in state.freeParcels has a score = estimatedRewardAtDelivery - total route distance.
- Pick the parcel with the highest score. Never pick a parcel with score <= 0.
- If carrying, prefer goDeliver unless a detour clearly improves total estimated value.
- Do not pick parcels that will be worthless (estimatedRewardAtDelivery = 0) at delivery.
- Never pick up when me.carrying >= world.maxCarry.
- If world.parcelGenerationMs is large (>= 5000) and nothing good is nearby,
  prefer goTo a far / less-crowded region instead of camping the nearest spawner.
- If a builder returns null, try another option; always return a valid intention
  (worst case actions.wait()).
- Use actions.blacklist(x, y) to avoid cells that are problematic (e.g. occupied
  by another agent, a tile you keep getting stuck on, or a contested chokepoint);
  movement will route around blacklisted cells. unblacklist / clearBlacklist when
  they are no longer a problem.

Hard rules for the code you output:
- Output ONLY the JavaScript statements of the body. No markdown fences, no
  function signature, no prose.
- Do NOT use: import, require, fetch, eval, Function, setTimeout, setInterval,
  unbounded while loops, or any I/O.
- Keep it synchronous and pure; it runs every tick.`.trim();

/**
 * Builds the `actions` object handed to the generated policy. Each builder
 * returns a real Intention (via the shared deliberation helpers) or null.
 *
 * @param {Position} me
 * @returns {object}
 */
function buildActions(me) {
    return {
        goPickUp(parcelId) {
            const p = parcelId ? beliefs.parcels.get(parcelId) : null;
            if (!p || p.carriedBy || p.reward <= 0) return null;
            if (beliefs.me.carrying.length >= (beliefs.config?.MAX_PARCELS ?? 1)) return null;
            const deliveryTile = findNearestDeliveryTile({ x: p.x, y: p.y });
            if (!deliveryTile) return null;
            const score = pickupValue(p, me, deliveryTile);
            if (score <= 0) return null;
            return createIntention('go_pick_up', p.id, { x: p.x, y: p.y }, score);
        },
        goDeliver() {
            if (beliefs.me.carrying.length === 0) return null;
            const target = findBestDeliveryTile(me);
            if (!target) return null;
            const score = deliveryValue(beliefs.me.carrying, me, target);
            return createIntention('go_deliver', null, target, score);
        },
        explore() {
            const spawner = findNearestSpawnerTile(me);
            if (!spawner || manhattanDistance(me, spawner) === 0) {
                return createIntention('wait', null, null, 0);
            }
            return createIntention('explore', null, spawner, 0);
        },
        goTo(x, y) {
            x = Number(x);
            y = Number(y);
            if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
            if (!isWalkable(x, y)) return null;
            if (manhattanDistance(me, { x, y }) === 0) return null;
            return createIntention('go_to', null, { x, y }, 0);
        },
        wait() {
            return createIntention('wait', null, null, 0);
        },
        manhattanDistance,
        // Blacklist control: blacklisted cells become impassable for pathfinding,
        // go_to and the executor until removed.
        blacklist: (x, y) => blacklistCell(Number(x), Number(y)),
        unblacklist: (x, y) => unblacklistCell(Number(x), Number(y)),
        isBlacklisted: (x, y) => isBlacklisted(Number(x), Number(y)),
        clearBlacklist,
    };
}

/** @param {*} i @returns {boolean} */
function isValidIntention(i) {
    return !!i && typeof i === 'object' && typeof i.type === 'string' && VALID_TYPES.has(i.type);
}

/**
 * Strips markdown fences and surrounding prose from a model reply, leaving the
 * raw function body.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractBody(raw) {
    const fenced = /```(?:js|javascript)?\s*([\s\S]*?)```/i.exec(raw);
    return (fenced ? fenced[1] : raw).trim();
}

/**
 * Code generation is disabled. This function exists only to keep old imports
 * from failing loudly with a clear reason.
 *
 * @param {Position} me
 * @returns {Promise<void>}
 */
async function generatePolicy(_me) {
    throw new Error('LLM code generation is disabled');
}

/**
 * Compatibility entry point for the disabled codegen mode.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntentionFromPolicy() {
    if (!warnedDisabled) {
        warnedDisabled = true;
        console.log('[policyAgent] LLM codegen disabled; using heuristic fallback');
    }
    void generatePolicy;
    void llmMemory;
    return getBestIntention();
}

/** Forces the policy to be regenerated on the next deliberation. */
export function invalidatePolicy() {
    // Code generation is disabled; nothing to invalidate.
}
