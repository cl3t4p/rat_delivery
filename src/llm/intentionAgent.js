/**
 * intentionAgent.js
 *
 * The LLM deliberation agent: every tick it chooses the single best next action
 * for agent B by calling exactly one tool. The LLM is the sole decision-maker —
 * there is no heuristic fallback; if the model errors or no tool applies, the
 * agent waits and retries next tick.
 *
 * The tools fall into three groups:
 *
 *   1. ACTIONS — turn into a concrete Intention the executor runs
 *      (go_pick_up, go_deliver, explore, go_to, wait).
 *
 *   2. MISSIONS / CHAT — read and answer the special missions sent over the
 *      Deliveroo chat (send_message, resolve_mission). These cover level-1
 *      atomic missions: "move to (4,7)", "what is the capital of Italy?",
 *      "calculate 5*5" — the model computes the answer itself and sends it.
 *
 *   3. RULES — install persistent strategy modifiers for level-2 missions
 *      (set_delivery_stack_size, set_delivery_tile_reward, set_max_pickup_reward,
 *      avoid_tile, add_constraint). A rule stays active for the rest of the
 *      match and reshapes ordinary pick-up / delivery behaviour; the action
 *      tools below read llmMemory.rules every tick and honour them.
 *
 * Level-3 missions (coordinating both agents) are intentionally NOT handled here
 * yet. The hook for them is the chat channel (llmMemory.sendMessage) plus a
 * future `send_cmd` tool that issues commands (e.g. freeze / unfreeze) to the
 * BDI peer; see the note next to the RULE tools.
 */

import { beliefs, manhattanDistance, isWalkable, blacklistCell } from '../bdi/beliefs.js';
import { costToReachPath } from '../bdi/helper.js';
import { createIntention, findBestPickUp } from '../bdi/deliberation.js';
import {
    findNearestSpawnerTile,
    findNearestDeliveryTile,
    findBestDeliveryTile,
} from '../bdi/components/tilesearch.js';
import { llmClient, llmMemory } from './llmAgent.js';
import { pickupValue, deliveryValue } from '../bdi/scoring.js';

const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */

// Returned by side-effect tools (send/resolve/rule installs) that change memory
// but produce no movement. It tells the deliberation loop to ask the model again
// this same tick, with the updated state, so it still ends on a real action.
const CONTINUE = Symbol('continue');

// Upper bound on model rounds per tick. Side-effect tools and not-applicable
// retries each consume a round; a few rounds let the model recover within a tick
// (e.g. install a rule, resolve the mission, then choose an action).
const MAX_ROUNDS = 8;

// Tool definitions exposed to the model (OpenAI function-calling format)

const INTENTION_TOOLS = [
    // ── Actions ──────────────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'go_pick_up',
            description:
                'Walk to a free parcel and pick it up. Choose the parcel in freeParcels with the ' +
                'highest score (it already accounts for distance and decay). Only parcels listed in ' +
                'freeParcels are valid.',
            parameters: {
                type: 'object',
                properties: {
                    parcelId: { type: 'string', description: 'Id of the free parcel to collect.' },
                },
                required: ['parcelId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'go_deliver',
            description:
                'Carry the held parcels to a delivery tile and drop them. With no argument it picks ' +
                'the best-scoring delivery tile (honouring any reward multipliers). Pass x,y to drop ' +
                'at a SPECIFIC delivery tile — use this for missions like "deliver in the leftmost ' +
                'tile" or to hit a bonus tile. Only valid while carrying at least one parcel.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Optional: x of a specific delivery tile.' },
                    y: { type: 'integer', description: 'Optional: y of a specific delivery tile.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explore',
            description:
                'Head to the nearest spawner to look for new parcels. Use when there is nothing ' +
                'worth picking up and nothing to deliver.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'go_to',
            description:
                'Walk to a specific walkable cell (x,y) without picking up or delivering. Use it for ' +
                'positioning, or for atomic missions like "move to coordinate (4,7)". If the cell is a ' +
                'wall or off-map it is snapped to the nearest reachable walkable tile.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Target cell x.' },
                    y: { type: 'integer', description: 'Target cell y.' },
                },
                required: ['x', 'y'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description: 'Stay in place this turn. Last resort, when no other action is possible.',
            parameters: { type: 'object', properties: {} },
        },
    },

    // ── Missions / chat ──────────────────────────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'send_message',
            description:
                'Send a chat message. Use it to ANSWER a special mission (e.g. a question or a ' +
                'calculation): compute the answer yourself and send it. Pass resolveIndex to also ' +
                'remove that mission once answered, and the reply is routed back to whoever sent it.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The message / answer to send.' },
                    to: {
                        type: 'string',
                        enum: ['peer', 'all'],
                        description:
                            'Send only to the teammate ("peer") or broadcast ("all"). ' +
                            'Ignored when resolveIndex is given (reply goes to the sender).',
                    },
                    resolveIndex: {
                        type: 'integer',
                        description:
                            'Index of the mission this answers; it is removed after sending.',
                    },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'resolve_mission',
            description:
                'Remove a special mission from memory once it is done, not worth the points, or ' +
                'junk. NEVER carry out a mission whose reward is negative or zero — resolve it instead.',
            parameters: {
                type: 'object',
                properties: {
                    index: { type: 'integer', description: 'Index of the mission to remove.' },
                },
                required: ['index'],
            },
        },
    },

    // ── Rules (level-2 persistent strategy) ──────────────────────────────────
    {
        type: 'function',
        function: {
            name: 'set_delivery_stack_size',
            description:
                'Persistent rule: deliver parcels only in stacks of exactly this many (e.g. ' +
                '"deliver stacks of exactly 3"). The agent then keeps picking up until it holds that ' +
                'many before delivering. Pass size 0 to clear the rule.',
            parameters: {
                type: 'object',
                properties: {
                    size: { type: 'integer', description: 'Exact stack size, or 0 to clear.' },
                },
                required: ['size'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_delivery_tile_reward',
            description:
                'Persistent rule: set the reward multiplier of a delivery tile (x,y). Use multiplier ' +
                '0 for a tile that scores nothing (never deliver there), a value > 1 for a bonus tile ' +
                'to prefer (e.g. "delivering in (3,1) gives 5x" -> multiplier 5). Default for any tile ' +
                'not set is 1.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Delivery tile x.' },
                    y: { type: 'integer', description: 'Delivery tile y.' },
                    multiplier: {
                        type: 'number',
                        description: 'Reward multiplier (0 = no reward).',
                    },
                },
                required: ['x', 'y', 'multiplier'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_max_pickup_reward',
            description:
                'Persistent rule: never pick up a parcel whose reward exceeds this value (e.g. ' +
                '"parcels with score higher than 10 give no reward" -> 10). Pass a negative number ' +
                'to clear the rule.',
            parameters: {
                type: 'object',
                properties: {
                    reward: {
                        type: 'integer',
                        description: 'Max pickable reward, or < 0 to clear.',
                    },
                },
                required: ['reward'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'avoid_tile',
            description:
                'Persistent rule: never walk through tile (x,y) (e.g. "do not go through (5,5) or ' +
                'you lose 50 points"). The cell is blacklisted so all movement routes around it.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Tile x to avoid.' },
                    y: { type: 'integer', description: 'Tile y to avoid.' },
                },
                required: ['x', 'y'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'add_constraint',
            description:
                'Record a free-text hard rule that must never be violated, when no specific rule ' +
                'tool fits. It is shown on every future tick as a reminder.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The constraint in plain language.' },
                },
                required: ['text'],
            },
        },
    },
];

// Local implementations
//
// Each builder receives the parsed args plus the current position. Action tools
// return an Intention or null (not applicable → the model is asked again).
// Side-effect tools mutate memory and return CONTINUE (or a wait when nothing
// changed, to avoid the model repeating an impossible action at temperature 0).

const TOOL_IMPL = {
    // ── Actions ──────────────────────────────────────────────────────────────

    /** @returns {Intention|null} */
    go_pick_up(args, me) {
        const parcel = args?.parcelId ? beliefs.parcels.get(args.parcelId) : null;
        if (!parcel || parcel.carriedBy) return null;

        // Honor the level-2 reward cap: high-reward parcels are off-limits.
        const cap = llmMemory.rules.maxPickupReward;
        if (cap != null && parcel.reward > cap) return null;

        const deliveryTile = findNearestDeliveryTile({ x: parcel.x, y: parcel.y });
        const score = deliveryTile ? pickupValue(parcel, me, deliveryTile) : parcel.reward;
        return createIntention('go_pick_up', parcel.id, { x: parcel.x, y: parcel.y }, score);
    },

    /** @returns {Intention|null} */
    go_deliver(args, me) {
        if (beliefs.me.carrying.length === 0) return null;

        // Stacking rule: while below the required stack size (and still able to
        // carry and pick up more), don't deliver yet — top up first.
        const stack = llmMemory.rules.deliverStackSize;
        if (stack && stack > 1) {
            const carrying = beliefs.me.carrying.length;
            const cap = beliefs.config?.MAX_PARCELS ?? 1;
            if (carrying < stack && carrying < cap && findBestPickUp(me, { log: false })) {
                return null; // not a full stack yet and a pickup is available
            }
        }

        const target = chooseDeliveryTile(me, args);
        if (!target) return null;
        const score = deliveryValue(beliefs.me.carrying, me, target);
        return createIntention('go_deliver', null, target, score);
    },

    /** @returns {Intention|null} */
    explore(_args, me) {
        const spawner = findNearestSpawnerTile(me);
        if (!spawner) return null;
        if (manhattanDistance(me, spawner) === 0) return createIntention('wait', null, null, 0);
        return createIntention('explore', null, spawner, 0);
    },

    /** @returns {Intention|null} */
    go_to(args, me) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

        const target = isWalkable(x, y) ? { x, y } : nearestReachableWalkable(me, x, y);
        if (!target) return null;
        if (manhattanDistance(me, target) === 0) return null; // already there
        return createIntention('go_to', null, target, 0);
    },

    /** @returns {Intention} */
    wait() {
        return createIntention('wait', null, null, 0);
    },

    // ── Missions / chat ──────────────────────────────────────────────────────

    /** @returns {Intention | typeof CONTINUE} */
    send_message(args) {
        const text = String(args?.text ?? '').trim();
        const mission = missionAt(args?.resolveIndex);

        if (text && typeof llmMemory.sendMessage === 'function') {
            // When answering a mission, route the reply back to whoever sent it;
            // otherwise honour the requested 'peer' / 'all' target.
            const to = mission?.from ?? (args?.to === 'peer' ? 'peer' : 'all');
            llmMemory.sendMessage(text, to);
            console.log(`[intentionAgent] send_message (${to}): "${text}"`);
        }

        // Resolving in the same step prevents answering the same mission twice. We
        // only re-deliberate when something actually changed (a mission removed);
        // otherwise we wait, so a temperature-0 model doesn't repeat the send.
        return removeMission(args?.resolveIndex)
            ? CONTINUE
            : createIntention('wait', null, null, 0);
    },

    /** @returns {Intention | typeof CONTINUE} */
    resolve_mission(args) {
        return removeMission(args?.index) ? CONTINUE : createIntention('wait', null, null, 0);
    },

    // ── Rules (level-2 persistent strategy) ──────────────────────────────────

    /** @returns {typeof CONTINUE} */
    set_delivery_stack_size(args) {
        const size = Number(args?.size);
        llmMemory.rules.deliverStackSize = Number.isInteger(size) && size > 0 ? size : null;
        console.log(`[intentionAgent] rule deliverStackSize=${llmMemory.rules.deliverStackSize}`);
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    set_delivery_tile_reward(args) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        const m = Number(args?.multiplier);
        if (Number.isInteger(x) && Number.isInteger(y) && Number.isFinite(m)) {
            llmMemory.rules.deliveryTileMultipliers[`${x},${y}`] = m;
            console.log(`[intentionAgent] rule deliveryTile (${x},${y}) multiplier=${m}`);
        }
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    set_max_pickup_reward(args) {
        const reward = Number(args?.reward);
        llmMemory.rules.maxPickupReward = Number.isFinite(reward) && reward >= 0 ? reward : null;
        console.log(`[intentionAgent] rule maxPickupReward=${llmMemory.rules.maxPickupReward}`);
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    avoid_tile(args) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (Number.isInteger(x) && Number.isInteger(y)) {
            const tiles = llmMemory.rules.avoidTiles;
            if (!tiles.some((t) => t.x === x && t.y === y)) tiles.push({ x, y });
            blacklistCell(x, y);
            console.log(`[intentionAgent] rule avoid_tile (${x},${y})`);
        }
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    add_constraint(args) {
        const text = String(args?.text ?? '').trim();
        if (text && !llmMemory.constraints.includes(text)) {
            llmMemory.constraints.push(text);
            console.log(`[intentionAgent] constraint added: "${text}"`);
        }
        return CONTINUE;
    },
};

/**
 * Picks the delivery tile to drop at, honouring the level-2 reward multipliers.
 *
 * With an explicit (x,y) the agent drops there as long as it is a real delivery
 * tile that is not banned (multiplier <= 0). Otherwise the best tile is chosen by
 * estimated reward times its multiplier, skipping banned and unreachable tiles.
 * Falls back to the plain nearest/best delivery tile when no multipliers apply.
 *
 * @param {Position} me
 * @param {{x?: number, y?: number}} args
 * @returns {Position|null}
 */
function chooseDeliveryTile(me, args) {
    const multipliers = llmMemory.rules.deliveryTileMultipliers;
    const multiplierOf = (t) => {
        const m = multipliers[`${t.x},${t.y}`];
        return m === undefined ? 1 : m;
    };

    // Explicit target requested (e.g. "leftmost tile" or a bonus tile).
    if (Number.isInteger(Number(args?.x)) && Number.isInteger(Number(args?.y))) {
        const x = Number(args.x);
        const y = Number(args.y);
        const tile = beliefs.deliveryTiles.find((t) => t.x === x && t.y === y);
        if (!tile) return null; // not a delivery tile → dropping there loses the parcels
        if (multiplierOf(tile) <= 0) return null; // banned tile → refuse
        return { x: tile.x, y: tile.y };
    }

    // No multipliers configured: keep the standard best-delivery-tile behaviour.
    if (Object.keys(multipliers).length === 0) return findBestDeliveryTile(me);

    // Choose the reachable, non-banned tile with the best multiplier-weighted value.
    let best = null;
    let bestScore = -Infinity;
    for (const tile of beliefs.deliveryTiles) {
        const mult = multiplierOf(tile);
        if (mult <= 0) continue;
        if (costToReachPath(me, tile) == null) continue;
        const score = deliveryValue(beliefs.me.carrying, me, tile) * mult;
        if (score > bestScore) {
            bestScore = score;
            best = { x: tile.x, y: tile.y };
        }
    }
    return best ?? findBestDeliveryTile(me);
}

/**
 * Finds the nearest walkable, reachable tile to a requested (possibly wall /
 * off-map) target. Candidates are scanned closest-first and the first with a
 * real path from `me` is returned.
 *
 * @param {Position} me
 * @param {number} x
 * @param {number} y
 * @returns {Position|null}
 */
function nearestReachableWalkable(me, x, y) {
    const candidates = [];
    for (const key of beliefs.grid.keys()) {
        const [gx, gy] = key.split(',').map(Number);
        if (!isWalkable(gx, gy)) continue;
        candidates.push({ x: gx, y: gy, d: Math.abs(gx - x) + Math.abs(gy - y) });
    }
    candidates.sort((a, b) => a.d - b.d);

    const MAX_CHECKS = 25;
    for (let i = 0; i < candidates.length && i < MAX_CHECKS; i++) {
        const c = candidates[i];
        if (costToReachPath(me, { x: c.x, y: c.y }) != null) return { x: c.x, y: c.y };
    }
    return null;
}

/**
 * Returns the mission at `index`, or null if the index is out of range.
 *
 * @param {unknown} index
 * @returns {{text: string, from: string|null, ts: number}|null}
 */
function missionAt(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= llmMemory.missions.length) return null;
    return llmMemory.missions[i];
}

/**
 * Removes the mission at `index`. Returns true if one was removed.
 *
 * @param {unknown} index
 * @returns {boolean}
 */
function removeMission(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= llmMemory.missions.length) return false;
    const [removed] = llmMemory.missions.splice(i, 1);
    console.log(`[intentionAgent] resolved mission: "${removed?.text ?? ''}"`);
    return true;
}

const SYSTEM_PROMPT = `
You are the deliberation module of an autonomous agent playing Deliveroo.js, a grid
delivery game. Each tick you receive the map and world state and choose the single best
next action. You act ONLY by calling exactly one tool — never write prose or reasoning,
your entire reply is one tool call.

THE MAP
Each cell has a type:
  0 = wall      — impassable, never a valid target
  1 = spawner   — new parcels appear here
  2 = delivery  — drop carried parcels here to score
  3 = floor     — walkable, nothing special
  . = unknown / outside the map — treat as not walkable
Coordinates are (x, y): x is the column (0 = leftmost, increasing right); y is the row.
The grid is printed with the highest y at the top and y=0 at the bottom, so "bottom-left"
= low x, low y; "top-right" = high x, high y; "leftmost" = the smallest x.

STATE FIELDS
- me: your (x, y), how many parcels you carry, and their ids.
- freeParcels: pickable parcels, each with reward, distanceToParcel, distanceToDelivery,
  estimatedRewardAtDelivery, and score (net value; higher is better). These are precomputed.
- deliveryTiles: all drop-off coordinates.
- otherAgents, blacklist, constraints: rivals, cells to avoid, hard rules.
- world.maxCarry: most parcels you may hold at once.
- activeRules: the persistent strategy rules currently in force (see RULES). Read these so
  you do not re-install a rule that is already set.

STANDARD BEHAVIOUR (pick the first that applies, AFTER missions and within constraints)
1. DELIVER if you carry parcels (respecting any stack-size rule).
2. PICK UP the highest-score free parcel if carrying nothing or topping up a stack.
3. EXPLORE spawners when nothing is worth carrying or picking up.
4. WAIT only when literally nothing else is possible.

SPECIAL MISSIONS  (the "missions" list — index: text — each worth POSITIVE or NEGATIVE points)
Handle worthwhile missions before ordinary parcel work. First judge net value (reward minus
effort):
- A mission with negative or zero reward, or whose payoff does not justify the detour, or
  that is junk: clear it with resolve_mission and do NOT carry it out. Acting on a negative
  mission LOSES points.
- Atomic missions you do directly: "move to (4,7)" -> go_to; "what is the capital of Italy?"
  or "calculate 5*5" -> compute the answer yourself and send_message with resolveIndex.
  When a mission gives coordinates as expressions (x=4*2), evaluate them yourself first.
- Persistent missions that change strategy for the whole match -> install a RULE (below),
  then resolve the mission once the matching rule is active.
- Always answer a question before resolving it; never answer the same mission twice.

RULES (persistent — install once, they stay active and reshape standard behaviour)
- "deliver stacks of exactly N"            -> set_delivery_stack_size(N)
- "delivering in (x,y) gives K times / 0"  -> set_delivery_tile_reward(x,y, K)   (0 = never deliver there)
- "parcels with score > N give no reward"  -> set_max_pickup_reward(N)
- "do not go through tile (x,y)"           -> avoid_tile(x,y)
- any other hard rule                       -> add_constraint(text)
Before installing a rule, check activeRules — if it is already set, just resolve the mission.
To deliver at a specific tile (e.g. a bonus tile or "the leftmost tile"), call go_deliver
with that tile's x,y.

HARD RULES
- Output exactly one tool call. No text.
- Obey constraints and activeRules above everything else.
- Never target a wall, a "." cell, a blacklisted cell, or an off-map coordinate.
- Never act on a mission with negative or zero reward — resolve it instead.

`.trim();
//- Prefer acting over waiting; wait is the last resort.
/**
 * Renders the known static map as an ASCII grid (top row = highest y) for the
 * prompt, each row prefixed with its y coordinate.
 *
 * @returns {string}
 */
function buildGridMap() {
    if (beliefs.grid.size === 0) return '(map not loaded yet)';

    let maxX = 0;
    let maxY = 0;
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    const rows = [];
    for (let y = maxY; y >= 0; y--) {
        let row = '';
        for (let x = 0; x <= maxX; x++) {
            const tile = beliefs.grid.get(`${x},${y}`);
            row += tile ? tile.type : '.';
        }
        rows.push(`y=${String(y).padStart(2)} ${row}`);
    }
    return rows.join('\n');
}

/**
 * Builds the dynamic state snapshot handed to the model alongside the map.
 *
 * Free parcels banned by the max-pickup-reward rule are filtered out so the
 * model never proposes picking them up.
 *
 * @param {Position} me
 * @returns {object}
 */
export function buildStateSnapshot(me) {
    const cap = llmMemory.rules.maxPickupReward;

    return {
        me: {
            x: me.x,
            y: me.y,
            carrying: beliefs.me.carrying.length,
            carryingIds: beliefs.me.carrying,
        },
        freeParcels: [...beliefs.parcels.values()]
            .filter((p) => !p.carriedBy && p.reward > 0 && (cap == null || p.reward <= cap))
            .map((p) => {
                const deliveryTile = findNearestDeliveryTile({ x: p.x, y: p.y });
                const distanceToParcel = manhattanDistance(me, { x: p.x, y: p.y });
                const distanceToDelivery = deliveryTile
                    ? manhattanDistance({ x: p.x, y: p.y }, deliveryTile)
                    : null;
                const score = deliveryTile ? pickupValue(p, me, deliveryTile) : -Infinity;
                const estimatedRewardAtDelivery = deliveryTile
                    ? Math.max(
                          0,
                          p.reward -
                              Math.floor(
                                  ((distanceToParcel + (distanceToDelivery ?? 0)) *
                                      (beliefs.config?.MS_PER_STEP ?? 500)) /
                                      (beliefs.config?.PARCEL_DECADING_INTERVAL ?? Infinity)
                              )
                      )
                    : 0;
                return {
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    reward: p.reward,
                    distanceToParcel,
                    distanceToDelivery,
                    estimatedRewardAtDelivery,
                    score,
                };
            }),
        deliveryTiles: beliefs.deliveryTiles,
        otherAgents: [...beliefs.agents.values()]
            .filter((a) => !a.stale)
            .map((a) => ({ x: a.x, y: a.y })),
        blacklist: [...beliefs.blacklist].map((k) => {
            const [x, y] = k.split(',').map(Number);
            return { x, y };
        }),
        constraints: llmMemory.constraints,
        activeRules: {
            deliverStackSize: llmMemory.rules.deliverStackSize,
            maxPickupReward: llmMemory.rules.maxPickupReward,
            deliveryTileMultipliers: llmMemory.rules.deliveryTileMultipliers,
            avoidTiles: llmMemory.rules.avoidTiles,
        },
        world: {
            parcelGenerationMs: beliefs.config.PARCEL_GENERATION_INTERVAL,
            maxCarry: beliefs.config.MAX_PARCELS,
        },
    };
}

/**
 * Builds the user message (constraints, missions, map, state). Rebuilt every
 * round because side-effect tools can change memory between rounds.
 *
 * @param {Position} me
 * @returns {string}
 */
function buildUserContent(me) {
    const snapshot = buildStateSnapshot(me);

    const constraintBlock =
        llmMemory.constraints.length > 0
            ? `Constraints (NEVER violate these):\n${llmMemory.constraints
                  .map((c) => `- ${c}`)
                  .join('\n')}\n\n`
            : '';

    const missionBlock =
        llmMemory.missions.length > 0
            ? `Special missions (index: text):\n${llmMemory.missions
                  .map((m, i) => `${i}: ${m.text}`)
                  .join('\n')}\n\n`
            : '';

    return (
        constraintBlock +
        missionBlock +
        (llmMemory.objective ? `Operator objective: ${llmMemory.objective}\n\n` : '') +
        `Map (legend in the system prompt):\n${buildGridMap()}\n\n` +
        `State:\n${JSON.stringify(snapshot, null, 2)}`
    );
}

/**
 * Asks the model for the best next intention. It calls one tool per round; for a
 * side-effect tool or a not-applicable action we feed the outcome back and let it
 * choose again (up to MAX_ROUNDS) so it never loops on an impossible action and
 * never falls back to a heuristic.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntention() {
    if (beliefs.me.x === null || beliefs.me.y === null) {
        return createIntention('wait', null, null, 0);
    }

    const me = { x: beliefs.me.x, y: beliefs.me.y };
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(me) },
    ];

    for (let round = 0; round < MAX_ROUNDS; round++) {
        let message;
        try {
            const response = await llmClient.chat.completions.create({
                model: MODEL,
                messages,
                tools: INTENTION_TOOLS,
                tool_choice: 'required',
                temperature: 0,
            });
            message = response.choices?.[0]?.message;
        } catch (err) {
            console.log(`[intentionAgent] LLM error (${err.message}), waiting`);
            return createIntention('wait', null, null, 0);
        }

        const toolCall = message?.tool_calls?.[0];
        if (!toolCall) {
            console.log('[intentionAgent] LLM returned no tool call, waiting');
            return createIntention('wait', null, null, 0);
        }

        console.log(
            `[intentionAgent] LLM call: ${toolCall.function?.name}(${toolCall.function?.arguments ?? ''})`
        );

        // Keep the assistant turn so the tool result that follows is correlated.
        messages.push(message);

        const name = toolCall.function?.name;
        const impl = TOOL_IMPL[name];

        let args = {};
        try {
            args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch {
            args = {};
        }

        if (!impl) {
            feedToolResult(messages, toolCall, `Unknown tool "${name}". Pick a provided tool.`);
            continue;
        }

        const result = impl(args, me);

        // Side-effect tool (message sent / mission resolved / rule installed):
        // report done and re-state the updated situation for the next round.
        if (result === CONTINUE) {
            feedToolResult(messages, toolCall, 'Done.');
            messages.push({ role: 'user', content: buildUserContent(me) });
            continue;
        }

        if (!result) {
            console.log(`[intentionAgent] Tool "${name}" not applicable, asking again`);
            feedToolResult(
                messages,
                toolCall,
                `"${name}" cannot be executed now (target gone, already carried/there, blocked by a ` +
                    `rule, or unreachable). Choose a DIFFERENT action or tool.`
            );
            continue;
        }

        console.log(
            `[intentionAgent] chose ${name}` +
                (result.parcelId ? ` (${result.parcelId})` : '') +
                ` score=${result.score.toFixed(1)}`
        );
        return result;
    }

    console.log(`[intentionAgent] Max rounds (${MAX_ROUNDS}) reached, waiting`);
    return createIntention('wait', null, null, 0);
}

/**
 * Appends a tool-result message correlated to a tool call.
 *
 * @param {object[]} messages
 * @param {{ id: string }} toolCall
 * @param {string} content
 */
function feedToolResult(messages, toolCall, content) {
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
}
