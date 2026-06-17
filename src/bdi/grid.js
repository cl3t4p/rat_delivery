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
 * True when a tile can be used for movement.
 *
 * @param {number} x
 * @param {number} y
 * @param {boolean} [awareOfCrates=true] - whether crates block the tile.
 * @returns {boolean}
 */
export function isWalkable(x, y, awareOfCrates = true) {
    const key = `${x},${y}`;
    const tile = beliefs.grid.get(key);
    if (!tile) return false;
    if (isCellBlacklisted(key)) return false;
    if (awareOfCrates && beliefs.crates.has(key)) return false;
    return !BLOCKING_TYPES.has(tile.type);
}

/**
 * Static traversability check, ignoring crate occupancy.
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
    if (isCellBlacklisted(key)) return false;
    const v = ARROW_VEC[tile.type];
    if (!v) return true;
    const dx = toX - fromX;
    const dy = toY - fromY;
    return dx === v[0] && dy === v[1];
}

/**
 * True when the agent can step onto the tile.
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
 * True when the crate on the target tile can be pushed forward.
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
