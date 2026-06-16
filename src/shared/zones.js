/**
 * zones.js
 *
 * Shared zone utilities — splits the map into four quadrants and caches
 * map bounds so callers pay the O(|grid|) scan at most once per map load.
 */

/** @type {{ minX: number, maxX: number, minY: number, maxY: number } | null} */
let _cachedBounds = null;

/** @type {Array<() => void>} */
const _boundsInvalidationListeners = [];

/**
 * Registers a callback invoked whenever bounds are invalidated (i.e. on map reload).
 * Used by deliberation.js to clear its spawner-reachability cache without creating
 * a circular import (deliberation → beliefs → zones → deliberation).
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
 * Returns the zone quadrant for a map position.
 *
 * @param {{ x: number, y: number }} pos
 * @param {Map<string, any>} grid - beliefs.grid (used only to compute bounds once)
 * @returns {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'}
 */
export function getZone(pos, grid) {
    if (grid.size === 0) return 'bottomLeft';
    const { minX, maxX, minY, maxY } = getMapBounds(grid);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const top = pos.y >= midY;
    const right = pos.x >= midX;
    if (top && !right) return 'topLeft';
    if (top && right) return 'topRight';
    if (!top && !right) return 'bottomLeft';
    return 'bottomRight';
}
