/**
 * zones.js
 *
 * Shared zone utilities — splits the map into four quadrants and caches
 * map bounds so callers pay the O(|grid|) scan at most once per map load.
 */

/** @type {{ maxX: number, maxY: number } | null} */
let _cachedBounds = null;

/**
 * Invalidates the cached map bounds.
 * Must be called whenever the map is reloaded (updateMap in beliefs.js).
 */
export function invalidateBounds() {
    _cachedBounds = null;
}

/**
 * Returns map bounds, computing them from the grid on first call and caching.
 *
 * @param {Map<string, any>} grid
 * @returns {{ maxX: number, maxY: number }}
 */
export function getMapBounds(grid) {
    if (_cachedBounds) return _cachedBounds;
    let maxX = 0;
    let maxY = 0;
    for (const key of grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    _cachedBounds = { maxX, maxY };
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
    const { maxX, maxY } = getMapBounds(grid);
    const midX = maxX / 2;
    const midY = maxY / 2;
    const top   = pos.y >= midY;
    const right = pos.x >= midX;
    if (top && !right)  return 'topLeft';
    if (top && right)   return 'topRight';
    if (!top && !right) return 'bottomLeft';
    return 'bottomRight';
}
