/**
 * pathfinding.js
 *
 * BFS on the Belief Store grid.
 * Returns a sequence of moves ('up', 'down', 'left', 'right')
 * ready to be consumed by the executor.
 */

import { beliefs } from './beliefs.js';
import { isWalkable, canEnter } from './grid.js';


/** @typedef {import('../shared/types.js').Position}   Position */
/** @typedef {import('../shared/types.js').Direction}  Direction */
/** @typedef {import('../shared/types.js').PathResult} PathResult */


/** @typedef {string} TileKey  chiave della griglia, formato "x,y" */
/** @typedef {{ from: TileKey, dir: Direction }} ParentLink */
/** @typedef {Map<TileKey, ParentLink | null>} Parents */
/** @typedef {{avoidAgents?: boolean}} PathOptions  default: {avoidAgents: true} */

const DEFAULT_OPTIONS = { avoidAgents: true };

/**
 * A* search using the Manhattan distance heuristic.
 *
 * @param {Position} start - Starting position.
 * @param {Position} goal - Destination tile.
 * @param {PathOptions} [options]
 * @returns {PathResult | null}
 */
export function aStar(start, goal, options = DEFAULT_OPTIONS) {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    //Number is a float
    const sx = Math.round(start.x), sy = Math.round(start.y);
    const gx = Math.round(goal.x),  gy = Math.round(goal.y);

    if (sx === gx && sy === gy) return { path: [], moves: [] };
    if (!isWalkable(gx, gy)) return null;

    const blocked = buildBlockedSet(opts.avoidAgents);
    const startKey = `${sx},${sy}`;

    /** @type {Parents} */
    const parents = new Map();
    parents.set(startKey, null);

    /** g-score: actual cost from the start node to a given node. */
    const gScore = new Map();
    gScore.set(startKey, 0);

    /** Open set: Map used for deduplication and linear scan to extract min(f). */
    const open = new Map();
    open.set(startKey, { x: sx, y: sy, f: heuristic(sx, sy, gx, gy) });

    /** @type {{dx: number, dy: number, dir: Direction}[]} */
    const neighbors = [
        { dx:  1, dy:  0, dir: 'right' },
        { dx: -1, dy:  0, dir: 'left'  },
        { dx:  0, dy:  1, dir: 'up'    },
        { dx:  0, dy: -1, dir: 'down'  },
    ];

    while (open.size > 0) {
        // Extract the node with the lowest f-score.
        let curKey = null;
        let curNode = null;
        let bestF = Infinity;
        for (const [k, node] of open) {
            if (node.f < bestF) { bestF = node.f; curKey = k; curNode = node; }
        }
        open.delete(curKey);

        if (curNode.x === gx && curNode.y === gy) {
            return reconstruct(parents, curKey, startKey);
        }

        const curG = gScore.get(curKey);

        for (const n of neighbors) {
            const nx = curNode.x + n.dx;
            const ny = curNode.y + n.dy;
            const nk = `${nx},${ny}`;

            if (!canEnter(curNode.x, curNode.y, nx, ny)) continue;
            if (blocked.has(nk)) continue;

            const tentativeG = curG + 1;
            const knownG = gScore.get(nk);
            if (knownG !== undefined && tentativeG >= knownG) continue;

            parents.set(nk, { from: curKey, dir: n.dir });
            gScore.set(nk, tentativeG);
            open.set(nk, { x: nx, y: ny, f: tentativeG + heuristic(nx, ny, gx, gy) });
        }
    }

    return null;
}


/**
 * Manhattan distance between two cells, used as the A* heuristic.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function heuristic(x1, y1, x2, y2) {
    return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

/**
 * Reconstructs the path and moves by following the parent links from the goal back to the start.
 *
 * @param {Parents} parents
 * @param {TileKey} goalKey
 * @param {TileKey} startKey
 * @returns {PathResult}
 */
function reconstruct(parents, goalKey, startKey) {
    /** @type {Position[]} */
    const path = [];
    /** @type {Direction[]} */
    const moves = [];

    let k = goalKey;
    while (k !== startKey) {
        const p = parents.get(k);
        const [x, y] = k.split(',').map(Number);
        path.unshift({ x, y });
        moves.unshift(p.dir);
        k = p.from;
    }

    return { path, moves };
}

/**
 * Returns the sequence of moves needed to reach the target from beliefs.me.
 *
 * @param {Position} target - Destination tile.
 * @param {PathOptions} [options]
 * @returns {Direction[]}
 */
export function planTo(target, options = DEFAULT_OPTIONS) {
    if (beliefs.me.x === null || beliefs.me.y === null) return [];
    const start = { x: beliefs.me.x, y: beliefs.me.y };
    const opts = { ...DEFAULT_OPTIONS, ...options };

    let result = aStar(start, target, opts);

    // Fallback: if no path is found while avoiding agents,
    // retry without considering agents as blockers.
    if (!result && opts.avoidAgents) {
        result = aStar(start, target, { avoidAgents: false });
    }

    return result ? result.moves : [];
}



/**
 * Find the goal with the shortest path
 *
 * @param {Position} start
 * @param {Position[]} goals
 * @param {PathOptions} [options]
 * @returns {{goal: Position, path: Position[], moves: Direction[]} | null}
 */
export function nearestReachable(start, goals, options = DEFAULT_OPTIONS) {
    let best = null;
    let bestLen = Infinity;

    for (const g of goals) {
        const result = aStar(start, g, options);
        if (!result) continue;

        if (result.moves.length < bestLen) {
            bestLen = result.moves.length;
            best = { goal: g, path: result.path, moves: result.moves };
        }
    }

    return best;
}

/**
 * Builds the set of tiles occupied by non-stale opponents to treat as obstacles.
 * Tiles occupied by me are never included.
 *
 * @param {boolean} [enabled=false]
 * @returns {Set<TileKey>}
 */
function buildBlockedSet(enabled = false) {
    /** @type {Set<TileKey>} */
    const blocked = new Set();
    if (!enabled) return blocked;

    for (const agent of beliefs.agents.values()) {
        if (agent.stale) continue;
        const x = Math.round(agent.x);
        const y = Math.round(agent.y);
        blocked.add(`${x},${y}`);
    }

    return blocked;
}
