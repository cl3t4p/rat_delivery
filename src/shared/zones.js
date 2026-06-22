/**
 * Shared zone utilities.
 */

/** @type {{ minX: number, maxX: number, minY: number, maxY: number } | null} */
let _cachedBounds = null;

/**
 * Returns cached map bounds.
 *
 * @param {Map<string, any>} grid
 * @returns {{ maxX: number, maxY: number }}
 */
export function getMapBounds(grid) {
    if (_cachedBounds) return _cachedBounds;
    let minX = Infinity,
        maxX = -Infinity;
    let minY = Infinity,
        maxY = -Infinity;
    for (const key of grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    _cachedBounds = { minX, maxX, minY, maxY };
    return _cachedBounds;
}

/**
 * Returns the axis used to split the map in two.
 *
 * @param {Map<string, any>} grid
 * @returns {'x'|'y'}
 */
export function getSplitAxis(grid) {
    if (grid.size === 0) {
        return 'x';
    }
    const { minX, maxX, minY, maxY } = getMapBounds(grid);
    if (maxY - minY > maxX - minX) {
        return 'y';
    }
    return 'x';
}

/**
 * Returns the midpoint of the map.
 *
 * @param {Map<string, any>} grid
 * @returns {{ x: number, y: number }}
 */
export function getHalfPoint(grid) {
    const { minX, maxX, minY, maxY } = getMapBounds(grid);
    return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
}

/**
 * Returns the two zone names, low coordinate first.
 *
 * @param {Map<string, any>} grid
 * @returns {[string, string] | []}
 */
export function getZones(grid) {
    if (grid.size === 0) {
        return [];
    }
    if (getSplitAxis(grid) === 'y') {
        return ['bottom', 'top'];
    }
    return ['left', 'right'];
}

/**
 * Returns the zone containing a position.
 *
 * @param {{ x: number, y: number }} pos
 * @param {Map<string, any>} grid
 * @returns {'left'|'right'|'top'|'bottom'|null}
 */
export function getZone(pos, grid) {
    if (grid.size === 0) {
        return null;
    }
    const { minX, maxX, minY, maxY } = getMapBounds(grid);
    if (getSplitAxis(grid) === 'y') {
        if (pos.y >= (minY + maxY) / 2) {
            return 'top';
        }
        return 'bottom';
    }
    if (pos.x >= (minX + maxX) / 2) {
        return 'right';
    }
    return 'left';
}
