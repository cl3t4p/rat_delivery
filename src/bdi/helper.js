/** @typedef {import('../shared/types.js').Tile} Tile */

import { aStar } from './pathfinding.js';

export const USE_PDDL = process.env.USE_PDDL === 'true';

/**
 * Same grid cell.
 * @param {Tile} a
 * @param {Tile} b
 * @returns {boolean}
 */
export function sameTile(a, b) {
    return !!a && !!b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

/**
 * Best candidate by path cost, or by Manhattan distance when requested.
 *
 * @param {Position} myPos
 * @param {Position[]} multiplePos
 * @param {{useManhattan?: boolean}} [options]
 * @returns {{tile: Position, dist: number} | null}
 */
export function findBestReachable(myPos, multiplePos, { useManhattan = USE_PDDL } = {}) {
    let best = null;

    for (const tile of multiplePos) {
        let dist;
        if (useManhattan) {
            dist = manhattanDistance(myPos, tile);
        } else {
            const result = costToReachPath(myPos, tile);
            if (result == null) continue;
            dist = result;
        }

        if (dist < (best?.dist ?? Infinity)) {
            best = { tile, dist };
        }
    }

    return best;
}

/**
 * Same as findBestReachable, returning only the tile.
 * @param {Position} myPos
 * @param {Position[]} multiplePos
 * @param {{useManhattan?: boolean}} [options]
 * @returns {Position|null}
 */
export function findBestReachableTile(myPos, multiplePos, options) {
    return findBestReachable(myPos, multiplePos, options)?.tile ?? null;
}

/**
 * Nearest tile by Manhattan distance.
 * @param {Position} myPos
 * @param {Position[]} multiplePos
 * @returns {Position|null}
 */
export function nearestByManhattan(myPos, multiplePos) {
    return findBestReachableTile(myPos, multiplePos, { useManhattan: true });
}

/**
 * @param {Position} a
 * @param {Position} b
 * @returns {number}
 */
export function manhattanDistance(a, b) {
    return (
        Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.y) - Math.round(b.y))
    );
}

/**
 * Reachability distance used by deliberation.
 *
 * @param {Position} from
 * @param {Position} to
 * @param {boolean} avoidAgents default to true
 * @returns {number | null}
 */
export function costToReachPath(from, to,avoidAgents = true) {
    if (USE_PDDL) return manhattanDistance(from, to);
    const result = aStar(from, to, { avoidAgents: avoidAgents });
    return result ? result.moves.length : null;
}