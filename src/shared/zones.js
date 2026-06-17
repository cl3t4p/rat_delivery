/**
 * zones.js
 *
 * Shared zone utilities. For two agents the map is split into TWO halves along
 * its longer axis (a wide map → left/right, a tall map → top/bottom). If a half
 * happens to contain no spawners, that agent simply parks at the map's half point
 * (see deliberation.js) instead of patrolling — no special-casing here.
 *
 * Bounds are cached so callers pay the O(|grid|) scan at most once per map load.
 */

/** @type {{ minX: number, maxX: number, minY: number, maxY: number } | null} */
let _cachedBounds = null;

/** @type {Array<() => void>} */
const _boundsInvalidationListeners = [];

/**
 * Registers a callback invoked whenever bounds are invalidated (i.e. on map reload).
 * Used by deliberation.js to clear its spawner-reachability cache without creating
 * a circular import (deliberation to beliefs to zones back to deliberation).
 *
 * @param {() => void} fn
 */
export function onBoundsInvalidated(fn) {
    _boundsInvalidationListeners.push(fn);
}

/**
 * Invalidates the cached map bounds.
 * Must be called whenever the map is reloaded (updateMap in beliefs.js).
 */
export function invalidateBounds() {
    _cachedBounds = null;
    for (const fn of _boundsInvalidationListeners) fn();
}

/**
 * Returns map bounds, computing them from the grid on first call and caching.
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
 * Split axis: 'y' for a map taller than it is wide (split top/bottom), else 'x'
 * (split left/right).
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
 * Returns the half point of the map: the point on the split line, used as the
 * parking spot for an agent whose half has no spawners.
 *
 * @param {Map<string, any>} grid
 * @returns {{ x: number, y: number }}
 */
export function getHalfPoint(grid) {
    const { minX, maxX, minY, maxY } = getMapBounds(grid);
    return { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2) };
}

/**
 * Returns the two zone names, low coordinate first, or [] before the map loads.
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
 * Returns the zone (map half) for a position, or null before the map loads.
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
