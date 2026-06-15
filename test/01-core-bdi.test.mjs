/**
 * Level 1 — Core BDI puro
 *
 * Tests beliefs, grid, zones, pathfinding and scoring in complete isolation.
 * No networking, no LLM, no socket.
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    beliefs,
    updateMap,
    updateBeliefs,
    updateMe,
    decayParcelsReward,
    clockEventToMs,
    manhattanDistance,
    blacklistCell,
    unblacklistCell,
    isBlacklisted,
    suppressClaimedParcel,
} from '../src/bdi/beliefs.js';
import { isWalkable, canEnter } from '../src/bdi/grid.js';
import { getZone, getMapBounds, invalidateBounds } from '../src/shared/zones.js';
import { aStar, planTo, nearestReachable } from '../src/bdi/pathfinding.js';
import {
    estimateDecay,
    estimatedRewardAtDelivery,
    pickupValue,
    deliveryValue,
    detourValue,
} from '../src/bdi/scoring.js';

import { resetBeliefs, makeGrid, addParcel, setMe } from './helpers.mjs';

beforeEach(() => resetBeliefs());

// ── clockEventToMs ────────────────────────────────────────────────────────────

test('clockEventToMs – numeric passthrough', () => {
    assert.equal(clockEventToMs(500), 500);
    assert.equal(clockEventToMs(0), 0);
});

test('clockEventToMs – ms / s / m units', () => {
    assert.equal(clockEventToMs('500ms'), 500);
    assert.equal(clockEventToMs('2s'), 2000);
    assert.equal(clockEventToMs('1m'), 60000);
});

test('clockEventToMs – frame token → 40ms', () => {
    assert.equal(clockEventToMs('frame'), 40);
});

test('clockEventToMs – null / undefined → null', () => {
    assert.equal(clockEventToMs(null), null);
    assert.equal(clockEventToMs(undefined), null);
});

test('clockEventToMs – plain number string defaults to seconds', () => {
    assert.equal(clockEventToMs('5'), 5000);
});

// ── manhattanDistance ─────────────────────────────────────────────────────────

test('manhattanDistance – basic', () => {
    assert.equal(manhattanDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 7);
    assert.equal(manhattanDistance({ x: 2, y: 2 }, { x: 2, y: 2 }), 0);
    assert.equal(manhattanDistance({ x: 1.4, y: 0.6 }, { x: 3.4, y: 0.6 }), 2);
});

// ── updateMap ─────────────────────────────────────────────────────────────────

test('updateMap – populates grid and delivery tiles', () => {
    updateMap([
        { x: 0, y: 0, type: '1' },
        { x: 1, y: 0, type: '2' },
        { x: 2, y: 0, type: '0' },
    ]);
    assert.equal(beliefs.grid.size, 3);
    assert.equal(beliefs.deliveryTiles.length, 1);
    assert.deepEqual(beliefs.deliveryTiles[0], { x: 1, y: 0 });
    assert.equal(beliefs.grid.get('2,0').delivery, false);
    assert.equal(beliefs.grid.get('1,0').delivery, true);
});

test('updateMap – replaces old map on second call', () => {
    updateMap([{ x: 0, y: 0, type: '1' }]);
    updateMap([{ x: 5, y: 5, type: '2' }]);
    assert.equal(beliefs.grid.size, 1);
    assert.ok(beliefs.grid.has('5,5'));
    assert.equal(beliefs.deliveryTiles.length, 1);
});

// ── updateBeliefs ─────────────────────────────────────────────────────────────

test('updateBeliefs – adds new parcels', () => {
    beliefs.me.id = 'me';
    updateBeliefs(
        [{ id: 'p1', x: 1, y: 1, reward: 10, carriedBy: null }],
        [],
        []
    );
    assert.ok(beliefs.parcels.has('p1'));
    assert.equal(beliefs.parcels.get('p1').reward, 10);
});

test('updateBeliefs – ignores parcels carried by others and suppresses them', () => {
    beliefs.me.id = 'me';
    updateBeliefs(
        [{ id: 'p2', x: 0, y: 0, reward: 5, carriedBy: 'other-agent' }],
        [],
        []
    );
    assert.ok(!beliefs.parcels.has('p2'));
});

test('updateBeliefs – tracks carrying', () => {
    beliefs.me.id = 'me';
    updateBeliefs(
        [{ id: 'p3', x: 2, y: 2, reward: 8, carriedBy: 'me' }],
        [],
        []
    );
    assert.ok(beliefs.me.carrying.includes('p3'));
});

test('updateBeliefs – marks unseen agents as stale after AGENT_STALE_MS', () => {
    beliefs.me.id = 'me';
    beliefs.config.AGENT_STALE_MS = 0; // expire immediately
    beliefs.agents.set('enemy', {
        id: 'enemy', x: 3, y: 3, lastSeen: Date.now() - 10, stale: false,
    });
    updateBeliefs([], [], []);
    assert.equal(beliefs.agents.get('enemy')?.stale, true);
});

// ── decayParcelsReward ────────────────────────────────────────────────────────

test('decayParcelsReward – decrements reward each interval', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = 1000;
    beliefs.config._decayAccumulatedMs = 0;
    beliefs.parcels.set('px', { id: 'px', x: 0, y: 0, reward: 5, carriedBy: null, lastSeen: Date.now() });
    decayParcelsReward(); // +1000ms → 1 decay step
    assert.equal(beliefs.parcels.get('px').reward, 4);
});

test('decayParcelsReward – removes parcel when reward reaches 0', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = 1000;
    beliefs.config._decayAccumulatedMs = 0;
    beliefs.parcels.set('py', { id: 'py', x: 0, y: 0, reward: 1, carriedBy: null, lastSeen: Date.now() });
    decayParcelsReward();
    assert.ok(!beliefs.parcels.has('py'));
});

test('decayParcelsReward – no-op when interval is null', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    beliefs.parcels.set('pz', { id: 'pz', x: 0, y: 0, reward: 5, carriedBy: null, lastSeen: Date.now() });
    decayParcelsReward();
    assert.equal(beliefs.parcels.get('pz').reward, 5);
});

// ── blacklist ─────────────────────────────────────────────────────────────────

test('blacklistCell / isBlacklisted / unblacklistCell', () => {
    blacklistCell(3, 3);
    assert.ok(isBlacklisted(3, 3));
    unblacklistCell(3, 3);
    assert.ok(!isBlacklisted(3, 3));
});

// ── suppressClaimedParcel ─────────────────────────────────────────────────────

test('suppressClaimedParcel – removes parcel from beliefs', () => {
    beliefs.parcels.set('s1', { id: 's1', x: 0, y: 0, reward: 5, carriedBy: null, lastSeen: Date.now() });
    suppressClaimedParcel('s1', 60000);
    assert.ok(!beliefs.parcels.has('s1'));
});

// ── isWalkable / canEnter ─────────────────────────────────────────────────────

test('isWalkable – spawner (1) is walkable', () => {
    makeGrid(3, 3);
    assert.ok(isWalkable(0, 0));
});

test('isWalkable – wall (0) is not walkable', () => {
    makeGrid(3, 3, { '1,1': '0' });
    assert.ok(!isWalkable(1, 1));
});

test('isWalkable – unknown tile is not walkable', () => {
    makeGrid(3, 3);
    assert.ok(!isWalkable(99, 99));
});

test('isWalkable – blacklisted cell is not walkable', () => {
    makeGrid(3, 3);
    blacklistCell(2, 2);
    assert.ok(!isWalkable(2, 2));
    unblacklistCell(2, 2);
});

test('isWalkable – crate blocks the tile', () => {
    makeGrid(3, 3);
    beliefs.crates.set('1,1', { id: 'c1', x: 1, y: 1, lastSeen: Date.now() });
    assert.ok(!isWalkable(1, 1));
    beliefs.crates.clear();
});

test('canEnter – cannot enter a wall', () => {
    makeGrid(3, 3, { '1,1': '0' });
    assert.ok(!canEnter(0, 1, 1, 1));
});

test('canEnter – arrow tile blocks opposite direction', () => {
    // Arrow '→' at (1,1): only moving right (from left) is allowed.
    makeGrid(3, 3, { '1,1': '→' });
    assert.ok(!canEnter(2, 1, 1, 1)); // from right (moving left)  — blocked
    assert.ok(!canEnter(1, 2, 1, 1)); // from above (moving down)  — blocked
    assert.ok(!canEnter(1, 0, 1, 1)); // from below (moving up)    — blocked
    assert.ok( canEnter(0, 1, 1, 1)); // from left  (moving right) — allowed
});

// ── zones ─────────────────────────────────────────────────────────────────────

test('getZone – classifies 4 quadrants on a 10×10 grid', () => {
    makeGrid(10, 10);
    const grid = beliefs.grid;
    assert.equal(getZone({ x: 1, y: 1 }, grid), 'bottomLeft');
    assert.equal(getZone({ x: 8, y: 1 }, grid), 'bottomRight');
    assert.equal(getZone({ x: 1, y: 8 }, grid), 'topLeft');
    assert.equal(getZone({ x: 8, y: 8 }, grid), 'topRight');
});

test('getMapBounds – correct min/max on a 4×3 grid', () => {
    makeGrid(4, 3);
    const { maxX, maxY } = getMapBounds(beliefs.grid);
    assert.equal(maxX, 3);
    assert.equal(maxY, 2);
});

test('invalidateBounds – forces recomputation', () => {
    makeGrid(4, 3);
    getMapBounds(beliefs.grid); // cache it
    invalidateBounds();
    makeGrid(6, 6);
    const { maxX } = getMapBounds(beliefs.grid);
    assert.equal(maxX, 5);
});

// ── aStar ─────────────────────────────────────────────────────────────────────

test('aStar – same start and goal returns empty path', () => {
    makeGrid(5, 5);
    const result = aStar({ x: 2, y: 2 }, { x: 2, y: 2 });
    assert.deepEqual(result, { path: [], moves: [] });
});

test('aStar – straight horizontal path', () => {
    makeGrid(5, 1);
    const result = aStar({ x: 0, y: 0 }, { x: 4, y: 0 });
    assert.ok(result !== null);
    assert.equal(result.moves.length, 4);
    assert.ok(result.moves.every((m) => m === 'right'));
});

test('aStar – straight vertical path', () => {
    makeGrid(1, 5);
    const result = aStar({ x: 0, y: 0 }, { x: 0, y: 4 });
    assert.ok(result !== null);
    assert.equal(result.moves.length, 4);
    assert.ok(result.moves.every((m) => m === 'up'));
});

test('aStar – returns null when goal is a wall', () => {
    makeGrid(5, 5, { '2,2': '0' });
    const result = aStar({ x: 0, y: 0 }, { x: 2, y: 2 });
    assert.equal(result, null);
});

test('aStar – routes around an obstacle', () => {
    // 1×3 corridor with wall at middle of a 3×3
    makeGrid(3, 3, { '1,0': '0', '1,1': '0' });
    const result = aStar({ x: 0, y: 0 }, { x: 2, y: 0 });
    assert.ok(result !== null);
    assert.ok(result.moves.length > 2); // must go around
});

test('aStar – returns null when path is completely blocked', () => {
    makeGrid(3, 3, { '1,0': '0', '1,1': '0', '1,2': '0' });
    const result = aStar({ x: 0, y: 1 }, { x: 2, y: 1 });
    assert.equal(result, null);
});

test('planTo – uses beliefs.me as start', () => {
    makeGrid(5, 1);
    setMe(0, 0);
    const moves = planTo({ x: 3, y: 0 });
    assert.equal(moves.length, 3);
});

test('nearestReachable – returns shortest among multiple goals', () => {
    makeGrid(5, 1);
    const start = { x: 0, y: 0 };
    const result = nearestReachable(start, [{ x: 4, y: 0 }, { x: 2, y: 0 }]);
    assert.ok(result !== null);
    assert.deepEqual(result.goal, { x: 2, y: 0 });
});

// ── scoring ───────────────────────────────────────────────────────────────────

test('estimateDecay – 0 when interval unknown', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    assert.equal(estimateDecay(10), 0);
});

test('estimateDecay – counts decay ticks correctly', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = 500;
    beliefs.config.MS_PER_STEP = 500;
    // 10 steps × 500ms/step = 5000ms / 500ms interval = 10 decay ticks
    assert.equal(estimateDecay(10), 10);
});

test('estimatedRewardAtDelivery – clips to 0', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = 500;
    beliefs.config.MS_PER_STEP = 500;
    assert.equal(estimatedRewardAtDelivery(3, 100), 0);
});

test('estimatedRewardAtDelivery – preserves reward when no decay', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    assert.equal(estimatedRewardAtDelivery(20, 100), 20);
});

test('pickupValue – returns negative infinity when reward depleted', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = 500;
    beliefs.config.MS_PER_STEP = 500;
    // parcel with reward 1 that needs 10 steps to pick up and 10 to deliver → decays to 0
    const score = pickupValue({ reward: 1, x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 });
    assert.equal(score, -Infinity);
});

test('pickupValue – positive for nearby high-reward parcel', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    const score = pickupValue({ reward: 20, x: 1, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 });
    // 20 reward − 2 steps = 18
    assert.equal(score, 18);
});

test('deliveryValue – sums estimated rewards of carried parcels', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    beliefs.parcels.set('c1', { id: 'c1', x: 0, y: 0, reward: 10, carriedBy: 'me', lastSeen: Date.now() });
    beliefs.parcels.set('c2', { id: 'c2', x: 0, y: 0, reward: 15, carriedBy: 'me', lastSeen: Date.now() });
    const val = deliveryValue(['c1', 'c2'], { x: 0, y: 0 }, { x: 0, y: 0 });
    assert.equal(val, 25);
});

test('detourValue – positive when detour is worthwhile', () => {
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    // Carrying 1 parcel at origin, delivery right next to us.
    beliefs.parcels.set('held', { id: 'held', x: 0, y: 0, reward: 100, carriedBy: 'me', lastSeen: Date.now() });
    // Extra parcel 1 step away, delivery 1 step from it.
    const gain = detourValue(
        { reward: 50, x: 1, y: 0 },
        { x: 0, y: 0 },
        ['held'],
        { x: 1, y: 1 }
    );
    // With no decay: valueWithDetour = (100 + 50) = 150; valueDeliverNow = 100 → gain = 50
    assert.equal(gain, 50);
});
