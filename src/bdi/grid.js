// grid.js
import { beliefs } from './beliefs.js';

const BLOCKING_TYPES = new Set(['0']);
const ARROW_VEC = { '↑': [0, 1], '→': [1, 0], '↓': [0, -1], '←': [-1, 0] };

/**
 * Checks whether a tile can be walked on.
 *
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isWalkable(x, y) {
    const key = `${x},${y}`;
    const tile = beliefs.grid.get(key);
    if (!tile) return false;
    if (beliefs.blacklist.has(key)) return false;
    return !BLOCKING_TYPES.has(tile.type);
}

/**
 * Checks whether the destination tile is physically traversable, ignoring crates.
 *
 * A tile is traversable when it exists, is not a wall, is not blacklisted, and the
 * move does not go against a one-way arrow. Crate occupancy is intentionally NOT
 * checked here: the Sokoban-style PDDL domain models crates with its own `occupied`
 * predicate, so the static map topology (edges) must be crate-agnostic.
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {boolean}
 */
export function canTraverse(fromX, fromY, toX, toY) {
    const key = `${toX},${toY}`;
    const tile = beliefs.grid.get(key);
    if (!tile) return false;
    if (BLOCKING_TYPES.has(tile.type)) return false;
    if (beliefs.blacklist.has(key)) return false;
    const v = ARROW_VEC[tile.type];
    if (!v) return true;
    const dx = toX - fromX;
    const dy = toY - fromY;
    return !(dx === -v[0] && dy === -v[1]);
}

/**
 * Checks whether the agent can simply step onto a tile (no crate in the way).
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {boolean}
 */
export function canEnter(fromX, fromY, toX, toY) {
    if (beliefs.crates.has(`${toX},${toY}`)) return false;
    return canTraverse(fromX, fromY, toX, toY);
}

/**
 * Checks whether the agent can push the crate that sits on (toX,toY) by stepping
 * into it. The push is valid only if there is a crate on the destination tile and
 * the tile directly beyond it (same direction) is free to receive the crate:
 * traversable and not already occupied by another crate.
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {boolean}
 */
export function canPush(fromX, fromY, toX, toY) {
    if (!beliefs.crates.has(`${toX},${toY}`)) return false;
    const bx = toX + (toX - fromX);
    const by = toY + (toY - fromY);
    return canEnter(toX, toY, bx, by);
}
