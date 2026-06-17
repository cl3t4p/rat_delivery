/** @typedef {import('../../shared/types.js').Position} Position*/

import { beliefs } from '../beliefs.js';
import {
    nearestByManhattan,
    costToReachPath,
    manhattanDistance,
    findBestReachable,
    findBestReachableTile,
} from '../helper.js';
import { getMapBounds as _getMapBounds, onBoundsInvalidated } from '../../shared/zones.js';
import { _zoneConstraint, _isInZone } from './zone.js';
import { llmMemory } from '../../llm/llmAgent.js';

/** @type {Map<string, boolean>} Cache for spawner-to-delivery reachability (static per map load). */
const _spawnerDeliveryCache = new Map();
onBoundsInvalidated(() => _spawnerDeliveryCache.clear());

// Normalised spawner spread (0 = single tight blob, 1 = across the whole map)
// above which we roam regardless of spawn rate. Tunable via SPAWNER_SPARSE_THRESHOLD.
const SPARSE_THRESHOLD = Number(process.env.SPAWNER_SPARSE_THRESHOLD) || 0.25;

/**
 * Finds the spawner tile nearest to the current position.
 *
 * @param {Position} myPos - Current position.
 * @returns {Position|null}
 */
export function findNearestSpawnerTile(myPos) {
    return nearestByManhattan(myPos, findSpawnerTiles());
}

/**
 * Find the first reachable spawner
 *
 * @param {Position} myPos
 * @param {Position[]} spawners
 * @returns {Position}
 */
export function findFirstReachableSpawnerTile(myPos, spawners) {
    for (const spawner of spawners) {
        if (costToReachPath(myPos, spawner) != null) return spawner;
    }

    return null;
}

/**
 * Finds the reachable spawner with the shortest real path.
 *
 * @param {Position} myPos
 * @param {Position[]} [spawners]
 * @returns {Position|null}
 */
export function findBestReachableSpawnerTile(myPos, spawners = findSpawnerTiles()) {
    let best = null;
    let bestLen = Infinity;

    for (const spawner of spawners) {
        const dist = costToReachPath(myPos, spawner);
        if (dist == null) continue;

        if (dist < bestLen) {
            best = spawner;
            bestLen = dist;
        }
    }

    return best;
}

/**
 * Returns every spawner tile on the known map.
 *
 * @returns {Position[]}
 */
export function findSpawnerTiles() {
    const out = [];
    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        out.push({ x, y });
    }
    return out;
}

/**
 * Finds the delivery tile nearest to the current position.
 *
 * @param {Position} myPos - Current position.
 * @returns {Position|null}
 */
export function findNearestDeliveryTile(myPos) {
    return findBestReachableTile(myPos, beliefs.deliveryTiles, { useManhattan: true });
}

/**
 * Finds the reachable delivery tile with the shortest real path.
 *
 * Falls back to Manhattan nearest if A* cannot find any reachable delivery.
 *
 * @param {Position} myPos - Current or candidate position.
 * @returns {Position|null}
 */
export function findBestDeliveryTile(myPos) {
    // Honour the LLM's per-tile delivery-reward rule: never use a 0/negative tile,
    // and prefer the tile with the highest multiplier when a bonus tile exists.
    const rewards = llmMemory.deliveryRewards;
    const hasRule = rewards && Object.keys(rewards).length > 0;

    if (!hasRule) {
        return findBestDeliveryPathFrom(myPos)?.tile ?? findNearestDeliveryTile(myPos);
    }

    const allowed = beliefs.deliveryTiles.filter((t) => {
        const m = rewards[`${t.x},${t.y}`];
        return m == null || m > 0;
    });
    if (allowed.length === 0) return null;

    // If a bonus multiplier (>1) is in play, go to the highest-multiplier reachable
    // tile; otherwise just the nearest reachable allowed tile.
    const mults = [...new Set(allowed.map((t) => rewards[`${t.x},${t.y}`] ?? 1))].sort(
        (a, b) => b - a
    );
    if (mults[0] > 1) {
        for (const m of mults) {
            const group = allowed.filter((t) => (rewards[`${t.x},${t.y}`] ?? 1) === m);
            const best = findBestReachable(myPos, group);
            if (best) return best.tile;
        }
    }

    return (
        findBestReachable(myPos, allowed)?.tile ??
        findBestReachableTile(myPos, allowed, { useManhattan: true })
    );
}

/**
 * Best delivery tile (with its distance), preferring tiles not currently occupied
 * by another agent and falling back to any reachable delivery tile.
 *
 * @param {Position} pos
 * @returns {{tile: Position, dist: number} | null}
 */
export function findBestDeliveryPathFrom(pos) {
    const free = beliefs.deliveryTiles.filter((tile) => !isTileOccupiedByOtherAgent(tile));
    return findBestReachable(pos, free) ?? findBestReachable(pos, beliefs.deliveryTiles);
}

/**
 * True if another (non-stale, non-self) agent currently occupies the given tile.
 *
 * @param {Position} tile
 * @returns {boolean}
 */
export function isTileOccupiedByOtherAgent(tile) {
    const tx = Math.round(tile.x);
    const ty = Math.round(tile.y);
    for (const agent of beliefs.agents.values()) {
        if (
            !agent.stale &&
            agent.id !== beliefs.me.id &&
            Math.round(agent.x) === tx &&
            Math.round(agent.y) === ty
        ) {
            return true;
        }
    }
    return false;
}

/**
 * Finds the nearest walkable, non-delivery tile inside the active zone constraint.
 * Used to step off a delivery tile when waiting as a relay receiver.
 *
 * @param {Position} myPos
 * @returns {Position|null}
 */
export function findNearestNonDeliveryInZoneTile(myPos) {
    const deliverySet = new Set(beliefs.deliveryTiles.map((t) => `${t.x},${t.y}`));
    let best = null;
    let bestDist = Infinity;
    for (const [key, tile] of beliefs.grid) {
        if (tile.type === '0') continue;
        if (deliverySet.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        if (_zoneConstraint && !_isInZone({ x, y })) continue;
        const dist = manhattanDistance(myPos, { x, y });
        if (dist > 0 && dist < bestDist) {
            bestDist = dist;
            best = { x, y };
        }
    }
    return best;
}

/**
 *
 * @param {Position[]} spawners
 * @returns {Number}
 */
export function spawnerSparseness(spawners = findSpawnerTiles()) {
    if (spawners.length < 2) return 0;

    const { cx, cy } = centroid(spawners);
    const meanRadius =
        spawners.reduce((s, p) => s + Math.abs(p.x - cx) + Math.abs(p.y - cy), 0) / spawners.length;

    const { maxX, maxY } = _getMapBounds(beliefs.grid);
    const halfExtent = (maxX + maxY) / 2 || 1;
    return Math.min(1, meanRadius / halfExtent);
}

export function spawnerCanReachDelivery(spawner) {
    // A spawner that cannot reach any delivery tile creates parcels the agent
    // cannot score. Do not camp or patrol these pockets.
    if (beliefs.deliveryTiles.length === 0) return false;
    const key = `${spawner.x},${spawner.y}`;
    if (_spawnerDeliveryCache.has(key)) return _spawnerDeliveryCache.get(key);
    const result = beliefs.deliveryTiles.some(
        (delivery) => costToReachPath(spawner, delivery) != null
    );
    _spawnerDeliveryCache.set(key, result);
    return result;
}

/**
 * Decides whether the spawners are spread out enough to warrant roaming rather
 * than camping, taking the agent's view range into account.
 *
 * @param {Position[]} [spawners] - Precomputed spawners (defaults to all).
 * @returns {boolean}
 */
export function spawnersAreSparse(spawners = findSpawnerTiles()) {
    if (spawners.length < 2) return false;

    const view = beliefs.config?.OBSERVATION_DISTANCE ?? null;

    const { cx, cy } = centroid(spawners);
    // Cluster radius: farthest spawner from the centroid.
    const radius = Math.max(...spawners.map((p) => Math.abs(p.x - cx) + Math.abs(p.y - cy)));

    if (view !== null && view > 0) {
        // Finite vision: sparse if one vantage point can't watch them all.
        return radius > view;
    }
    // Unlimited vision: fall back to normalized geometric spread.
    return spawnerSparseness(spawners) >= SPARSE_THRESHOLD;
}

/**
 * Measures how spread out the spawner tiles are, normalised to [0, 1].
 *
 * 0 means every spawner sits on (essentially) one tile — a single blob;
 * values near 1 mean they are scattered across the whole map. Computed as the
 * mean distance of spawners from their centroid, divided by the map's
 * half-extent so it is comparable across map sizes.
 *
 * @param {Position[]} [spawners] - Precomputed spawners (defaults to all).
 * @returns {number}
 */
/** Mean (x, y) of a set of points. Caller guarantees a non-empty list. */
function centroid(points) {
    const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
    const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
    return { cx, cy };
}
