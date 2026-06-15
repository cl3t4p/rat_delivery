/**
 * pddlPlanner.js
 *
 * Builds a PDDL problem from the current beliefs and calls the external planner.
 * Used by the executor to compute a sequence of moves toward an intention target.
 *
 * Structure:
 *   domainFile       - Static PDDL domain loaded from domain.pddl.
 *   planWithPDDL    - Public API used to generate a movement plan.
 *   buildProblem     - Converts beliefs and intention into a problem.pddl string.
 *   goalForIntention - Builds the PDDL goal for pickup, delivery, or exploration.
 *   blockedTiles     - Collects dynamic obstacles such as crates and active opponents.
 *   parsePlan        - Converts PDDL actions into executor directions.
 *   withTimeout      - Prevents the online solver from blocking forever.
 */

import { onlineSolver } from '@unitn-asa/pddl-client';
import { beliefs, isWalkable, canTraverse } from '../bdi/beliefs.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */

// Read domain.pddl
const __dirname = dirname(fileURLToPath(import.meta.url));
const domainFile = readFileSync(join(__dirname, 'domain.pddl'), 'utf8');

// Timeout for local solver
const PDDL_TIMEOUT_MS = 5000;

//Public API

/**
 * Plans a sequence of moves with PDDL to reach the intention target.
 *
 * Planning is done in two phases so the agent never disturbs a crate when it does
 * not have to:
 *   1. Treat crates as immovable walls and look for a clear path to the target.
 *      A regular move and a push cost the same to the planner, so without this
 *      phase it would gladly shove a crate even when an open route exists (and
 *      typically push it past the checkpoint).
 *   2. Only if no clear path exists, re-plan with the Sokoban push actions enabled
 *      so a genuinely blocking crate can be cleared.
 *
 * @param {Intention} intention
 * @returns {Promise<Direction[]>} Array of moves, or an empty array if planning fails.
 */
export async function planWithPDDL(intention) {
    // Phase 1: clear path, crates treated as walls and the spawner fallback disabled
    // so an unreachable target makes this phase fail instead of wandering off.
    const clear = await solveProblem(intention, { pushCrates: false, allowFallback: false });
    if (clear !== null) return clear;

    // Phase 2: allow pushing to clear a crate that actually blocks the only route.
    console.log('[pddl] no clear path, retrying with crate pushing enabled');
    const pushed = await solveProblem(intention, { pushCrates: true, allowFallback: true });
    return pushed ?? [];
}

/**
 * Builds the problem for the given options, runs the solver and parses the result.
 *
 * @param {Intention} intention
 * @param {{ pushCrates: boolean, allowFallback: boolean }} options
 * @returns {Promise<Direction[]|null>} Parsed moves on a successful solve, or null
 *   when the problem could not be built or the solver found no plan.
 */
async function solveProblem(intention, options) {
    const problem = buildProblem(intention, options);
    if (!problem) {
        console.log(
            `[pddl] buildProblem returned null for ${intention.type} → ${intention.parcelId ?? ''} (pushCrates=${options.pushCrates})`
        );
        return null;
    }

    try {
        console.log(
            `[pddl] calling solver for ${intention.type} → (${intention.targetPos.x},${intention.targetPos.y}) (pushCrates=${options.pushCrates})`
        );
        const plan = await withTimeout(onlineSolver(domainFile, problem), PDDL_TIMEOUT_MS);
        if (!plan || plan.length === 0) {
            console.log('[pddl] solver returned empty plan');
            return null;
        }
        const moves = parsePlan(plan);
        if (moves.length === 0)
            console.log('[pddl] parsePlan returned 0 moves (no move-* actions?)');
        return moves;
    } catch (err) {
        console.log(`[pddl] planner failed: ${err.message ?? err}`);
        return null;
    }
}

// Problem construction.

/**
 * Builds the problem.pddl string.
 * Returns null if there is not enough information in the beliefs to plan,
 * such as an unknown position or a missing parcel.
 *
 * @param {Intention} intention
 * @param {{ pushCrates?: boolean, allowFallback?: boolean }} [options]
 *   pushCrates - when false, crates are treated as immovable walls (their tiles are
 *     excluded) so the planner can only walk around them, never push them.
 *   allowFallback - when false, an invalid/unreachable target makes buildProblem
 *     return null instead of falling back to the nearest spawner.
 * @returns {string|null}
 */
function buildProblem(intention, { pushCrates = true, allowFallback = true } = {}) {
    if (!intention?.targetPos) return null;

    const me = beliefs.me;
    if (me.x === null || me.y === null) return null;

    const agentName = 'me';
    const mx = Math.round(me.x);
    const my = Math.round(me.y);

    // Build the set of walkable tiles, excluding walls and active opponents.
    // When pushCrates is true a crate is a movable obstacle handled by the Sokoban
    // `occupied` predicate, so its tile stays in the set; when false it is treated
    // as a wall and excluded so the agent can only route around it. Always include
    // the tile currently occupied by me, even if it is not marked as walkable.
    const blocked = blockedTiles();
    const crateKeys = new Set(beliefs.crates.keys());
    const tiles = new Set();
    tiles.add(`${mx},${my}`);

    for (const [key] of beliefs.grid) {
        if (blocked.has(key)) continue;
        if (!pushCrates && crateKeys.has(key)) continue; // crate treated as a wall
        const [x, y] = key.split(',').map(Number);
        if (!isWalkable(x, y)) continue;
        tiles.add(key);
    }

    // Sensed crates that sit on a tile included in the problem. Each becomes a movable
    // object the planner can push. Keyed by tile so the name is stable across calls.
    // Only emitted when pushing is enabled; otherwise crate tiles are absent entirely.
    const crates = [];
    if (pushCrates) {
        for (const key of beliefs.crates.keys()) {
            if (!tiles.has(key)) continue;
            const [x, y] = key.split(',').map(Number);
            crates.push({ name: `c_${x}_${y}`, x, y });
        }
    }

    // Define the PDDL objects: agent, tiles, parcels, and crates.
    // The target parcel for go_pick_up is added by goalForIntention only if it is still valid.
    const tileNames = [...tiles].map((k) => `t_${k.replace(',', '_')}`);
    const crateNames = crates.map((c) => c.name);
    const parcelNames = [];
    for (const id of me.carrying) parcelNames.push(`p_${id}`);

    // Init facts
    const init = [];
    init.push(`(agent ${agentName})`);
    init.push(`(me ${agentName})`);
    init.push(`(at ${agentName} t_${mx}_${my})`);

    for (const key of tiles) {
        const [x, y] = key.split(',').map(Number);
        const tName = `t_${x}_${y}`;
        init.push(`(tile ${tName})`);
        const tile = beliefs.grid.get(key);
        if (tile?.delivery) init.push(`(delivery ${tName})`);
        // Crates may only rest on crate-slot tiles: type 5 (sliding) or 5! (spawner).
        if (tile?.type === '5' || tile?.type === '5!') init.push(`(crate-slot ${tName})`);
    }

    // Add adjacency facts only when the destination is in tiles and is traversable.
    // This also enforces one-way arrow constraints.
    for (const key of tiles) {
        const [x, y] = key.split(',').map(Number);
        const from = `t_${x}_${y}`;

        addEdge(init, from, x, y, x + 1, y, 'right', tiles);
        addEdge(init, from, x, y, x - 1, y, 'left', tiles);
        addEdge(init, from, x, y, x, y + 1, 'up', tiles);
        addEdge(init, from, x, y, x, y - 1, 'down', tiles);
    }

    // Add crate facts: each sensed crate is an object on its tile, and its tile is
    // marked occupied so the agent must push it instead of walking through it.
    for (const c of crates) {
        const tName = `t_${c.x}_${c.y}`;
        init.push(`(crate ${c.name})`);
        init.push(`(at ${c.name} ${tName})`);
        init.push(`(occupied ${tName})`);
    }

    // Add parcel facts for carried parcels and, when picking up, the target parcel.
    for (const id of me.carrying) {
        init.push(`(parcel p_${id})`);
        init.push(`(carrying ${agentName} p_${id})`);
    }

    // Build the goal from the requested intention.
    // If the target is not valid or reachable, fall back to the nearest spawner tile
    // so the agent does not remain stuck waiting for a parcel.
    let goal = goalForIntention(intention, agentName, mx, my, tiles, init, parcelNames);
    if (!goal) {
        if (!allowFallback) return null;
        const fb = nearestSpawnerGoal(agentName, mx, my, tiles);
        if (!fb) return null;
        console.log(`[pddl] fallback goal: walk to nearest spawner ${fb.tag}`);
        goal = fb.goal;
    }

    const objects = [agentName, ...tileNames, ...crateNames, ...parcelNames].join(' ');
    return `(define (problem deliveroo-problem)
    (:domain deliveroo)
    (:objects ${objects})
    (:init
        ${init.join('\n        ')}
    )
    (:goal ${goal})
)`;
}

/**
 * Builds the PDDL goal for the given intention.
 *
 * Returns null if the intention has no valid target.
 * In that case, the caller uses the nearest spawner goal instead.
 *
 * For go_pick_up, this function also adds the parcel facts to init
 * and adds the parcel name to parcelNames.
 *
 * @param {Intention} intention - Intention to convert into a PDDL goal.
 * @param {string} agentName - Name of the agent in the PDDL problem.
 * @param {number} mx
 * @param {number} my
 * @param {Set<string>} tiles - Valid map tiles
 * @param {string[]} init - PDDL init facts.
 * @param {string[]} parcelNames - Names of parcels used in the problem.
 * @returns {string|null} PDDL goal, or null if no valid goal exists.
 */
function goalForIntention(intention, agentName, mx, my, tiles, init, parcelNames) {
    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const parcel = beliefs.parcels.get(intention.parcelId);
        if (!parcel) return null;
        const px = Math.round(parcel.x);
        const py = Math.round(parcel.y);
        if (!tiles.has(`${px},${py}`)) return null;
        const pName = `p_${intention.parcelId}`;
        if (!parcelNames.includes(pName)) parcelNames.push(pName);
        init.push(`(parcel ${pName})`);
        init.push(`(at ${pName} t_${px}_${py})`);
        return `(carrying ${agentName} ${pName})`;
    }
    if (intention.type === 'go_deliver') {
        if (beliefs.me.carrying.length === 0) return null;
        const drops = beliefs.me.carrying.map((id) => `(not (carrying ${agentName} p_${id}))`);
        return drops.length === 1 ? drops[0] : `(and ${drops.join(' ')})`;
    }
    if (intention.type === 'explore') {
        const t = intention.targetPos;
        const tx = Math.round(t.x),
            ty = Math.round(t.y);
        if (!tiles.has(`${tx},${ty}`)) return null;
        return `(at ${agentName} t_${tx}_${ty})`;
    }
    return null;
}

/**
 * Builds a fallback goal that moves the agent to the nearest spawner tile.
 *
 * Returns null if no spawner tile exists.
 *
 * @param {string} agentName - Name of the agent in the PDDL problem.
 * @param {number} mx - Current x position of the agent.
 * @param {number} my - Current y position of the agent.
 * @param {Set<string>} tiles - Valid map tiles.
 * @returns {{ goal: string, tag: string }|null} Fallback goal data, or null if no goal exists.
 */
function nearestSpawnerGoal(agentName, mx, my, tiles) {
    let best = null,
        bestDist = Infinity;
    for (const key of tiles) {
        const tile = beliefs.grid.get(key);
        if (!tile || tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        if (x === mx && y === my) continue; // già qui, sarebbe goal banale
        const d = Math.abs(x - mx) + Math.abs(y - my);
        if (d < bestDist) {
            bestDist = d;
            best = { x, y };
        }
    }
    if (!best) return null;
    return { goal: `(at ${agentName} t_${best.x}_${best.y})`, tag: `(${best.x},${best.y})` };
}

/**
 * Adds a movement fact to the PDDL init section if the move is valid.
 *
 * The edge represents the static map topology and is therefore crate-agnostic:
 * it is added whenever the target tile exists and is traversable (no wall, not
 * blacklisted, arrow-compatible). Crate occupancy is handled in the domain via the
 * `occupied` predicate, which both moves and pushes test at planning time.
 *
 * @param {string[]} init - PDDL init facts.
 * @param {string} fromName - Name of the starting tile.
 * @param {number} fx - Starting x position.
 * @param {number} fy - Starting y position.
 * @param {number} tx - Target x position.
 * @param {number} ty - Target y position.
 * @param {Direction} dir - Movement direction.
 * @param {Set<string>} tiles - Valid map tiles, indexed by "x,y".
 */
function addEdge(init, fromName, fx, fy, tx, ty, dir, tiles) {
    const toKey = `${tx},${ty}`;
    if (!tiles.has(toKey)) return;
    if (!canTraverse(fx, fy, tx, ty)) return;
    init.push(`(${dir} ${fromName} t_${tx}_${ty})`);
}

/**
 * Tiles that must be excluded from the problem because they are blocked by dynamic
 * entities the agent cannot displace: non-stale opponent agents.
 *
 * Crates are intentionally NOT excluded here — they are movable obstacles modelled
 * as pushable objects in the problem, not as missing tiles.
 *
 * @returns {Set<string>}
 */
function blockedTiles() {
    const blocked = new Set();
    for (const a of beliefs.agents.values()) {
        if (a.stale) continue;
        blocked.add(`${Math.round(a.x)},${Math.round(a.y)}`);
    }
    return blocked;
}
// Plan parsing.

/**
 * Converts the PDDL plan into moves for the executor.
 * move-* and push-* actions are converted into directions: a push is, from the
 * executor's point of view, just a step in that direction — the server displaces
 * the crate when the agent walks into it.
 * pick-up and put-down actions are ignored because they are handled
 * by the executor when the target is reached.
 *
 * @param {{action: string, args: string[]}[]} plan
 * @returns {Direction[]}
 */
function parsePlan(plan) {
    const moves = [];
    for (const step of plan) {
        const a = (step?.action ?? '').toLowerCase();
        switch (a) {
            case 'move-right':
            case 'push-right':
                moves.push('right');
                break;
            case 'move-left':
            case 'push-left':
                moves.push('left');
                break;
            case 'move-up':
            case 'push-up':
                moves.push('up');
                break;
            case 'move-down':
            case 'push-down':
                moves.push('down');
                break;
            // pick-up / put-down: handled by the executor when the target is reached
        }
    }
    return moves;
}

/**
 * Rejects the promise after `ms` milliseconds.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`pddl timeout (${ms}ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
