/**
 * pathfinding.js
 *
 * A* pathfinding over the belief grid.
 */

import { beliefs } from './beliefs.js';
import { isWalkable, canEnter } from './grid.js';

/** @typedef {import('../shared/types.js').Position}   Position */
/** @typedef {import('../shared/types.js').Direction}  Direction */
/** @typedef {import('../shared/types.js').PathResult} PathResult */

/** @typedef {string} TileKey */
/** @typedef {{ from: TileKey, dir: Direction }} ParentLink */
/** @typedef {Map<TileKey, ParentLink | null>} Parents */
/** @typedef {{avoidAgents?: boolean}} PathOptions */

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

    const sx = Math.round(start.x),
        sy = Math.round(start.y);
    const gx = Math.round(goal.x),
        gy = Math.round(goal.y);

    if (sx === gx && sy === gy) return { path: [], moves: [] };
    if (!isWalkable(gx, gy)) return null;

    const blocked = buildBlockedSet(opts.avoidAgents);
    const startKey = `${sx},${sy}`;

    /** @type {Parents} */
    const parents = new Map();
    parents.set(startKey, null);

    /** Cost from the start node. */
    const gScore = new Map();
    gScore.set(startKey, 0);

    /** Open set keyed by tile. */
    const open = new Map();
    open.set(startKey, { x: sx, y: sy, f: heuristic(sx, sy, gx, gy) });

    /** @type {{dx: number, dy: number, dir: Direction}[]} */
    const neighbors = [
        { dx: 1, dy: 0, dir: 'right' },
        { dx: -1, dy: 0, dir: 'left' },
        { dx: 0, dy: 1, dir: 'up' },
        { dx: 0, dy: -1, dir: 'down' },
    ];

    while (open.size > 0) {
        // Small maps: linear scan is fine here.
        let curKey = null;
        let curNode = null;
        let bestF = Infinity;
        for (const [k, node] of open) {
            if (node.f < bestF) {
                bestF = node.f;
                curKey = k;
                curNode = node;
            }
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
 * Reconstructs path and moves from parent links.
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
 * Plans from the current agent position.
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

    // If agents block everything, retry through stale space.
    if (!result && opts.avoidAgents) {
        result = aStar(start, target, { avoidAgents: false });
    }

    return result ? result.moves : [];
}

/**
 * Goal with the shortest reachable path.
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
 * Opponent tiles to treat as dynamic obstacles.
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
