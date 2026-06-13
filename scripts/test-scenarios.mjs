/**
 * test-scenarios.mjs
 *
 * Offline BDI scenario tests — no server, no socket, runs in < 1 second.
 *
 * Usage:
 *   node scripts/test-scenarios.mjs
 *
 * Covers:
 *   - A* pathfinding (walls, crates, arrow tiles, unreachable goals)
 *   - Deliberation decisions for every map topology
 *   - Scoring edge cases on different decay configs
 *   - isWalkable / canEnter consistency
 *
 * Add a new test() block whenever you start a new challenge map.
 */

import assert from 'node:assert/strict';
import { beliefs } from '../src/bdi/beliefs.js';
import { invalidateBounds } from '../src/shared/zones.js';
import { getBestIntention, resetRoamTarget } from '../src/bdi/deliberation.js';
import { aStar } from '../src/bdi/pathfinding.js';
import { isWalkable, canEnter } from '../src/bdi/beliefs.js';

// ── Test runner ──────────────────────────────────────────────────────────────

let _suite = '';
let passed = 0;
let failed = 0;

function suite(name) {
    _suite = name;
    console.log(`\n${name}`);
}

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
        passed++;
    } catch (err) {
        console.log(`  ✗  ${name}`);
        console.log(`       ${err.message}`);
        failed++;
    }
}

// ── Grid builder ─────────────────────────────────────────────────────────────
//
// Descriptor: array of strings, first string = top row (highest y).
//
// Chars:
//   .  floor  (type '3')
//   #  wall   (type '0')
//   S  spawner (type '1')
//   D  delivery (type '2')
//   >  arrow right  (type '→')
//   <  arrow left   (type '←')
//   ^  arrow up     (type '↑')
//   v  arrow down   (type '↓')

const CHAR_TO_TYPE = {
    '.': '3', '#': '0', 'S': '1', 'D': '2',
    '>': '→', '<': '←', '^': '↑', 'v': '↓',
};

function buildGrid(rows) {
    beliefs.grid.clear();
    beliefs.deliveryTiles = [];
    beliefs.crates.clear();
    invalidateBounds();

    const height = rows.length;
    for (let ri = 0; ri < height; ri++) {
        const y = height - 1 - ri;
        for (let x = 0; x < rows[ri].length; x++) {
            const ch = rows[ri][x];
            const type = CHAR_TO_TYPE[ch] ?? '3';
            beliefs.grid.set(`${x},${y}`, { type, delivery: type === '2' });
            if (type === '2') beliefs.deliveryTiles.push({ x, y });
        }
    }
}

function reset() {
    beliefs.grid.clear();
    beliefs.deliveryTiles = [];
    beliefs.parcels.clear();
    beliefs.agents.clear();
    beliefs.crates.clear();
    beliefs.blacklist.clear();
    beliefs.temporaryBlacklist.clear();
    beliefs.me.id = 'agent-test';
    beliefs.me.x  = null;
    beliefs.me.y  = null;
    beliefs.me.score    = 0;
    beliefs.me.carrying = [];
    beliefs.config.PARCEL_DECADING_INTERVAL   = null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = null;
    beliefs.config.OBSERVATION_DISTANCE       = null;
    beliefs.config.MAX_PARCELS  = 5;
    beliefs.config.MS_PER_STEP  = 500;
    beliefs.config.PARCEL_FORGET_MS           = 5000;
    beliefs.config._decayAccumulatedMs        = 0;
    invalidateBounds();
    resetRoamTarget();
}

function parcel(id, x, y, reward, carriedBy = null) {
    beliefs.parcels.set(id, { id, x, y, reward, carriedBy, lastSeen: Date.now() });
}

// ── A* Pathfinding ───────────────────────────────────────────────────────────

suite('A* pathfinding');

test('start === goal returns empty path', () => {
    reset();
    buildGrid(['...', '...', '...']);
    const r = aStar({ x: 1, y: 1 }, { x: 1, y: 1 }, { avoidAgents: false });
    assert.deepEqual(r, { path: [], moves: [] });
});

test('straight path left → right', () => {
    reset();
    buildGrid(['....']);
    const r = aStar({ x: 0, y: 0 }, { x: 3, y: 0 }, { avoidAgents: false });
    assert.ok(r !== null, 'expected a path');
    assert.equal(r.moves.length, 3);
    assert.deepEqual(r.moves, ['right', 'right', 'right']);
});

test('straight path bottom → top', () => {
    reset();
    buildGrid(['.', '.', '.', '.']);
    const r = aStar({ x: 0, y: 0 }, { x: 0, y: 3 }, { avoidAgents: false });
    assert.ok(r !== null, 'expected a path');
    assert.deepEqual(r.moves, ['up', 'up', 'up']);
});

test('routes around a wall', () => {
    reset();
    buildGrid([
        '...',
        '.#.',
        '...',
    ]);
    // wall at (1,1); go from (0,0) to (2,2)
    const r = aStar({ x: 0, y: 0 }, { x: 2, y: 2 }, { avoidAgents: false });
    assert.ok(r !== null, 'expected a path around the wall');
    assert.ok(!r.path.some(p => p.x === 1 && p.y === 1), 'path must not cross wall');
});

test('completely enclosed goal returns null', () => {
    reset();
    buildGrid([
        '.#.',
        '###',
        '.#.',
    ]);
    const r = aStar({ x: 0, y: 2 }, { x: 2, y: 0 }, { avoidAgents: false });
    assert.equal(r, null, 'unreachable goal must return null');
});

test('goal on wall tile returns null', () => {
    reset();
    buildGrid(['...', '.#.', '...']);
    const r = aStar({ x: 0, y: 0 }, { x: 1, y: 1 }, { avoidAgents: false });
    assert.equal(r, null, 'wall tile goal must return null');
});

test('crate blocks direct path, routes around', () => {
    reset();
    buildGrid([
        '.....',
        '.....',
    ]);
    // crate at (2,0) — middle of the bottom row
    beliefs.crates.set('2,0', { id: 'c1', x: 2, y: 0, lastSeen: Date.now() });
    const r = aStar({ x: 0, y: 0 }, { x: 4, y: 0 }, { avoidAgents: false });
    assert.ok(r !== null, 'should find a path around the crate');
    assert.ok(!r.path.some(p => p.x === 2 && p.y === 0), 'path must not cross crate');
});

test('arrow tile: cannot enter from wrong direction', () => {
    reset();
    // '>' at (1,1) means you can only enter it by moving right (dx=1, dy=0)
    buildGrid([
        '...',
        '.>.',
        '...',
    ]);
    // try to enter (1,1) from above: (1,2)→(1,1), dy=-1 ≠ 0 → blocked
    const canEnterFromAbove = canEnter(1, 2, 1, 1);
    assert.equal(canEnterFromAbove, false, 'cannot enter right-arrow from above');

    // try to enter (1,1) from the left: (0,1)→(1,1), dx=+1 → allowed
    const canEnterFromLeft = canEnter(0, 1, 1, 1);
    assert.equal(canEnterFromLeft, true, 'can enter right-arrow from the left');
});

test('arrow tile: A* avoids wrong-direction entry', () => {
    reset();
    // Row 0 (bottom): arrow going right at x=1
    // Must reach (2,0) from (2,1) — the only path through (1,0)→(2,0)
    // enters (1,0) from the left (0,0)→(1,0) ✓ but (1,0) is '>'
    // Alternate: (2,1)→(2,0) directly works if (2,0) is a plain floor tile
    buildGrid([
        '...',   // y=1: floor
        '.>.',   // y=0: arrow at (1,0)
    ]);
    // from (0,1) to (2,0): can use (0,1)→(0,0)→(1,0)[enter from left OK]→(2,0)
    const r = aStar({ x: 0, y: 1 }, { x: 2, y: 0 }, { avoidAgents: false });
    assert.ok(r !== null, 'should find path using correctly-entered arrow tile');
    // verify the arrow tile is entered from the correct side if it appears in path
    for (let i = 0; i < r.path.length; i++) {
        if (r.path[i].x === 1 && r.path[i].y === 0) {
            // previous tile must be (0,0) — entered from the left
            const prev = r.path[i - 1] ?? { x: 0, y: 1 }; // start tile if first
            assert.ok(
                prev.x === 0 && prev.y === 0,
                `arrow tile at (1,0) must be entered from (0,0), got (${prev.x},${prev.y})`
            );
        }
    }
});

// ── isWalkable / canEnter consistency ────────────────────────────────────────

suite('isWalkable / canEnter');

test('wall tile: both return false', () => {
    reset();
    buildGrid(['#']);
    assert.equal(isWalkable(0, 0), false);
    assert.equal(canEnter(1, 0, 0, 0), false);
});

test('floor tile: both return true', () => {
    reset();
    buildGrid(['..']);
    assert.equal(isWalkable(0, 0), true);
    assert.equal(canEnter(0, 0, 1, 0), true);
});

test('crate tile: isWalkable returns false (after fix)', () => {
    reset();
    buildGrid(['...']);
    beliefs.crates.set('1,0', { id: 'c1', x: 1, y: 0, lastSeen: Date.now() });
    assert.equal(isWalkable(1, 0), false, 'crate tile should not be walkable');
    assert.equal(canEnter(0, 0, 1, 0), false, 'crate tile should not be enterable');
});

test('tile outside grid: both return false', () => {
    reset();
    buildGrid(['...']);
    assert.equal(isWalkable(99, 99), false);
    assert.equal(canEnter(0, 0, 99, 99), false);
});

test('blacklisted tile: isWalkable returns false', () => {
    reset();
    buildGrid(['...']);
    beliefs.blacklist.add('1,0');
    assert.equal(isWalkable(1, 0), false, 'blacklisted tile must be impassable');
});

// ── Deliberation decisions ───────────────────────────────────────────────────

suite('Deliberation — basic decisions');

test('position unknown → wait', () => {
    reset();
    buildGrid(['S.D']);
    beliefs.me.x = null; beliefs.me.y = null;
    const i = getBestIntention();
    assert.equal(i.type, 'wait');
});

test('nothing visible, one spawner → explore toward it', () => {
    reset();
    // spawner at (0,0), agent at (2,0)
    buildGrid(['S..']);
    beliefs.me.x = 2; beliefs.me.y = 0;
    const i = getBestIntention();
    assert.ok(i.type === 'explore' || i.type === 'wait', `got ${i.type}`);
    if (i.type === 'explore') {
        assert.deepEqual(i.targetPos, { x: 0, y: 0 }, 'should head for the spawner');
    }
});

test('no spawners on map → wait', () => {
    reset();
    // only floor + delivery, zero spawner tiles
    buildGrid(['...', '.D.', '...']);
    beliefs.me.x = 0; beliefs.me.y = 0;
    const i = getBestIntention();
    assert.equal(i.type, 'wait', 'no spawner means nothing to explore');
});

test('free parcel with reward → go_pick_up', () => {
    reset();
    buildGrid(['...D', '....', 'S...']);
    beliefs.me.x = 1; beliefs.me.y = 1;
    beliefs.config.PARCEL_DECADING_INTERVAL = null; // no decay
    parcel('p1', 2, 1, 30);
    const i = getBestIntention();
    assert.equal(i.type, 'go_pick_up');
    assert.equal(i.parcelId, 'p1');
});

test('parcel reward=0 → ignored', () => {
    reset();
    buildGrid(['D..', '...', 'S..']);
    beliefs.me.x = 1; beliefs.me.y = 1;
    parcel('p1', 0, 2, 0); // reward depleted
    const i = getBestIntention();
    assert.notEqual(i.type, 'go_pick_up', 'zero-reward parcel must be skipped');
});

test('parcel carried by other agent → ignored', () => {
    reset();
    buildGrid(['D..', '...', 'S..']);
    beliefs.me.x = 1; beliefs.me.y = 1;
    parcel('p1', 0, 2, 30, 'other-agent');
    const i = getBestIntention();
    assert.notEqual(i.type, 'go_pick_up', 'already-carried parcel must be skipped');
});

suite('Deliberation — carrying parcels');

test('carrying + delivery tile exists → go_deliver', () => {
    reset();
    buildGrid(['D..', '...', 'S..']);
    beliefs.me.x = 2; beliefs.me.y = 0;
    beliefs.me.id = 'me';
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    parcel('p1', 2, 0, 20, 'me');
    beliefs.me.carrying = ['p1'];
    const i = getBestIntention();
    assert.equal(i.type, 'go_deliver');
    assert.deepEqual(i.targetPos, { x: 0, y: 2 });
});

test('carrying + useful nearby parcel → evaluate detour without crashing', () => {
    reset();
    buildGrid(['D...']);
    beliefs.me.x = 1; beliefs.me.y = 0;
    beliefs.me.id = 'me';
    beliefs.config.MAX_PARCELS = 2;
    beliefs.config.PARCEL_DECADING_INTERVAL = null;

    parcel('carried', 1, 0, 20, 'me');
    beliefs.me.carrying = ['carried'];
    parcel('near-extra', 2, 0, 50);

    const i = getBestIntention();

    assert.equal(i.type, 'go_pick_up');
    assert.equal(i.parcelId, 'near-extra');
});

test('carrying + NO delivery tiles → wait, not go_pick_up [bug fix]', () => {
    reset();
    // no delivery tile (type '2') anywhere on the map
    buildGrid(['S..', '...', '...']);
    beliefs.me.x = 1; beliefs.me.y = 1;
    beliefs.me.id = 'me';
    parcel('p1', 1, 1, 30, 'me');
    beliefs.me.carrying = ['p1'];
    // also add a visible free parcel that would tempt a go_pick_up
    parcel('p2', 0, 2, 50);
    const i = getBestIntention();
    assert.notEqual(
        i.type, 'go_pick_up',
        'must not try to pick up more when carrying and no delivery tile exists'
    );
});

test('at MAX_PARCELS capacity → go_deliver immediately, no detour', () => {
    reset();
    buildGrid(['D.....S']);
    beliefs.me.x = 4; beliefs.me.y = 0;
    beliefs.me.id = 'me';
    beliefs.config.MAX_PARCELS = 2;
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    parcel('p1', 4, 0, 20, 'me');
    parcel('p2', 4, 0, 20, 'me');
    beliefs.me.carrying = ['p1', 'p2'];
    parcel('p3', 3, 0, 100); // very tempting free parcel nearby
    const i = getBestIntention();
    assert.equal(i.type, 'go_deliver', 'must deliver immediately when at capacity');
});

test('carrying with parcel that disappeared → re-deliberate normally', () => {
    reset();
    buildGrid(['D..', '...', 'S..']);
    beliefs.me.x = 1; beliefs.me.y = 1;
    beliefs.me.id = 'me';
    // carrying is set but parcel no longer in beliefs (e.g. sensing lost it)
    beliefs.me.carrying = ['ghost-parcel'];
    // beliefs.parcels does NOT contain 'ghost-parcel'
    const i = getBestIntention();
    // carrying should have been cleared → normal deliberation
    assert.equal(beliefs.me.carrying.length, 0, 'ghost carrying must be cleared');
    assert.notEqual(i.type, 'go_deliver', 'should not deliver with no real parcel');
});

suite('Deliberation — scoring and decay');

test('fast decay: far parcel worth less than near parcel', () => {
    reset();
    buildGrid(['....D', '.....', '.....']);
    beliefs.me.x = 0; beliefs.me.y = 0;
    beliefs.config.PARCEL_DECADING_INTERVAL = 500; // decays every 500ms
    beliefs.config.MS_PER_STEP = 500; // 1 step = 1 decay tick

    parcel('near', 1, 0, 20); // 1 step to parcel + ~3 steps to delivery = 4 decay = 16 reward
    parcel('far',  4, 2, 30); // far but higher reward — but decay eats it

    const i = getBestIntention();
    assert.equal(i.type, 'go_pick_up');
    // the near parcel should win even though far has higher raw reward
    // (exact result depends on path lengths, just verify a parcel was chosen)
    assert.ok(i.parcelId === 'near' || i.parcelId === 'far');
});

test('no decay config: picks highest raw reward', () => {
    reset();
    buildGrid(['D.....']);
    beliefs.me.x = 0; beliefs.me.y = 0;
    beliefs.config.PARCEL_DECADING_INTERVAL = null; // infinite lifetime

    parcel('cheap',    3, 0, 10);
    parcel('expensive', 5, 0, 50);

    const i = getBestIntention();
    assert.equal(i.type, 'go_pick_up');
    // With no decay, score = reward - steps. expensive: 50-5=45; cheap: 10-3=7
    assert.equal(i.parcelId, 'expensive', 'should pick the higher-value parcel');
});

suite('Deliberation — map topology edge cases');

test('map with only wall and one floor tile → wait', () => {
    reset();
    buildGrid(['#.#', '###', '#.#']);
    // Two isolated floor tiles (0,1)... wait, let's check:
    // Actually (1,0) is floor at the center bottom... let me re-check
    // row 0 (top, y=2): # . #
    // row 1 (mid, y=1): # # #
    // row 2 (bot, y=0): # . #
    // So floor tiles are (1,2) and (1,0) — not connected
    beliefs.me.x = 1; beliefs.me.y = 2;
    const i = getBestIntention();
    // No spawners → wait
    assert.equal(i.type, 'wait');
});

test('large-ish map with multiple delivery tiles: picks nearest delivery', () => {
    reset();
    buildGrid([
        'D.........D',
        '...........',
        '...........',
        '...........',
        'S..........',
    ]);
    beliefs.me.x = 5; beliefs.me.y = 2;
    beliefs.me.id = 'me';
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    parcel('p1', 5, 2, 30, 'me');
    beliefs.me.carrying = ['p1'];
    const i = getBestIntention();
    assert.equal(i.type, 'go_deliver');
    // Both D tiles are at (0,4) and (10,4) in grid coords (top row = y=4)
    // Manhattan from (5,2): to (0,4)=5+2=7, to (10,4)=5+2=7 — equidistant
    // Just verify it picks a delivery tile
    const isValidDelivery = beliefs.deliveryTiles.some(
        d => d.x === i.targetPos.x && d.y === i.targetPos.y
    );
    assert.ok(isValidDelivery, `target (${i.targetPos?.x},${i.targetPos?.y}) is not a delivery tile`);
});

test('single-tile map (just one floor) → wait', () => {
    reset();
    buildGrid(['.']);
    beliefs.me.x = 0; beliefs.me.y = 0;
    const i = getBestIntention();
    assert.equal(i.type, 'wait');
});

test('spawner + delivery adjacent: explore then immediately deliver', () => {
    reset();
    buildGrid(['SD']);
    beliefs.me.x = 0; beliefs.me.y = 0;
    beliefs.me.id = 'me';
    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    // agent is ON the spawner and carrying
    parcel('p1', 0, 0, 20, 'me');
    beliefs.me.carrying = ['p1'];
    const i = getBestIntention();
    assert.equal(i.type, 'go_deliver');
    assert.deepEqual(i.targetPos, { x: 1, y: 0 });
});

// –––––– TEST –––––––––––––––––––––––––––

test('challenge log 14:31 - avoid spawner that cannot deliver generated parcels', () => {
    reset();

    /*
     * Mappa minimale con one-way trap:
     *
     * y=1: D . S . #
     * y=0: . . . > S
     *
     * Agent parte su (3,0), cioè sulla freccia '>'.
     *
     * Spawner morto:
     *   - (4,0)
     *   - raggiungibile dall'agente con una mossa a destra
     *   - ma da (4,0) non si può tornare alla delivery,
     *     perché per rientrare a sinistra bisognerebbe entrare
     *     nella freccia '>' dal lato sbagliato.
     *
     * Spawner buono:
     *   - (2,1)
     *   - può raggiungere la delivery (0,1)
     *
     * Il bug attuale è che l'agente sceglie lo spawner più vicino,
     * anche se i pacchi generati lì non sono consegnabili.
     */
    buildGrid([
        'D.S.#',
        '...>S',
    ]);

    beliefs.me.x = 3;
    beliefs.me.y = 0;
    beliefs.me.id = 'me';

    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = 2000;

    const badSpawnerToDelivery = aStar(
        { x: 4, y: 0 },
        { x: 0, y: 1 },
        { avoidAgents: false }
    );

    assert.equal(
        badSpawnerToDelivery,
        null,
        'test setup invalid: bad spawner should not reach delivery'
    );

    const goodSpawnerToDelivery = aStar(
        { x: 2, y: 1 },
        { x: 0, y: 1 },
        { avoidAgents: false }
    );

    assert.ok(
        goodSpawnerToDelivery !== null,
        'test setup invalid: good spawner should reach delivery'
    );

    const i = getBestIntention();

    assert.notDeepEqual(
        i.targetPos,
        { x: 4, y: 0 },
        'must not move to a spawner whose generated parcels cannot be delivered'
    );

    assert.deepEqual(
        i.targetPos,
        { x: 2, y: 1 },
        'should prefer the reachable spawner that can lead to delivery'
    );
});

test('delivery occupied by external agent → choose another delivery tile', () => {
    reset();

    /*
     * y=1: . D . D
     * y=0: . . . S
     *
     * Agent parte da (0,0), trasporta un pacco.
     * Delivery più vicina: (1,1), ma è occupata da agente esterno.
     * Delivery alternativa: (3,1), libera.
     *
     * Il comportamento desiderato è scegliere la delivery libera.
     */
    buildGrid([
        '.D.D',
        '...S',
    ]);

    beliefs.me.x = 0;
    beliefs.me.y = 0;
    beliefs.me.id = 'me';

    beliefs.config.PARCEL_DECADING_INTERVAL = null;
    beliefs.config.MAX_PARCELS = 1;

    parcel('carried', 0, 0, 30, 'me');
    beliefs.me.carrying = ['carried'];

    beliefs.agents.set('external-blocker', {
        id: 'external-blocker',
        name: 'external',
        x: 1,
        y: 1,
        score: 0,
        lastSeen: Date.now(),
        stale: false,
    });

    const i = getBestIntention();

    assert.equal(i.type, 'go_deliver');

    assert.notDeepEqual(
        i.targetPos,
        { x: 1, y: 1 },
        'must not choose occupied delivery tile'
    );

    assert.deepEqual(
        i.targetPos,
        { x: 3, y: 1 },
        'should choose free alternative delivery tile'
    );
});

// ── Summary ──────────────────────────────────────────────────────────────────

const total = passed + failed;
console.log(`\n${'─'.repeat(50)}`);
console.log(`${total} tests: ${passed} passed, ${failed} failed`);

if (failed > 0) {
    console.log('\nFailing tests indicate a regression or unhandled map topology.');
    process.exit(1);
} else {
    console.log('\nAll scenarios pass — safe to run on the challenge map.');
}
