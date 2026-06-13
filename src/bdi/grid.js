// grid.js
import { beliefs } from './beliefs.js';

const BLOCKING_TYPES = new Set(['0']);
const ARROW_VEC = { '↑': [0, 1], '→': [1, 0], '↓': [0, -1], '←': [-1, 0] };

function isCellBlacklisted(key) {
    if (beliefs.blacklist.has(key)) return true;

    const expiresAt = beliefs.temporaryBlacklist?.get(key);
    if (!expiresAt) return false;

    if (Date.now() > expiresAt) {
        beliefs.temporaryBlacklist.delete(key);
        return false;
    }

    return true;
}

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
    if (isCellBlacklisted(key)) return false;
    if (beliefs.crates.has(key)) return false;
    return !BLOCKING_TYPES.has(tile.type);
}

/**
 * Checks whether the agent can move from one tile to another.
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {boolean}
 */
export function canEnter(fromX, fromY, toX, toY) {
    const key = `${toX},${toY}`;
    const tile = beliefs.grid.get(key);
    if (!tile) return false;
    if (BLOCKING_TYPES.has(tile.type)) return false;
    if (beliefs.crates.has(key)) return false;
    if (isCellBlacklisted(key)) return false;
    const v = ARROW_VEC[tile.type];
    if (!v) return true;
    const dx = toX - fromX;
    const dy = toY - fromY;
    return dx === v[0] && dy === v[1]
}
