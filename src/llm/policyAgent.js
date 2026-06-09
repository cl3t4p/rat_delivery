/**
 * policyAgent.js
 *
 * "LLM writes the deliberation code" strategy.
 *
 * Instead of the LLM picking one tool per tick (see intentionAgent.js), here
 * the LLM *writes the body* of a `chooseIntention(state, actions)` function.
 * We compile that body once, cache the compiled function, and call it on every
 * deliberation tick — so the slow model call happens once, not every step.
 *
 * The generated code may freely compose ALL of the action builders (branch,
 * loop, score, etc.); it just has to `return` exactly one intention produced by
 * an `actions.*` call. That keeps the output always-valid even though the body
 * is arbitrary LLM-written JavaScript.
 *
 * SECURITY NOTE: the body is run via `new Function`, i.e. arbitrary code
 * execution in this process. This is acceptable for a sandboxed university
 * project but should NOT be exposed to untrusted input. The prompt forbids
 * I/O / imports and "use strict" is applied, but this is not a real sandbox.
 *
 * The function is regenerated when the operator objective changes, and on any
 * compile/runtime failure we fall back to the deterministic heuristic.
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
    findNearestSpawnerTile,
    getBestIntention,
} from '../bdi/deliberation.js';
import { llmClient, llmMemory } from './llmAgent.js';
import { buildStateSnapshot } from './intentionAgent.js';

const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */

const VALID_TYPES = new Set(['go_pick_up', 'go_deliver', 'explore', 'go_to', 'wait']);

// Compiled-policy cache.
/** @type {((state: object, actions: object) => Intention) | null} */
let cachedFn = null;
// The objective the cached function was generated for ('∅' when none), used to
// detect when we must regenerate.
let cachedKey = null;
// In-flight generation promise, so concurrent callers (pre-generation on
// connect + the first deliberation) share one LLM round-trip.
let generating = null;

const SYSTEM_PROMPT = `
You write the decision logic for a Deliveroo.js BDI agent.

Produce the BODY of a JavaScript function with this exact signature:

    function chooseIntention(state, actions) { /* your code — body only */ }

You MUST end every path by \`return\`ing exactly one intention, obtained by
calling one of the builders in \`actions\`. Never build intentions yourself.

state (read-only) shape:
{
  me: { x, y, carrying /* number held */, carryingIds: string[] },
  freeParcels: [ { id, x, y, reward, distance /* manhattan from me */ } ],
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
- Maximise reward minus distance when choosing a parcel (use the given distance).
- If carrying and no clearly better pickup exists, goDeliver before reward decays.
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
            const dist = manhattanDistance(me, { x: p.x, y: p.y });
            return createIntention('go_pick_up', p.id, { x: p.x, y: p.y }, p.reward - dist);
        },
        goDeliver() {
            if (beliefs.me.carrying.length === 0) return null;
            const target = findNearestDeliveryTile(me);
            if (!target) return null;
            const dist = manhattanDistance(me, target);
            const total = beliefs.me.carrying
                .map((id) => beliefs.parcels.get(id)?.reward ?? 0)
                .reduce((a, b) => a + b, 0);
            return createIntention('go_deliver', null, target, total - dist);
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
 * Asks the LLM to write the policy body, compiles it, smoke-tests it against the
 * current state, and caches it. On any failure leaves cachedFn = null.
 *
 * @param {Position} me
 * @returns {Promise<void>}
 */
async function generatePolicy(me) {
    const objective = llmMemory.objective || '∅';
    const userContent =
        objective !== '∅'
            ? `Operator objective to prioritise: "${objective}"\n\nWrite the function body now.`
            : 'Write the function body now.';

    const response = await llmClient.chat.completions.create({
        model: MODEL,
        messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
        temperature: 0,
    });

    const body = extractBody(response.choices?.[0]?.message?.content ?? '');
    if (!body || !/return/.test(body)) {
        throw new Error('empty or return-less body');
    }

    // eslint-disable-next-line no-new-func -- intentional: run LLM-written policy
    const fn = new Function('state', 'actions', `"use strict";\n${body}`);

    // Smoke-test against the live state so a broken policy fails now, not mid-game.
    const probe = fn(buildStateSnapshot(me), buildActions(me));
    if (!isValidIntention(probe)) {
        throw new Error(`policy returned invalid intention: ${JSON.stringify(probe)}`);
    }

    cachedFn = fn;
    cachedKey = objective;
    console.log(
        `[policyAgent] Generated policy for objective "${objective}":\n` +
            '----------------------------------------\n' +
            body +
            '\n----------------------------------------'
    );
}

/**
 * Deliberation entry point: returns the best intention by running the cached
 * LLM-generated policy, generating it first if needed. Falls back to the
 * deterministic heuristic on any failure.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntentionFromPolicy() {
    if (beliefs.me.x === null || beliefs.me.y === null) {
        return createIntention('wait', null, null, 0);
    }
    const me = { x: beliefs.me.x, y: beliefs.me.y };

    // Regenerate when the objective changed since the cached policy was built.
    const objective = llmMemory.objective || '∅';
    if (cachedFn && cachedKey !== objective) {
        cachedFn = null;
    }

    if (!cachedFn) {
        try {
            await generatePolicy(me);
        } catch (err) {
            console.log(`[policyAgent] Generation failed (${err.message}) → heuristic fallback`);
            return getBestIntention();
        }
    }

    try {
        const intention = cachedFn(buildStateSnapshot(me), buildActions(me));
        if (!isValidIntention(intention)) {
            console.log('[policyAgent] Policy returned invalid intention → heuristic fallback');
            return getBestIntention();
        }
        console.log(
            `[policyAgent] Policy chose ${intention.type}` +
                (intention.parcelId ? ` (${intention.parcelId})` : '') +
                ` score=${intention.score.toFixed(1)}`
        );
        return intention;
    } catch (err) {
        console.log(`[policyAgent] Policy threw (${err.message}) → heuristic fallback`);
        return getBestIntention();
    }
}

/** Forces the policy to be regenerated on the next deliberation. */
export function invalidatePolicy() {
    cachedFn = null;
    cachedKey = null;
}
