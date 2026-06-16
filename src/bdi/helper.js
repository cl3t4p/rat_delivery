/** @typedef {import('../shared/types.js').Tile} Tile*/

import { aStar } from './pathfinding.js';

export const USE_PDDL = process.env.USE_PDDL === 'true';

/**
 * Return if a == b
 * @param {Tile} a
 * @param {Tile} b
 * @returns {boolean}
 */
export function sameTile(a, b) {
    return !!a && !!b && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y);
}

/**
 * Pick the candidate with the shortest distance, returning the tile and its
 * distance (in steps).
 *
 * Beware: this runs one reachPath per candidate. Pass `useManhattan` to use the
 * cheap straight-line estimate instead of A*. Agents are ignored when scoring.
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
            if (result == null) continue; // unreachable
            dist = result;
        }

        if (dist < (best?.dist ?? Infinity)) {
            best = { tile, dist };
        }
    }

    return best;
}

/**
 * Like {@link findBestReachable} but returns only the tile.
 * @param {Position} myPos
 * @param {Position[]} multiplePos
 * @param {{useManhattan?: boolean}} [options]
 * @returns {Position|null}
 */
export function findBestReachableTile(myPos, multiplePos, options) {
    return findBestReachable(myPos, multiplePos, options)?.tile ?? null;
}

/**
 * Nearest tile of the list by Manhattan distance.
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
 * Reachability distance (in steps) used for deliberation only (not for movement).
 *
 *
 * @param {Position} from
 * @param {Position} to
 * @returns {number | null} returns null if no path exists
 */
export function costToReachPath(from, to) {
    if (USE_PDDL) return manhattanDistance(from, to);
    const result = aStar(from, to, { avoidAgents: true });
    return result ? result.moves.length : null;
}
