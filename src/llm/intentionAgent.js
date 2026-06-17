/**
 * intentionAgent.js
 *
 * The LLM layer sits ON TOP of the deterministic BDI. On a normal tick (no
 * special mission) generateBestIntention hands straight to getBestIntention, so
 * routine collecting / delivering / exploring is pure, reliable BDI and the model
 * is never called. The LLM only takes over while the "missions" list is non-empty:
 * it interprets each special mission, installs a rule / answers / does a one-off
 * action, resolves it, and then releases control back to the BDI the same tick.
 * The BDI honours the rules the LLM installs (stack size, pickup cap, delivery
 * multipliers, blacklist), so a level-2 mission reshapes ordinary play.
 *
 * The tools are deliberately few:
 *
 *   ACTIONS — turn into a concrete Intention the executor runs
 *     (go_pick_up, deliver, drop_at, go_to, wait). deliver auto-routes to the
 *     best (nearest, highest-reward) delivery tile; drop_at places a parcel on a
 *     specific tile for a mission. There is no explore tool — the LLM explores by
 *     calling go_to toward a spawner or an unexplored area itself.
 *
 *   PERSISTENT RULES (level-2 missions) — set_stack_rule (deliver in stacks of N
 *     for a given reward multiplier), set_max_pickup (skip parcels above a reward), set_delivery_reward
 *     (per-tile delivery multiplier; 0 = never deliver there), blacklist_tile
 *     (never enter a cell). Each stays active for the match and reshapes the
 *     pick-up / deliver behaviour; the action tools honour them every tick.
 *
 *   MISSIONS / CHAT — read and answer the special missions sent over the
 *     Deliveroo chat (send_message, resolve_mission): "move to (4,7)",
 *     "what is the capital of Italy?", "calculate 5*5". The model computes the
 *     answer itself, sends it, and clears the mission.
 */

import { beliefs, manhattanDistance, isWalkable, blacklistCell } from '../bdi/beliefs.js';
import { costToReachPath } from '../bdi/helper.js';
import { createIntention, getBestIntention } from '../bdi/deliberation.js';
import { findNearestDeliveryTile, findSpawnerTiles } from '../bdi/components/tilesearch.js';
import { llmClient, llmMemory, notifyMissionsChanged, getStackMultiplier, getBestStackTarget } from './llmAgent.js';
import { pickupValue, deliveryValue } from '../bdi/scoring.js';
import { sendBroadcast, MSG_TYPE } from '../multi/communication.js';

const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Position} Position */

// Returned by side effect tools (send/resolve/freeze) that change memory but
// produce no movement. It tells the deliberation loop to ask the model again
// this same tick, with the updated state, so it still ends on a real action.
const CONTINUE = Symbol('continue');

// Upper bound on model rounds per tick. Side-effect tools and not-applicable
// retries each consume a round; a few rounds let the model recover within a tick
// (e.g. answer a mission, then choose an action).
const MAX_ROUNDS = 4;

// The target of the last go_to we committed, kept so that once the agent arrives
// we can tell the (stateless-per-tick) model it has reached that cell, instead of
// it forgetting and re-routing to the same place.
/** @type {Position|null} */
let _lastGoToTarget = null;
// Set for one tick when the agent has just reached its last go_to target; shown
// to the model in buildUserContent so it knows that move is done.
let _reachedNote = '';

const INTENTION_TOOLS = [
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
            name: 'go_to',
            description:
                'Walk to a specific walkable cell (x,y) without picking up or delivering. Use it for ' +
                'atomic missions like "move to coordinate (4,7)", AND to explore: when there is no ' +
                'parcel worth picking up and nothing to deliver, go_to a spawner tile (type 1) or an ' +
                'unknown/distant area to find new parcels. If the cell is a wall or off-map it is ' +
                'snapped to the nearest reachable walkable tile.',
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
            name: 'drop_at',
            description:
                'Walk to (x,y) and put the carried parcels down there. Drop on a DELIVERY tile ' +
                '(type 2) to score normally — YOU pick which delivery tile, usually the nearest ' +
                'reachable one from deliveryTiles. Drop on any other tile to fulfil a mission that ' +
                'asks to place a parcel somewhere (earns no normal score). With no x,y it drops on ' +
                'the current cell. Only valid while carrying.',
            parameters: {
                type: 'object',
                properties: {
                    x: {
                        type: 'integer',
                        description: 'Optional: target cell x (omit to drop here).',
                    },
                    y: {
                        type: 'integer',
                        description: 'Optional: target cell y (omit to drop here).',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'wait',
            description:
                'Stay in place this turn. ONLY when paused, or when literally no other tool can run. ' +
                'If you are not carrying and have nothing to pick up, do NOT wait — go_to a spawner ' +
                'or another area to explore. Idling on a delivery tile is never correct.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'blacklist_tile',
            description:
                'Permanently mark a cell (x,y) as off-limits: the agent will never walk through or ' +
                'target it for the rest of the match, and paths route around it. Use it for missions ' +
                'or rules like "never go through (x,y)" / "avoid that tile". The tile then appears in ' +
                'the blacklist in state.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Tile x to blacklist.' },
                    y: { type: 'integer', description: 'Tile y to blacklist.' },
                },
                required: ['x', 'y'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_stack_rule',
            description:
                'Install a stacking-reward rule: the agent must carry exactly `size` parcels before ' +
                'delivering, and earns `multiplier`× the normal reward. Multiple rules accumulate — ' +
                'e.g. size=4→2× and size=5→0.3× can both be active; the agent targets the most ' +
                'profitable combination automatically. Stays active for the rest of the match.',
            parameters: {
                type: 'object',
                properties: {
                    size: {
                        type: 'integer',
                        description: 'Required parcel count (>=2).',
                    },
                    multiplier: {
                        type: 'number',
                        description: 'Reward multiplier applied when delivering exactly `size` parcels.',
                    },
                },
                required: ['size', 'multiplier'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_max_pickup',
            description:
                'Install a pickup cap: never collect a parcel whose reward exceeds N. Use for rules ' +
                'like "parcels with score above 10 give no reward". Capped parcels vanish from ' +
                'freeParcels. Pass value=N (>=0 to set, negative to clear). Stays active all match.',
            parameters: {
                type: 'object',
                properties: {
                    value: {
                        type: 'integer',
                        description: 'Max pickup reward (>=0 to set, negative to clear).',
                    },
                },
                required: ['value'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_delivery_reward',
            description:
                'Set a reward multiplier for delivering on the delivery tile (x,y). Use for rules ' +
                'like "delivering in (x,y) gives 5x" (multiplier=5) or "delivering in (x,y) gives 0 ' +
                'pts" (multiplier=0 — the agent then never delivers there). Stays active all match.',
            parameters: {
                type: 'object',
                properties: {
                    x: { type: 'integer', description: 'Delivery tile x.' },
                    y: { type: 'integer', description: 'Delivery tile y.' },
                    multiplier: {
                        type: 'number',
                        description: 'Reward multiplier (0 = never deliver there).',
                    },
                },
                required: ['x', 'y', 'multiplier'],
            },
        },
    },
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
                    reason: {
                        type: 'string',
                        description:
                            'Short reason this mission is being dropped (e.g. "done", "negative ' +
                            'reward", "junk / not a real task").',
                    },
                },
                required: ['index', 'reason'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'command_peer',
            description:
                'Send a task command to the teammate agent (Agent A). YOU are Agent B — only use ' +
                'this when the mission is explicitly addressed to Agent A (your teammate, NOT you). ' +
                'e.g. "Agent A go to (x,y)". DO NOT use go_to for these; use command_peer instead. ' +
                'Supported actions: go_to. Set pauseAfter=true to keep Agent A paused at the ' +
                'destination (use for "red light / green light" game so A stays on the odd row).',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['go_to'],
                        description: 'The task to delegate to the peer.',
                    },
                    x: { type: 'integer', description: 'Target x coordinate (required for go_to).' },
                    y: { type: 'integer', description: 'Target y coordinate (required for go_to).' },
                    pauseAfter: {
                        type: 'boolean',
                        description:
                            'If true, Agent A will re-pause at the destination instead of resuming ' +
                            'normal play. Use for "red light" game to keep A on the odd row.',
                    },
                },
                required: ['action', 'x', 'y'],
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
    /** @returns {Intention|null} */
    go_pick_up(args, me) {
        const parcel = args?.parcelId ? beliefs.parcels.get(args.parcelId) : null;
        if (!parcel || parcel.carriedBy) return null;

        // Pickup cap rule: high-reward parcels give no reward, so never collect them.
        const cap = llmMemory.maxPickupReward;
        if (cap != null && parcel.reward > cap) return null;

        const deliveryTile = findNearestDeliveryTile({ x: parcel.x, y: parcel.y });
        let score = parcel.reward;
        if (deliveryTile) score = pickupValue(parcel, me, deliveryTile);
        return createIntention('go_pick_up', parcel.id, { x: parcel.x, y: parcel.y }, score);
    },

    /** @returns {Intention|null} */
    drop_at(args, me) {
        if (beliefs.me.carrying.length === 0) return null;

        const x = Number(args?.x);
        const y = Number(args?.y);

        let target = null;
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            target = { x: me.x, y: me.y }; // no coordinates: drop on the current cell
        } else if (isWalkable(x, y)) {
            target = { x, y };
        } else {
            target = nearestReachableWalkable(me, x, y);
        }
        if (!target) return null;

        // Stacking rule: refuse to deliver on a delivery tile until carrying the
        // required number of parcels — unless we are already at the carry cap or no
        // more parcels are reachable, so the agent never gets stuck holding a partial
        // stack with nothing left to collect.
        const onDelivery = beliefs.deliveryTiles.some((t) => t.x === target.x && t.y === target.y);
        if (onDelivery) {
            // Tile-reward rule: never deliver on a tile worth nothing (multiplier <= 0).
            const mult = llmMemory.deliveryRewards[`${target.x},${target.y}`];
            if (mult != null && mult <= 0) return null;

            // Stack rules: refuse to deliver until the best target stack size is reached,
            // unless at the carry cap or no more parcels are reachable.
            if (llmMemory.stackRules.size > 0) {
                const cap = beliefs.config.MAX_PARCELS ?? 1;
                const bestTarget = getBestStackTarget(cap);
                const carrying = beliefs.me.carrying.length;
                if (bestTarget !== null && carrying < bestTarget && carrying < cap && hasReachableFreeParcel(me)) {
                    return null;
                }
            }
        }

        return createIntention('drop', null, target, dropScore(me, target));
    },

    /** @returns {Intention|null} */
    go_to(args, me) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

        let target = null;
        if (isWalkable(x, y)) target = { x, y };
        else target = nearestReachableWalkable(me, x, y);
        if (!target) return null;
        if (manhattanDistance(me, target) === 0) return null; // already there

        // If the target is permanently occupied by a paused peer, the executor will
        // loop forever yielding to the blocker without ever reaching the cell.
        // Return null so the model is forced to choose a different destination.
        const blockedByPeer = [...beliefs.agents.values()].some(
            (a) => !a.stale && Math.round(a.x) === target.x && Math.round(a.y) === target.y
        );
        if (blockedByPeer) return null;

        return createIntention('go_to', null, target, 0);
    },

    /** @returns {Intention} */
    wait() {
        return createIntention('wait', null, null, 0);
    },

    /** @returns {Intention | typeof CONTINUE} */
    blacklist_tile(args) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        if (!Number.isInteger(x) || !Number.isInteger(y)) {
            return createIntention('wait', null, null, 0);
        }
        blacklistCell(x, y);
        console.log(`[intentionAgent] blacklisted tile (${x},${y})`);
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    set_stack_rule(args) {
        const size = Number(args?.size);
        const multiplier = Number(args?.multiplier);
        if (Number.isInteger(size) && size >= 2 && Number.isFinite(multiplier)) {
            llmMemory.stackRules.set(size, multiplier);
            console.log(`[intentionAgent] stackRule size=${size} multiplier=${multiplier}`);
        }
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    set_max_pickup(args) {
        const value = Number(args?.value);
        if (Number.isFinite(value) && value >= 0) {
            llmMemory.maxPickupReward = value;
        } else {
            llmMemory.maxPickupReward = null;
        }
        console.log(`[intentionAgent] maxPickupReward=${llmMemory.maxPickupReward}`);
        return CONTINUE;
    },

    /** @returns {typeof CONTINUE} */
    set_delivery_reward(args) {
        const x = Number(args?.x);
        const y = Number(args?.y);
        const multiplier = Number(args?.multiplier);
        if (Number.isInteger(x) && Number.isInteger(y) && Number.isFinite(multiplier)) {
            llmMemory.deliveryRewards[`${x},${y}`] = multiplier;
            console.log(`[intentionAgent] deliveryReward (${x},${y})=${multiplier}`);
        }
        return CONTINUE;
    },

    /** @returns {Intention | typeof CONTINUE} */
    send_message(args) {
        const text = String(args?.text ?? '').trim();
        const mission = missionAt(args?.resolveIndex);

        if (text && typeof llmMemory.sendMessage === 'function') {
            // When answering a mission, route the reply back to whoever sent it;
            // otherwise honour the requested 'peer' / 'all' target.
            let to = 'all';
            if (mission?.from) to = mission.from;
            else if (args?.to === 'peer') to = 'peer';
            llmMemory.sendMessage(text, to);
            console.log(`[intentionAgent] send_message (${to}): "${text}"`);
        }

        // Resolving in the same step prevents answering the same mission twice. We
        // only re-deliberate when something actually changed (a mission removed);
        // otherwise we wait, so a temperature-0 model doesn't repeat the send.
        if (removeMission(args?.resolveIndex, 'answered')) return CONTINUE;
        return createIntention('wait', null, null, 0);
    },

    /** @returns {Intention | typeof CONTINUE} */
    resolve_mission(args) {
        if (removeMission(args?.index, args?.reason)) return CONTINUE;
        return createIntention('wait', null, null, 0);
    },

    /** @returns {typeof CONTINUE} */
    command_peer(args) {
        const action = args?.action;
        if (action === 'go_to') {
            const x = Number(args?.x);
            const y = Number(args?.y);
            if (!Number.isInteger(x) || !Number.isInteger(y)) {
                return createIntention('wait', null, null, 0);
            }
            const pauseAfter = !!args?.pauseAfter;
            sendBroadcast(MSG_TYPE.PEER_COMMAND, { action: 'go_to', x, y, pauseAfter }).catch(() => {});
            console.log(`[intentionAgent] command_peer go_to (${x},${y}) pauseAfter=${pauseAfter}`);
        }
        return CONTINUE;
    },
};

/**
 * Score for a drop. Dropping on a delivery tile earns the normal delivery value;
 * dropping anywhere else (a mission placement) scores nothing in the game, so the
 * intention carries 0 and never out-prioritises real scoring work.
 *
 * @param {Position} me
 * @param {Position} target - The cell the parcels will be dropped on.
 * @returns {number}
 */
function dropScore(me, target) {
    const onDelivery = beliefs.deliveryTiles.some((t) => t.x === target.x && t.y === target.y);
    if (!onDelivery) return 0;
    return deliveryValue(beliefs.me.carrying, me, target);
}

/**
 * True when there is at least one free, positive-reward parcel the agent can
 * actually path to. Used by the stacking rule so we only hold out for a fuller
 * stack while more parcels are genuinely collectable.
 *
 * @param {Position} me
 * @returns {boolean}
 */
function hasReachableFreeParcel(me) {
    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy || p.reward <= 0) continue;
        if (costToReachPath(me, { x: p.x, y: p.y }) != null) return true;
    }
    return false;
}

/**
 * Picks the best delivery tile for the carried parcels: the reachable tile with
 * the highest multiplier-weighted delivery value. deliveryValue already nets out
 * distance/decay, so this favours the nearest tile and the per-tile reward rule
 * (set_delivery_reward) lifts bonus tiles and excludes 0-reward ones.
 *
 * @param {Position} me
 * @returns {Position|null}
 */
function chooseBestDeliveryTile(me) {
    const stackMult = getStackMultiplier(beliefs.me.carrying.length);
    let best = null;
    let bestScore = -Infinity;
    for (const tile of beliefs.deliveryTiles) {
        let tileMult = llmMemory.deliveryRewards[`${tile.x},${tile.y}`];
        if (tileMult == null) tileMult = 1;
        if (tileMult <= 0) continue; // never deliver on a zero/negative tile
        if (costToReachPath(me, tile) == null) continue; // unreachable
        const value = deliveryValue(beliefs.me.carrying, me, tile) * tileMult * stackMult;
        if (value > bestScore) {
            bestScore = value;
            best = { x: tile.x, y: tile.y };
        }
    }
    return best;
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
 * Removes the mission at `index`. Returns true if one was removed. The reason is
 * logged so it is always clear WHY a mission was dropped.
 *
 * @param {unknown} index
 * @param {unknown} [reason]
 * @returns {boolean}
 */
function removeMission(index, reason) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= llmMemory.missions.length) return false;
    const prevLen = llmMemory.missions.length;
    const [removed] = llmMemory.missions.splice(i, 1);
    let why = String(reason ?? '').trim();
    if (!why) why = 'no reason given';
    console.log(`[intentionAgent] resolved mission: "${removed?.text ?? ''}" — reason: ${why}`);
    notifyMissionsChanged(prevLen, llmMemory.missions.length);
    return true;
}

/**
 * Deterministic handler for the handoff-bonus mission.
 *
 * The server broadcasts a chat message explaining the +200 bonus for cross-agent
 * pickup+delivery. This is a passive game rule — no action is required because the
 * BDI already incorporates the bonus into handoff scoring. We resolve any matching
 * mission immediately so the LLM never sees it (at temperature=0 it misclassifies
 * it as "negative reward" or junk, which is harmless but confusing).
 *
 * Returns an Intention (from the BDI) when a match is found, null to fall through.
 *
 * @param {{ x: number, y: number }} me
 * @returns {import('../shared/types.js').Intention|null}
 */
function handleHandoffBonusMission(me) {
    const idx = llmMemory.missions.findIndex(
        (m) =>
            /initially picked up by one agent/i.test(m.text) ||
            (/200\s*points?\s*bonus/i.test(m.text) && /deliver/i.test(m.text))
    );
    if (idx < 0) return null;

    beliefs.me.handoffBonusActive = true;
    sendBroadcast(MSG_TYPE.PEER_COMMAND, { action: 'handoff_bonus_active' }).catch(() => {});
    removeMission(idx, 'handled by BDI handoff scoring — +200 bonus now active');
    console.log('[intentionAgent] Handoff bonus mission resolved; +200 bonus activated in BDI scoring and notified peer');
    return llmMemory.missions.length === 0 ? getBestIntention() : null;
}

/**
 * Deterministic handler for the STOP/GO ("red light / green light") game.
 *
 * The LLM at temperature=0 misclassifies short keyword messages ("red light",
 * "green light") as junk. This function runs BEFORE the LLM call and handles
 * the pattern with a simple regex, making the game reliable.
 *
 * STOP trigger: message contains "red light" OR ("odd row/numbered" + "wait")
 * GO   trigger: message contains "green light" but NOT "red light" (to exclude
 *               the challenge message that says "red light, green light game"),
 *               or a simple go/resume/start keyword when a STOP is pending.
 *
 * Returns an Intention when a signal is found, null to fall through to the LLM.
 *
 * @param {{ x: number, y: number }} me
 * @returns {import('../shared/types.js').Intention|null}
 */
function handleStopGoGame(me) {
    const isOdd = (y) => Math.round(y) % 2 !== 0;

    const stopIdx = llmMemory.missions.findIndex(
        (m) =>
            /red[\s_-]*light/i.test(m.text) ||
            (/odd[\s-]*(row|numbered)/i.test(m.text) && /wait/i.test(m.text))
    );

    // GO matches green-light-only messages, or simple resume keywords when STOP is pending.
    // Explicitly excludes the challenge message which contains both "red light" and "green light".
    const goIdx = llmMemory.missions.findIndex(
        (m, i) =>
            i !== stopIdx &&
            !/red[\s_-]*light/i.test(m.text) &&
            (/green[\s_-]*light/i.test(m.text) ||
                (stopIdx >= 0 && /\b(go|start|resume|continue|proceed)\b/i.test(m.text)))
    );

    if (goIdx >= 0) {
        // Game resumed: clear both missions, unpause peer, hand back to BDI.
        const toRemove = [goIdx, stopIdx >= 0 ? stopIdx : -1]
            .filter((i) => i >= 0)
            .sort((a, b) => b - a); // remove from the end so indices stay valid
        for (const i of toRemove) removeMission(i, 'stop-go game resumed');
        sendBroadcast(MSG_TYPE.PEER_COMMAND, { action: 'resume' }).catch(() => {});
        console.log('[intentionAgent] STOP/GO: game resumed, handing back to BDI');
        return llmMemory.missions.length === 0 ? getBestIntention() : null;
    }

    if (stopIdx >= 0) {
        const myY = Math.round(me.y);
        const myX = Math.round(me.x);

        if (isOdd(myY)) {
            // Already frozen on an odd row — stay put.
            return createIntention('wait', null, null, 0);
        }

        // Choose the nearest odd row for self, skipping peer-occupied cells.
        const selfCandidates = [myY + 1, myY - 1].filter(
            (y) => isOdd(y) && isWalkable(myX, y)
        );
        const myOddY =
            selfCandidates.find(
                (y) =>
                    ![...beliefs.agents.values()].some(
                        (a) => !a.stale && Math.round(a.x) === myX && Math.round(a.y) === y
                    )
            ) ?? selfCandidates[0];

        if (myOddY == null) return createIntention('wait', null, null, 0);

        // Command peer to move to its nearest odd row (only if not already on one).
        const peers = [...beliefs.agents.values()].filter((a) => !a.stale);
        if (peers.length > 0) {
            const peerA = peers[0];
            const peerX = Math.round(peerA.x);
            const peerY = Math.round(peerA.y);
            if (!isOdd(peerY)) {
                const peerCandidates = [peerY + 1, peerY - 1].filter(
                    (y) => isOdd(y) && isWalkable(peerX, y)
                );
                if (peerCandidates.length > 0) {
                    sendBroadcast(MSG_TYPE.PEER_COMMAND, {
                        action: 'go_to',
                        x: peerX,
                        y: peerCandidates[0],
                        pauseAfter: true,
                    }).catch(() => {});
                    console.log(
                        `[intentionAgent] STOP/GO: commanding peer to odd row (${peerX},${peerCandidates[0]})`
                    );
                }
            }
        }

        console.log(`[intentionAgent] STOP/GO: moving self to odd row (${myX},${myOddY})`);
        return createIntention('go_to', null, { x: myX, y: myOddY }, 0);
    }

    return null; // no STOP/GO signal found
}

const SYSTEM_PROMPT = `
Deliveroo.js special-mission handler. Routine play — collecting, delivering and exploring parcels
— is done automatically by another module. You are called ONLY to handle the special missions in
the "missions" list. Do NOT play normally (no exploring, no routine delivering). Each tick call
EXACTLY ONE tool, never prose.

IDENTITY: YOU are Agent B (the coordinator). Agent A is your teammate (the peer). Never confuse
the two: "Agent B" or "you" = yourself; "Agent A" or "teammate" = the other agent.

MAP cells: 0=wall, 1=spawner, 2=delivery, 3=floor, .=unknown. (x,y): x=column (0=leftmost),
y=row (0=bottom; grid printed top=highest y). maxX/maxY = largest x/y on the map.

STATE: me; freeParcels; deliveryTiles; spawners; blacklist; world.maxCarry; plus the active rules.

Handle ONE mission per tick: pick the single tool that satisfies it, then resolve_mission(index, reason).
- "Agent A go to (x,y)" / mission targeting Agent A (your teammate, NOT you) -> command_peer(action='go_to', x, y), then resolve.
- "Agent B go to (x,y)" / mission targeting YOU (you are Agent B) -> go_to(x,y), resolve once there.
- "move to (x,y)" / go to a coordinate with no agent named (targeting YOU) -> go_to(x,y). Evaluate math (e.g. 4*2) yourself. Resolve once there.
- a question or calculation ("capital of Rome?", "25*25") -> send_message(answer, resolveIndex=index).
- place/drop a parcel at a SPOT ("drop in the bottom left for 1000pts") -> if not carrying, go_pick_up
  first; once carrying, drop_at(x,y) at THAT spot — bottom-left=(0,0), bottom-right=(maxX,0),
  top-left=(0,maxY), top-right=(maxX,maxY), "leftmost"=x=0. A wall corner auto-snaps to the nearest
  cell, so just pass the corner. Resolve only AFTER the drop.
- "deliver stacks of N for Kx" / "N parcels gives Kx" -> set_stack_rule(N, K), then resolve. Rules accumulate; agent picks the best target.
- "parcels with score/reward above N give no reward" -> set_max_pickup(N), then resolve.
- "delivering in (x,y) gives Kx / 0 pts" -> set_delivery_reward(x,y,K) (0 = never deliver there), then resolve.
- "never go through / avoid tile (x,y)" -> blacklist_tile(x,y), then resolve.
- coordination ("both agents near (x,y) and wait"):
  • NOT yet at (x,y): command_peer(action='go_to', x, y) then go_to(x, y).
  • ALREADY at (x,y) — go_to was not applicable: resolve_mission(index). Do NOT command_peer again.
- STOP/GO game (a "red light / green light"-style challenge where agents must freeze on odd rows then
  resume). Identify the type by keywords:
  STOP keywords: "red light", "stop", "halt", "freeze", "pause" — and similar meanings.
  GO   keywords: "green light", "go", "start", "resume", "continue", "proceed" — and similar meanings.
  "red" and "stop" = STOP. "green" and "go" = GO. Never confuse the two directions.

  When you see a STOP mission (and no GO mission alongside it):
    ODD row = y%2==1 (e.g. y=1,3,5,7,...).
    Step A — check your own row:
      • me.y is ODD  → you are already frozen on an odd row. call wait. DO NOT resolve. Done for this tick.
      • me.y is EVEN → you must move one row. my_odd_y = me.y+1 if walkable else me.y-1.
        Step B — command Agent A (use A's OWN coordinates, NOT yours):
          If otherAgents is non-empty: A = otherAgents[0].
            A_odd_y = A.y+1 if walkable else A.y-1.
            call command_peer(action='go_to', x=A.x, y=A_odd_y, pauseAfter=true).
            NOTE: A.x ≠ me.x in general — A will go to its own nearest odd row, you go to yours.
        Step C — move yourself: go_to(x=me.x, y=my_odd_y). This is your return action. DO NOT resolve.

  When you see a GO mission:
    • Also a STOP mission is in the list → the freeze ends. Resolve GO first, then STOP:
        resolve_mission(<GO index>, "game resumed")
        resolve_mission(<STOP index>, "game resumed")
      Agents auto-resume normal play.
    • No STOP mission in the list → GO arrived out of order or duplicated. resolve_mission(<GO index>, "junk — no stop pending").
- negative/zero reward, or junk -> resolve_mission and nothing else.

set_stack_rule, set_max_pickup, set_delivery_reward and blacklist_tile are INSTANT, free rule
installs — just call the tool, then resolve. Never resolve a positive mission before you finish it;
never answer the same mission twice; never target a wall/blacklisted/off-map cell.
`.trim();

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
 * @param {Position} me
 * @returns {object}
 */
function buildStateSnapshot(me) {
    return {
        me: {
            x: me.x,
            y: me.y,
            carrying: beliefs.me.carrying.length,
            carryingIds: beliefs.me.carrying,
        },
        freeParcels: [...beliefs.parcels.values()]
            .filter((p) => {
                if (p.carriedBy || p.reward <= 0) return false;
                const cap = llmMemory.maxPickupReward;
                return cap == null || p.reward <= cap;
            })
            .map((p) => {
                const deliveryTile = findNearestDeliveryTile({ x: p.x, y: p.y });
                let score = -Infinity;
                if (deliveryTile) score = pickupValue(p, me, deliveryTile);
                return { id: p.id, x: p.x, y: p.y, reward: p.reward, score };
            }),
        deliveryTiles: beliefs.deliveryTiles.map((t) => ({ x: t.x, y: t.y })),
        spawners: findSpawnerTiles().map((t) => ({ x: t.x, y: t.y })),
        otherAgents: [...beliefs.agents.values()]
            .filter((a) => !a.stale)
            .map((a) => ({ x: a.x, y: a.y })),
        blacklist: [...beliefs.blacklist].map((k) => {
            const [x, y] = k.split(',').map(Number);
            return { x, y };
        }),
        stackRules: Object.fromEntries(llmMemory.stackRules),
        maxPickupReward: llmMemory.maxPickupReward,
        deliveryRewards: llmMemory.deliveryRewards,
        world: {
            maxCarry: beliefs.config.MAX_PARCELS,
        },
    };
}

/**
 * Builds the user message (missions, map, state). Rebuilt every round because
 * side-effect tools can change memory between rounds.
 *
 * @param {Position} me
 * @returns {string}
 */
function buildUserContent(me) {
    const snapshot = buildStateSnapshot(me);

    let reachedBlock = '';
    if (_reachedNote) reachedBlock = `${_reachedNote}\n\n`;

    let missionBlock = '';
    if (llmMemory.missions.length > 0) {
        const lines = llmMemory.missions.map((m, i) => `${i}: ${m.text}`).join('\n');
        missionBlock = `Special missions (index: text):\n${lines}\n\n`;
    }

    let objectiveBlock = '';
    if (llmMemory.objective) objectiveBlock = `Operator objective: ${llmMemory.objective}\n\n`;

    return (
        reachedBlock +
        missionBlock +
        objectiveBlock +
        `Map (legend in the system prompt):\n${buildGridMap()}\n\n` +
        `State:\n${JSON.stringify(snapshot)}`
    );
}

/**
 * Asks the model for the best next intention. It calls one tool per round; for a
 * side-effect tool or a not-applicable action we feed the outcome back and let it
 * choose again (up to MAX_ROUNDS) so it never loops on an impossible action.
 *
 * @returns {Promise<Intention>}
 */
export async function generateBestIntention() {
    if (beliefs.me.x === null || beliefs.me.y === null) {
        return createIntention('wait', null, null, 0);
    }

    // No special mission to interpret: hand control to the deterministic BDI, which
    // plays standard collect/deliver/explore and already honours the LLM's rules
    // (stack size, pickup cap, delivery multipliers, blacklist). The LLM is not
    // called at all on these ticks.
    if (llmMemory.missions.length === 0) return getBestIntention();

    const me = { x: beliefs.me.x, y: beliefs.me.y };

    // Deterministic STOP/GO game handler — runs before the LLM to avoid
    // unreliable keyword classification at temperature=0.
    const stopGoResult = handleStopGoGame(me);
    if (stopGoResult !== null) return stopGoResult;

    // Deterministic handoff-bonus handler: the server sends a mission explaining the
    // +200 bonus for cross-agent pickup+delivery. The BDI already accounts for this
    // (evaluateHandoff includes the bonus, deliveryValue adds it for handoff parcels).
    // Resolve immediately so the LLM never sees it and can't misclassify it.
    const handoffBonusResult = handleHandoffBonusMission(me);
    if (handoffBonusResult !== null) return handoffBonusResult;

    // If the agent has arrived at the cell its last go_to was heading to, note it
    // so the model is told the move completed (it has no memory across ticks).
    _reachedNote = '';
    if (_lastGoToTarget && me.x === _lastGoToTarget.x && me.y === _lastGoToTarget.y) {
        _reachedNote = `You have completed your last go_to and are now at (${me.x},${me.y}).`;
        _lastGoToTarget = null;
    }

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(me) },
    ];

    for (let round = 0; round < MAX_ROUNDS; round++) {
        let message;
        try {
            const response = await llmClient.chat.completions.create(
                {
                    model: MODEL,
                    messages,
                    tools: INTENTION_TOOLS,
                    tool_choice: 'required',
                    temperature: 0,
                },
                // Fail fast inside the per-tick loop: a stale decision is worse than
                // skipping this tick, and retries would stack the timeout.
                { maxRetries: 0 }
            );
            message = response.choices?.[0]?.message;
        } catch (err) {
            console.log(`[intentionAgent] LLM error (${err.message}), waiting`);
            return createIntention('wait', null, null, 0);
        }

        console.log(`[intentionAgent] LLM output (round ${round}): ${JSON.stringify(message)}`);

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

        // Side-effect tool (rule installed / message sent / mission resolved /
        // freeze toggled). If that cleared the last mission, the LLM is done — hand
        // control straight back to the BDI for the actual movement this same tick.
        // Otherwise re-state the updated situation and let the model continue.
        if (result === CONTINUE) {
            if (llmMemory.missions.length === 0) {
                console.log('[intentionAgent] missions handled, returning control to BDI');
                return getBestIntention();
            }
            feedToolResult(messages, toolCall, 'Done.');
            messages.push({ role: 'user', content: buildUserContent(me) });
            continue;
        }

        if (!result) {
            console.log(`[intentionAgent] Tool "${name}" not applicable, asking again`);
            let hint = '';
            if (name === 'go_to') {
                const lastX = (() => { try { return JSON.parse(toolCall.function?.arguments ?? '{}').x; } catch { return null; } })();
                const lastY = (() => { try { return JSON.parse(toolCall.function?.arguments ?? '{}').y; } catch { return null; } })();
                const peerThere = [...beliefs.agents.values()].some(
                    (a) => !a.stale && Math.round(a.x) === Number(lastX) && Math.round(a.y) === Number(lastY)
                );
                if (peerThere) {
                    hint = ` Cell (${lastX},${lastY}) is permanently occupied by the peer agent. Choose a DIFFERENT odd-row cell — try (${Number(lastX) - 1},${Number(lastY)}), (${Number(lastX) + 1},${Number(lastY)}), or (${Number(lastX)},${Number(lastY) + 2}).`;
                }
            } else if (name === 'drop_at' && beliefs.me.carrying.length === 0) {
                hint = ' You are not carrying any parcel — go_pick_up one first, then retry.';
            } else if (name === 'drop_at' && llmMemory.stackRules.size > 0) {
                const cap = beliefs.config.MAX_PARCELS ?? 1;
                const bestTarget = getBestStackTarget(cap);
                if (bestTarget !== null && beliefs.me.carrying.length < bestTarget) {
                    hint =
                        ` The stacking rule requires ${bestTarget} parcels before delivering and you ` +
                        `carry ${beliefs.me.carrying.length} — go_pick_up more parcels first.`;
                }
            }
            feedToolResult(
                messages,
                toolCall,
                `"${name}" cannot be executed now (target gone, already there, or unreachable). ` +
                    `Choose a different action that makes progress; do NOT resolve a worthwhile ` +
                    `mission just because a tool failed.${hint}`
            );
            continue;
        }

        // Remember a go_to target so we can confirm arrival next tick; any other
        // action means the previous go_to no longer matters.
        if (result.type === 'go_to' && result.targetPos) {
            _lastGoToTarget = { x: result.targetPos.x, y: result.targetPos.y };
        } else {
            _lastGoToTarget = null;
        }

        console.log(
            `[intentionAgent] chose ${name}` +
                (result.parcelId ? ` (${result.parcelId})` : '') +
                ` score=${result.score.toFixed(1)}`
        );
        return result;
    }

    console.log(`[intentionAgent] Max rounds (${MAX_ROUNDS}) reached, returning control to BDI`);
    return getBestIntention();
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
