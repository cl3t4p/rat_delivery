/**
 * pddlPlanner.js
 *
 * PDDL planner wrapper for movement intentions.
 */

import { onlineSolver } from '@unitn-asa/pddl-client';
import { beliefs, isWalkable, canTraverse } from '../bdi/beliefs.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */

const __dirname = dirname(fileURLToPath(import.meta.url));
const domainFile = readFileSync(join(__dirname, 'domain.pddl'), 'utf8');

const PDDL_TIMEOUT_MS = 5000;

/**
 * Plans a sequence of moves with PDDL to reach the intention target.
 *
 * First tries a no-push route, then enables crate pushing only if needed.
 *
 * @param {Intention} intention
 * @returns {Promise<Direction[]>} Array of moves, or an empty array if planning fails.
 */
export async function planWithPDDL(intention) {
    // No fallback here: a bad target should fail before crate pushing is tried.
    const clear = await solveProblem(intention, { pushCrates: false, allowFallback: false });
    if (clear !== null) return clear;

    // Only push when walking around the crate is impossible.
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
            `[pddl] buildProblem returned null for ${intention.type}, target=${intention.parcelId ?? ''} (pushCrates=${options.pushCrates})`
        );
        return null;
    }

    try {
        console.log(
            `[pddl] calling solver for ${intention.type}, target=(${intention.targetPos.x},${intention.targetPos.y}) (pushCrates=${options.pushCrates})`
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
    //Do I even have somewhere to go? No target, no plan.
    if (!intention?.targetPos) return null;

    //Do I know where I am? If I'm lost there's no tile to plan from.
    const me = beliefs.me;
    if (me.x === null || me.y === null) return null;

    const agentName = 'me';
    const mx = Math.round(me.x);
    const my = Math.round(me.y);

    //Get tiles blocked by other agents
    const blocked = blockedTiles();
    const crateKeys = new Set(beliefs.crates.keys());
    const tiles = new Set();
    tiles.add(`${mx},${my}`);

    for (const [key] of beliefs.grid) {
        if (blocked.has(key)) continue;

        //If I can't push, should I treat this crate as a wall and leave its tile out?
        if (!pushCrates && crateKeys.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        if (!isWalkable(x, y, false)) continue;
        tiles.add(key);
    }

    //Am I allowed to push crates? Then which ones can I actually shove around?
    const crates = [];
    if (pushCrates) {
        for (const key of beliefs.crates.keys()) {
            if (!tiles.has(key)) continue;
            const [x, y] = key.split(',').map(Number);
            crates.push({ name: `c_${x}_${y}`, x, y });
        }
    }

    const tileNames = [...tiles].map((k) => `t_${k.replace(',', '_')}`);
    const crateNames = crates.map((c) => c.name);
    const parcelNames = [];
    for (const id of me.carrying) parcelNames.push(`p_${id}`);

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
        //Where can a crate I push come to rest? Only on crate-slot tiles.
        if (tile?.type === '5' || tile?.type === '5!') init.push(`(crate-slot ${tName})`);
    }

    //From each tile, which way can I actually step? One-way constraints are baked in here.
    for (const key of tiles) {
        const [x, y] = key.split(',').map(Number);
        const from = `t_${x}_${y}`;

        addEdge(init, from, x, y, x + 1, y, 'right', tiles);
        addEdge(init, from, x, y, x - 1, y, 'left', tiles);
        addEdge(init, from, x, y, x, y + 1, 'up', tiles);
        addEdge(init, from, x, y, x, y - 1, 'down', tiles);
    }

    //Which tiles have a crate on them that I must push through, not walk through?
    for (const c of crates) {
        const tName = `t_${c.x}_${c.y}`;
        init.push(`(crate ${c.name})`);
        init.push(`(at ${c.name} ${tName})`);
        init.push(`(occupied ${tName})`);
    }

    for (const id of me.carrying) {
        init.push(`(parcel p_${id})`);
        init.push(`(carrying ${agentName} p_${id})`);
    }

    //Is my target bogus or unreachable? Then should I fall back to just exploring?
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
 * Builds the goal and adds pickup parcel facts when needed.
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
    if (
        intention.type === 'explore' ||
        intention.type === 'go_to' ||
        intention.type === 'drop' ||
        intention.type === 'go_handoff' ||
        intention.type === 'go_handoff_receive'
    ) {
        const t = intention.targetPos;
        const tx = Math.round(t.x),
            ty = Math.round(t.y);
        //Can I even stand on that tile? If it's not reachable, give up.
        if (!tiles.has(`${tx},${ty}`)) return null;
        return `(at ${agentName} t_${tx}_${ty})`;
    }
    return null;
}

/**
 * Builds a fallback goal toward the nearest spawner.
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
        if (x === mx && y === my) continue;
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
 * Adds a traversable edge to the PDDL init facts.
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
 * Dynamic blockers that cannot be displaced.
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
/**
 * Converts planner actions into executor directions.
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
            // Pickup and putdown are handled by the executor at the target.
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
