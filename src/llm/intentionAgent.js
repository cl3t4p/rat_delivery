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
import {
    createIntention,
    findNearestDeliveryTile,
    findBestDeliveryTile,
    findBestDiscardTile,
    findNearestSpawnerTile,
    findBestPickUp,
    getBestIntention,
} from '../bdi/deliberation.js';
import { aStar } from '../bdi/pathfinding.js';
import { llmClient, llmMemory } from './llmAgent.js';
import {
    deliveryValue,
    estimatedRewardAtDelivery,
    applyDeliveryRewardRules,
} from '../bdi/scoring.js';

const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */

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
        if (!parcel || parcel.carriedBy || parcel.reward <= 0) return null;
        const bestPickUp = findBestPickUp(me, { allowOutOfZone: true, log: false });
        if (!bestPickUp || bestPickUp.parcelId !== parcel.id || bestPickUp.score <= 0) return null;
        return bestPickUp;
    },

    /** @returns {Intention|null} */
    go_deliver(_args, me) {
        if (beliefs.me.carrying.length === 0) return null;
        const stackRule = llmMemory.rewardRules?.stackRule ?? null;
        const capacity = beliefs.config?.MAX_PARCELS ?? 1;
        if (
            stackRule &&
            stackRule.multiplier > 1 &&
            beliefs.me.carrying.length < stackRule.exact &&
            beliefs.me.carrying.length < capacity
        ) {
            return null;
        }
        if (carriedBaseReward() > (llmMemory.rewardRules?.maxDeliveryReward ?? Infinity)) {
            const discard = findBestDiscardTile(me);
            if (discard) return createIntention('go_putdown', null, discard, 0);
            return null;
        }
        const target = findBestDeliveryTile(me);
        if (!target) return null;
        const score = deliveryValue(beliefs.me.carrying, me, target);
        if (score <= 0) {
            const discard = findBestDiscardTile(me);
            if (discard) return createIntention('go_putdown', null, discard, 0);
            return null;
        }
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
        if (!isWalkable(x, y)) return null; // unknown cell or wall
        if (manhattanDistance(me, { x, y }) === 0) return null; // already there
        return createIntention('go_to', null, { x, y }, 0);
    },

    /** @returns {Intention} */
    wait() {
        return createIntention('wait', null, null, 0);
    },
};

function carriedBaseReward() {
    return beliefs.me.carrying.reduce((total, id) => {
        const parcel = beliefs.parcels.get(id);
        return total + (parcel?.reward ?? 0);
    }, 0);
}

const SYSTEM_PROMPT = `
You are the deliberation agent of a Deliveroo.js player. You decide the single
best next intention for the agent and express it by calling exactly one tool.

The world is a grid. Each cell in the map has a type:
  0 = wall (cannot enter)
  1 = spawner (parcels appear here)
  2 = delivery tile (drop parcels here to score)
  3 = normal floor
  . = unknown / outside the map

Rules:
- Each free parcel in the state has: reward, distanceToParcel, distanceToDelivery,
  estimatedRewardAtDelivery, and score (= estimatedRewardAtDelivery - total route distance).
- Pick the parcel with the highest score. Never pick a parcel with score <= 0.
- If carrying parcels, prefer go_deliver unless a detour to a new parcel clearly
  improves the total estimated value at delivery.
- Do not pick parcels that will be worthless (estimatedRewardAtDelivery = 0) at delivery.
- If nothing is worth picking up and nothing to deliver, explore.
- Use go_to(x,y) to reposition strategically (camp a spawner, move to a parcel-rich area).
- Only use wait when nothing else is possible.

Answer ONLY by calling one tool. Do not write prose.`.trim();

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
                const rawEstimatedRewardAtDelivery = deliveryTile
                    ? estimatedRewardAtDelivery(p.reward, distanceToParcel + (distanceToDelivery ?? 0))
                    : 0;
                const adjustedRewardAtDelivery = deliveryTile
                    ? applyDeliveryRewardRules(rawEstimatedRewardAtDelivery, 1, deliveryTile)
                    : 0;
                const score = adjustedRewardAtDelivery > 0
                    ? adjustedRewardAtDelivery - distanceToParcel - (distanceToDelivery ?? 0)
                    : -Infinity;
                return {
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    reward: p.reward,
                    distanceToParcel,
                    distanceToDelivery,
                    estimatedRewardAtDelivery: adjustedRewardAtDelivery,
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
        rewardRules: llmMemory.rewardRules,
        world: {
            parcelGenerationMs: beliefs.config.PARCEL_GENERATION_INTERVAL,
            maxCarry: beliefs.config.MAX_PARCELS,
        },
    };
}

function getLeftmostReachableTile(me) {
    let best = null;
    let bestPathLength = Infinity;
    let bestX = Infinity;

    for (const [key, tile] of beliefs.grid) {
        if (tile.type === '0') continue;
        const [x, y] = key.split(',').map(Number);
        if (x > bestX) continue;
        if (!isWalkable(x, y)) continue;

        const result = aStar(me, { x, y }, { avoidAgents: false });
        if (!result) continue;

        if (x < bestX || result.moves.length < bestPathLength) {
            bestX = x;
            bestPathLength = result.moves.length;
            best = { x, y };
        }
    }

    return best;
}

function markOperatorObjective(intention) {
    if (intention) intention._operatorObjective = true;
    return intention;
}

function getSpecialObjectiveIntention(me) {
    const type = llmMemory.specialObjective?.type;

    if (type === 'red_light') {
        const y = Math.round(me.y);
        if (y % 2 === 0) {
            if (isWalkable(me.x, y + 1)) {
                console.log(`[intentionAgent] Red-light: move to odd row y=${y + 1}`);
                return createIntention('go_to', null, { x: me.x, y: y + 1 }, 0);
            }
            if (isWalkable(me.x, y - 1)) {
                console.log(`[intentionAgent] Red-light: move to odd row y=${y - 1}`);
                return createIntention('go_to', null, { x: me.x, y: y - 1 }, 0);
            }
        }
        console.log(`[intentionAgent] Red-light: on odd row y=${y}, waiting`);
        const wait = createIntention('wait', null, null, 0);
        wait._redLightWait = true;
        return wait;
    }

    if (type === 'neighborhood_meet') {
        const rule = llmMemory.specialObjective;
        const dist = manhattanDistance(me, { x: rule.x, y: rule.y });
        if (dist > rule.maxDist) {
            console.log(`[intentionAgent] Neighborhood meet: go to (${rule.x},${rule.y}) dist=${dist}`);
            return createIntention('go_to', null, { x: rule.x, y: rule.y }, 0);
        }
        console.log(`[intentionAgent] Neighborhood meet: at (${me.x},${me.y}) within range, waiting`);
        return createIntention('wait', null, null, 0);
    }

    if (type !== 'drop_leftmost') return null;

    if (beliefs.me.carrying.length > 0) {
        const target = getLeftmostReachableTile(me);
        if (!target) return null;
        console.log(`[intentionAgent] Special objective drop_leftmost → go_putdown (${target.x},${target.y})`);
        return markOperatorObjective(createIntention('go_putdown', null, target, 0));
    }

    const pickup = findBestPickUp(me, {
        allowOutOfZone: true,
        minScore: -Infinity,
        log: false,
    });
    if (pickup) {
        console.log(`[intentionAgent] Special objective drop_leftmost → ${pickup.type} (${pickup.parcelId})`);
        return markOperatorObjective(pickup);
    }

    return null;
}

/**
 * Asks the LLM for the best next intention.
 *
 * The LLM is given the map, the current state and the intention tools, and it
 * replies by calling one tool. That call is executed locally to produce the
 * Intention. On any failure we fall back to the deterministic heuristic.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntention() {
    // Position unknown: nothing the LLM can reason about yet.
    if (beliefs.me.x === null || beliefs.me.y === null) {
        return createIntention('wait', null, null, 0);
    }

    const me = { x: beliefs.me.x, y: beliefs.me.y };
    const snapshot = buildStateSnapshot(me);
    const specialIntention = getSpecialObjectiveIntention(me);
    if (specialIntention) return specialIntention;

    const constraintBlock = llmMemory.constraints.length > 0
        ? `Constraints (NEVER violate these):\n${llmMemory.constraints.map((c) => `- ${c}`).join('\n')}\n\n`
        : '';

    const userContent =
        constraintBlock +
        (llmMemory.objective ? `Operator objective: ${llmMemory.objective}\n\n` : '') +
        `Map (legend in the system prompt):\n${buildGridMap()}\n\n` +
        `State:\n${JSON.stringify(snapshot, null, 2)}`;

    try {
        const response = await llmClient.chat.completions.create({
            model: MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userContent },
            ],
            tools: INTENTION_TOOLS,
            tool_choice: 'required',
            temperature: 0,
        });

        const toolCall = response.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall) {
            console.log('[intentionAgent] LLM returned no tool call → heuristic fallback');
            return getBestIntention();
        }

        // Raw function the model asked us to call (name + arguments as sent).
        console.log(
            `[intentionAgent] LLM function call: ${toolCall.function?.name}(${toolCall.function?.arguments ?? ''})`
        );

        const name = toolCall.function?.name;
        const impl = TOOL_IMPL[name];
        if (!impl) {
            console.log(`[intentionAgent] Unknown tool "${name}" → heuristic fallback`);
            return getBestIntention();
        }

        let args = {};
        try {
            args = toolCall.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        } catch {
            args = {};
        }

        const intention = impl(args, me);
        if (!intention) {
            console.log(`[intentionAgent] Tool "${name}" not applicable now → heuristic fallback`);
            return getBestIntention();
        }
        if (llmMemory.objective || llmMemory.specialObjective) {
            markOperatorObjective(intention);
        }

        console.log(
            `[intentionAgent] LLM chose ${name}` +
                (intention.parcelId ? ` (${intention.parcelId})` : '') +
                ` score=${intention.score.toFixed(1)}`
        );
        return intention;
    } catch (err) {
        console.log(`[intentionAgent] LLM error (${err.message}) → heuristic fallback`);
        return getBestIntention();
    }
}
