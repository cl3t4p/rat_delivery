/**
 * intentionAgent.js
 *
 * A standalone LLM deliberation agent, decoupled from the BDI heuristic.
 *
 * Idea:
 *   - The BDI asks "what should I do next?".
 *   - We hand the LLM the grid map, the current state and a set of *tools*
 *     (the intention-builders it is allowed to use).
 *   - The LLM answers by *calling one tool*. We run that tool locally and it
 *     produces the concrete Intention object the executor will carry out.
 *
 * In other words the LLM does not return free text: it picks the best
 * intention by invoking exactly one of the functions exposed to it.
 *
 * If anything goes wrong (no API, malformed answer, unknown tool) we fall
 * back to the deterministic heuristic in deliberation.js, so the agent keeps
 * playing even when the model is unavailable.
 */

import { beliefs, manhattanDistance, isWalkable } from '../bdi/beliefs.js';
import { costToReachPath } from '../bdi/helper.js';
import { createIntention } from '../bdi/deliberation.js';
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

// Returned by side-effect tools (send_message, resolve_mission) that perform an
// action but produce no movement. It tells generateBestIntention to deliberate
// again so the LLM still chooses a real intention this tick (no heuristic).
const CONTINUE = Symbol('continue');

// Upper bound on LLM rounds per tick: side-effect tools and not-applicable
// retries consume rounds, so allow a few to let the model recover within a tick.
// After this many rounds we wait and try again next tick.
const MAX_ROUNDS = 6;

// Tools exposed to the LLM
//
// Each entry is an OpenAI function-calling tool definition. The LLM selects
// one of these to express the best intention. The matching local
// implementation lives in TOOL_IMPL below and turns the call into a real
// Intention object.
const INTENTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'go_pick_up',
            description:
                'Walk to a free parcel and pick it up. Pick the parcel that maximises ' +
                'expected delivered value considering distance to parcel, distance to delivery and decay. ' +
                'Only choose a parcel listed in freeParcels with a positive score.',
            parameters: {
                type: 'object',
                properties: {
                    parcelId: {
                        type: 'string',
                        description: 'The id of the free parcel to collect.',
                    },
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
                'Carry the parcels currently held to the nearest delivery tile and drop them. ' +
                'Uses estimated reward at arrival accounting for decay. ' +
                'Only valid when carrying at least one parcel.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'explore',
            description:
                'Head to the nearest spawner tile to look for new parcels. Use this when there ' +
                'is nothing worth picking up and nothing to deliver.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'go_to',
            description:
                'Walk to a specific map cell (x,y) without picking up or delivering. Use this for ' +
                'positioning: camping near a chosen spawner, repositioning toward a contested or ' +
                'parcel-rich area, or moving to a better vantage point. The target must be a ' +
                'known, walkable cell (not a wall and not outside the map).',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Target cell x coordinate.' },
                    y: { type: 'integer', description: 'Target cell y coordinate.' },
                },
                required: ['x', 'y'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description:
                'Stay in place for this turn. Last resort, when no other action is possible.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_message',
            description:
                'Send a chat message to the other agent (or broadcast it). Use this to ' +
                'coordinate, or to ANSWER a question asked by a special mission (e.g. ' +
                '"What is the capital of Italy?" -> "Rome", or "Calculate 5*5" -> "25"). ' +
                'When answering a mission, ALSO pass resolveIndex so the mission is ' +
                'removed in the same step and not answered again.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The message / answer to send.' },
                    to: {
                        type: 'string',
                        enum: ['peer', 'all'],
                        description: 'Send only to the teammate ("peer") or broadcast ("all").',
                    },
                    resolveIndex: {
                        type: 'integer',
                        description:
                            'Index of the mission this message answers; it is removed from ' +
                            'memory after sending. Omit when just coordinating with the peer.',
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
                'Remove a special mission from memory once it is done, not worth the points, ' +
                'or just junk/noise. Use this to clean up after completing or answering a ' +
                'mission, or to ignore one whose reward does not justify the cost.',
            parameters: {
                type: 'object',
                properties: {
                    index: {
                        type: 'integer',
                        description: 'Index of the mission in the Special missions list to remove.',
                    },
                },
                required: ['index'],
            },
        },
    },
];

// Local implementations of the tools
//
// Each builder receives the parsed arguments plus the current position and
// returns an Intention, or null when the choice is not applicable (e.g. the
// LLM asked to pick up a parcel that no longer exists).
const TOOL_IMPL = {
    /** @returns {Intention|null} */
    go_pick_up(args, me) {
        const parcel = args?.parcelId ? beliefs.parcels.get(args.parcelId) : null;
        // The LLM is the decision-maker: honour its choice as long as the parcel
        // still exists and nobody is carrying it. Don't reject low-value pickups
        // here (a score gate just makes the model loop on the same parcel). The
        // score is computed only for logging/telemetry.
        if (!parcel || parcel.carriedBy) return null;
        const deliveryTile = findNearestDeliveryTile({ x: parcel.x, y: parcel.y });
        const score = deliveryTile ? pickupValue(parcel, me, deliveryTile) : parcel.reward;
        return createIntention('go_pick_up', parcel.id, { x: parcel.x, y: parcel.y }, score);
    },

    /** @returns {Intention|null} */
    go_deliver(_args, me) {
        if (beliefs.me.carrying.length === 0) return null;
        const target = findBestDeliveryTile(me);
        if (!target) return null;
        const score = deliveryValue(beliefs.me.carrying, me, target);
        return createIntention('go_deliver', null, target, score);
    },

    /** @returns {Intention|null} */
    explore(_args, me) {
        const spawner = findNearestSpawnerTile(me);
        if (!spawner) return null;
        if (manhattanDistance(me, spawner) === 0) {
            return createIntention('wait', null, null, 0);
        }
        return createIntention('explore', null, spawner, 0);
    },

    /** @returns {Intention|null} */
    go_to(args, me) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

        // The LLM often aims at an approximate spot (e.g. a map corner for
        // "bottom-left") that turns out to be a wall or off-map. Snap to the
        // nearest reachable walkable tile so the agent actually goes there,
        // instead of looping forever on "not applicable".
        const target = isWalkable(x, y) ? { x, y } : nearestReachableWalkable(me, x, y);
        if (!target) return null;
        if (manhattanDistance(me, target) === 0) return null; // already there
        return createIntention('go_to', null, target, 0);
    },

    /** @returns {Intention} */
    wait() {
        return createIntention('wait', null, null, 0);
    },

    /** @returns {Intention | typeof CONTINUE} */
    send_message(args) {
        const text = String(args?.text ?? '').trim();
        if (text && typeof llmMemory.sendMessage === 'function') {
            llmMemory.sendMessage(text, args?.to === 'peer' ? 'peer' : 'all');
            console.log(`[intentionAgent] send_message (${args?.to ?? 'all'}): "${text}"`);
        }

        // Answering a mission removes it in the same step so it is never answered
        // again. Only then is it safe to re-deliberate (state changed); otherwise
        // re-deliberating with an unchanged prompt would just repeat this send at
        // temperature 0, so we wait out the tick instead.
        const resolved = removeMission(args?.resolveIndex);
        return resolved ? CONTINUE : createIntention('wait', null, null, 0);
    },

    /** @returns {Intention | typeof CONTINUE} */
    resolve_mission(args) {
        const removed = removeMission(args?.index);
        // Mission list changed: deliberate again for a real intention. If the
        // index was invalid (nothing removed), don't loop on an unchanged prompt.
        return removed ? CONTINUE : createIntention('wait', null, null, 0);
    },
};

/**
 * Finds the nearest walkable, reachable tile to a requested (possibly
 * wall/off-map) target. Candidates are scanned closest-first by Manhattan
 * distance and the first one with a real path from `me` is returned.
 *
 * @param {Position} me
 * @param {number} x - Requested x.
 * @param {number} y - Requested y.
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

    // Cap reachability checks: the closest walkable tile is almost always
    // reachable, so we rarely scan far.
    const MAX_CHECKS = 25;
    for (let i = 0; i < candidates.length && i < MAX_CHECKS; i++) {
        const c = candidates[i];
        if (costToReachPath(me, { x: c.x, y: c.y }) != null) return { x: c.x, y: c.y };
    }
    return null;
}

/**
 * Removes the mission at `index` from memory. Returns true if one was removed.
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
delivery game. Each tick you receive the current map and world state and must choose
the single best next action. You act ONLY by calling exactly one tool. Never write
prose, reasoning, or commentary — your entire reply is one tool call.

THE MAP
Each cell has a type:
  0 = wall      — impassable, never a valid target
  1 = spawner   — new parcels appear here
  2 = delivery  — drop carried parcels here to score
  3 = floor     — walkable, nothing special
  . = unknown / outside the map — treat as not walkable
Coordinates are (x, y): x is the column (0 = leftmost, increasing right); y is the row.
The grid is printed with the highest y at the top and y=0 at the bottom, so it reads
like the screen. Therefore "bottom-left" = low x, low y; "top-right" = high x, high y;
"center" = the middle of the printed grid.

STATE FIELDS
- me: your (x, y), how many parcels you carry, and their ids.
- freeParcels: every pickable parcel, each with:
    reward                    current point value
    distanceToParcel          steps from you to it
    distanceToDelivery        steps from it to the nearest delivery tile
    estimatedRewardAtDelivery reward left after decay once delivered (0 = worthless)
    score                     net value after travel; higher is better
  These are precomputed. Do not recompute them — just compare them.
- deliveryTiles: all drop-off coordinates.
- otherAgents: rival positions. A parcel an opponent is closer to is likely lost —
  prefer parcels you can reach first.
- blacklist: tiles to avoid (stuck/blocked). Never target a blacklisted cell.
- constraints: hard rules you must obey.
- world.maxCarry: the most parcels you may hold at once.
- world.parcelGenerationMs: how often parcels spawn.

DECISION ORDER (top to bottom; pick the first that applies)
1. CONSTRAINTS. Every action must respect the listed Constraints. They override all.
2. OPERATOR OBJECTIVE. If an "Operator objective" is given, treat it as the human's
   standing intent and let it steer your choices (within constraints).
3. SPECIAL MISSIONS. If the "Special missions" list is non-empty, handle a worthwhile
   mission before ordinary parcel work (see MISSIONS).
4. DELIVER. If you carry one or more parcels, default to go_deliver. Top up with
   go_pick_up first ONLY when you are below maxCarry AND some free parcel has a high
   score and lies close to you or roughly on the way to a delivery tile. At maxCarry,
   always go_deliver.
5. PICK UP. If carrying nothing (or topping up), call go_pick_up on the freeParcel with
   the HIGHEST score. Never pick a parcel with score <= 0 or estimatedRewardAtDelivery
   == 0 — it pays nothing by the time you arrive.
6. EXPLORE. If nothing is worth carrying and nothing worth picking up, call explore to
   search spawners for new parcels.
7. REPOSITION. Use go_to(x, y) only for deliberate positioning — camp a spawner, move
   toward a parcel-rich or contested area — aimed at a known, walkable cell. For plain
   "find parcels", prefer explore.
8. WAIT only when literally nothing else is possible; it wastes the tick.

TOOLS
- go_pick_up(parcelId): collect a specific free parcel.
- go_deliver(): take everything you carry to the nearest delivery tile.
- explore(): go to the nearest spawner to look for parcels.
- go_to(x, y): walk to a walkable cell without picking up or delivering.
- wait(): stay put (last resort).
- send_message(text, to?, resolveIndex?): chat the teammate ("peer") or broadcast
  ("all"); also used to ANSWER a mission question.
- resolve_mission(index): remove a finished, satisfied, or junk mission.

MISSIONS
Each is "index: text" — a natural-language task, usually worth points. Read it, do any
arithmetic yourself (e.g. "x = 4*2" -> 8), then:
- QUESTION ("What is the capital of Italy?", "Calculate 5*5"): free points. Call
  send_message ONCE with the answer AND resolveIndex set to that mission's index, so it
  is answered and removed together. Never answer twice; never resolve without answering.
- COORDINATE / AREA ("Move to (4,7)", "go to the bottom-left"): pick the target cell and
  call go_to(x, y). Keep calling go_to over successive ticks until you arrive; only THEN
  call resolve_mission(index). Do not resolve before you are standing on it.
- PARCEL mission: use go_pick_up / go_deliver as the task requires.
- JUNK or not worth it (reward <= 0, nonsense): call resolve_mission alone, without acting.
A mission you already stand on / have already satisfied is done — resolve it.

HARD RULES
- Output exactly one tool call. No text.
- Never target a wall, a "." cell, a blacklisted cell, or an off-map coordinate.
- Never go_pick_up a parcel with score <= 0 or estimatedRewardAtDelivery == 0.
- Never answer the same mission twice, and never resolve a question without answering.
- Prefer acting over waiting; wait is the last resort.`.trim();

/**
 * Renders the known static map as an ASCII grid for the prompt.
 *
 * Rows are printed top (highest y) to bottom so they read like the in-game
 * board. Each row is prefixed with its y coordinate.
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
 * Builds the dynamic state snapshot handed to the LLM alongside the map.
 *
 * @param {Position} me
 * @returns {object}
 */
export function buildStateSnapshot(me) {
    return {
        me: {
            x: me.x,
            y: me.y,
            carrying: beliefs.me.carrying.length,
            carryingIds: beliefs.me.carrying,
        },
        freeParcels: [...beliefs.parcels.values()]
            .filter((p) => !p.carriedBy && p.reward > 0)
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
        world: {
            parcelGenerationMs: beliefs.config.PARCEL_GENERATION_INTERVAL,
            maxCarry: beliefs.config.MAX_PARCELS,
        },
    };
}

/**
 * Builds the user message handed to the LLM (constraints, missions, map, state).
 *
 * Rebuilt every round because side-effect tools (e.g. resolve_mission) can
 * change memory between rounds.
 *
 * @param {Position} me
 * @returns {string}
 */
function buildUserContent(me) {
    const snapshot = buildStateSnapshot(me);

    const constraintBlock =
        llmMemory.constraints.length > 0
            ? `Constraints (NEVER violate these):\n${llmMemory.constraints.map((c) => `- ${c}`).join('\n')}\n\n`
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
 * Asks the LLM for the best next intention.
 *
 * The LLM is given the map, the current state and the intention tools, and it
 * replies by calling one tool. That call is executed locally to produce the
 * Intention. The LLM is the sole decision-maker: there is no deterministic
 * heuristic fallback. When the model errors out or a tool cannot be applied,
 * the agent simply waits and tries again on the next tick.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntention() {
    // Position unknown: nothing the LLM can reason about yet.
    if (beliefs.me.x === null || beliefs.me.y === null) {
        return createIntention('wait', null, null, 0);
    }

    const me = { x: beliefs.me.x, y: beliefs.me.y };

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(me) },
    ];

    // The model picks one tool per round. When the chosen tool is a side effect
    // (send_message/resolve_mission) or is genuinely not applicable, we feed the
    // outcome back and let it choose again — up to MAX_ROUNDS. This way it never
    // loops on the same impossible action (temperature 0 would repeat it) and
    // never falls back to a heuristic.
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
            `[intentionAgent] LLM function call: ${toolCall.function?.name}(${toolCall.function?.arguments ?? ''})`
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

        const intention = impl(args, me);

        // Side-effect tool (message sent / mission resolved): report done and
        // re-state the (now updated) situation so it picks a real next action.
        if (intention === CONTINUE) {
            feedToolResult(messages, toolCall, 'Done.');
            messages.push({ role: 'user', content: buildUserContent(me) });
            continue;
        }

        if (!intention) {
            console.log(`[intentionAgent] Tool "${name}" not applicable, asking again`);
            feedToolResult(
                messages,
                toolCall,
                `"${name}" cannot be executed now (target gone, already carried/there, or ` +
                    `unreachable). Choose a DIFFERENT action or tool.`
            );
            continue;
        }

        console.log(
            `[intentionAgent] LLM chose ${name}` +
                (intention.parcelId ? ` (${intention.parcelId})` : '') +
                ` score=${intention.score.toFixed(1)}`
        );
        return intention;
    }

    // Exhausted the round budget without a usable intention: wait this tick.
    console.log(`[intentionAgent] Max rounds (${MAX_ROUNDS}) reached, waiting`);
    return createIntention('wait', null, null, 0);
}

/**
 * Appends a tool-result message correlated to a tool call, so the next round the
 * model sees the outcome of what it just tried.
 *
 * @param {object[]} messages
 * @param {{ id: string }} toolCall
 * @param {string} content
 */
function feedToolResult(messages, toolCall, content) {
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
}
