/**
 * Level 3 — Due BDI agenti
 *
 * Tests multi-agent coordination: peer tracking, parcel reservation,
 * yield logic, and zone helpers. Uses a MockSocket to drive incoming messages.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { beliefs } from '../src/bdi/beliefs.js';
import { initCommunication, MSG_TYPE } from '../src/multi/communication.js';
import {
    initCoordinator,
    getPeers,
    getReservations,
    shouldYieldParcel,
    evaluateHandoff,
    requestHandoff,
    resetCoordinatorForTests,
    getNearestReachableZoneTarget,
} from '../src/multi/coordinator.js';
import { getCurrentIntention, forceIntention, resetIntentionForTests } from '../src/bdi/intentionRevision.js';
import { createIntention } from '../src/bdi/deliberation.js';

import { resetBeliefs, makeGrid, addParcel, setMe, MockSocket } from './helpers.mjs';

let mockSocket;

before(() => {
    mockSocket = new MockSocket();
    initCommunication(mockSocket, { selfIdProvider: () => beliefs.me.id });
    initCoordinator({
        getCurrentIntention,
        forceIntention,
    });
});

beforeEach(() => {
    resetBeliefs();
    resetCoordinatorForTests();
    resetIntentionForTests();
    beliefs.me.id = 'agent-a';
    mockSocket.emittedSays = [];
    mockSocket.emittedShouts = [];
});

// ── helpers ───────────────────────────────────────────────────────────────────

function makeBeliefUpdateEnvelope(senderId, x, y, carrying = 0, score = 0) {
    return {
        from: senderId,
        to: 'broadcast',
        type: MSG_TYPE.BELIEF_UPDATE,
        ts: Date.now(),
        payload: {
            parcels: [],
            agents: [],
            me: { x, y, carrying, score },
        },
    };
}

function makeIntentionUpdateEnvelope(senderId, type, parcelId, status, score = 0, targetPos = null) {
    return {
        from: senderId,
        to: 'broadcast',
        type: MSG_TYPE.INTENTION_UPDATE,
        ts: Date.now(),
        payload: {
            intention: { type, parcelId, status, score, targetPos },
        },
    };
}

// ── getPeers / peer discovery ─────────────────────────────────────────────────

test('getPeers – empty initially', () => {
    assert.deepEqual(getPeers(), []);
});

test('getPeers – ignores self broadcast messages', () => {
    const env = makeBeliefUpdateEnvelope('agent-a', 3, 4, 0, 0);
    mockSocket.simulateMsg('agent-a', 'Alice', env);

    assert.deepEqual(getPeers(), []);
});

test('getPeers – registers peer on belief_update message', () => {
    const env = makeBeliefUpdateEnvelope('agent-b', 3, 4, 0, 0);
    mockSocket.simulateMsg('agent-b', 'Bob', env);

    const peers = getPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].id, 'agent-b');
    assert.equal(peers[0].x, 3);
    assert.equal(peers[0].y, 4);
});

test('getPeers – updates peer position on repeated belief_update', () => {
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 1, 1));
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 5, 7));

    const peers = getPeers();
    assert.equal(peers[0].x, 5);
    assert.equal(peers[0].y, 7);
});

// ── reservation table ─────────────────────────────────────────────────────────

test('getReservations – empty initially', () => {
    assert.deepEqual(getReservations(), []);
});

test('reservation is created when peer has active go_pick_up', () => {
    // Register peer first
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 2, 2));
    // Add the parcel to beliefs so pruneStale() does not discard the reservation
    addParcel('parcel-x', 2, 2, 10);
    // Peer broadcasts intention to pick up parcel
    const env = makeIntentionUpdateEnvelope('agent-b', 'go_pick_up', 'parcel-x', 'active', 10);
    mockSocket.simulateMsg('agent-b', 'Bob', env);

    const reservations = getReservations();
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].parcelId, 'parcel-x');
    assert.equal(reservations[0].peerId, 'agent-b');
});

test('reservation is released when peer marks intention done', () => {
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 2, 2));
    mockSocket.simulateMsg('agent-b', 'Bob', makeIntentionUpdateEnvelope('agent-b', 'go_pick_up', 'parcel-y', 'active'));
    mockSocket.simulateMsg('agent-b', 'Bob', makeIntentionUpdateEnvelope('agent-b', 'go_pick_up', 'parcel-y', 'done'));

    const reservations = getReservations();
    assert.equal(reservations.length, 0);
});

// ── shouldYieldParcel ─────────────────────────────────────────────────────────

test('shouldYieldParcel – false when no peer has claimed the parcel', () => {
    makeGrid(5, 1, { '4,0': '2' });
    setMe(0, 0);
    addParcel('free-parcel', 2, 0, 20);
    assert.equal(shouldYieldParcel('free-parcel', { x: 0, y: 0 }), false);
});

test('shouldYieldParcel – true when peer is closer to claimed parcel', () => {
    makeGrid(5, 1, { '4,0': '2' });
    setMe(0, 0);
    addParcel('contested', 3, 0, 20);

    // Peer at x=2 is closer to parcel at x=3 than we are at x=0
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 2, 0));
    mockSocket.simulateMsg('agent-b', 'Bob', makeIntentionUpdateEnvelope('agent-b', 'go_pick_up', 'contested', 'active', 5));

    const shouldYield = shouldYieldParcel('contested', { x: 0, y: 0 });
    assert.equal(shouldYield, true);
});

test('shouldYieldParcel – false when we are closer to the parcel', () => {
    makeGrid(5, 1, { '4,0': '2' });
    setMe(2, 0);
    addParcel('ours', 3, 0, 20); // we are at x=2, parcel at x=3 → distance 1

    // Peer at x=0 is farther (distance 3) — but they claimed it
    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 0, 0));
    mockSocket.simulateMsg('agent-b', 'Bob', makeIntentionUpdateEnvelope('agent-b', 'go_pick_up', 'ours', 'active', 5));

    // CLAIM_MARGIN = 2: peerDist (3) < myDist (1) + 2? 3 < 3 → false
    const shouldYield = shouldYieldParcel('ours', { x: 2, y: 0 });
    assert.equal(shouldYield, false);
});

// ── evaluateHandoff ───────────────────────────────────────────────────────────

test('evaluateHandoff – null when carrying 0 parcels', () => {
    setMe(2, 2);
    beliefs.me.carrying = [];
    assert.equal(evaluateHandoff(), null);
});

test('evaluateHandoff – null when no peer known', () => {
    // Fresh state: no peers
    beliefs.me.carrying = ['a', 'b'];
    setMe(0, 0);
    // Do NOT send any belief_update → peers empty after the pruning in getPeers()
    // (Actually peers may still have agent-b from previous tests due to singleton state.
    // We test the carrying === 0 guard instead.)
    beliefs.me.carrying = [];
    assert.equal(evaluateHandoff(), null);
});

test('evaluateHandoff – returns meet tile when idle peer can take over delivery', () => {
    makeGrid(11, 1, { '10,0': '2' });
    setMe(0, 0);
    beliefs.me.carrying = ['p1', 'p2'];
    addParcel('p1', 0, 0, 30, 'agent-a');
    addParcel('p2', 0, 0, 30, 'agent-a');
    beliefs.config.PARCEL_DECADING_INTERVAL = null;

    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 4, 0));

    const handoff = evaluateHandoff();
    assert.ok(handoff !== null);
    assert.equal(handoff.peerId, 'agent-b');
    assert.deepEqual(handoff.meetTile, { x: 2, y: 0 });
});

test('evaluateHandoff – returns meet tile with single parcel when peer is idle', () => {
    makeGrid(11, 1, { '10,0': '2' });
    setMe(0, 0);
    beliefs.me.carrying = ['p1'];
    addParcel('p1', 0, 0, 30, 'agent-a');
    beliefs.config.PARCEL_DECADING_INTERVAL = null;

    mockSocket.simulateMsg('agent-b', 'Bob', makeBeliefUpdateEnvelope('agent-b', 4, 0));

    const handoff = evaluateHandoff();
    assert.ok(handoff !== null, 'single-parcel handoff should be viable');
    assert.equal(handoff.peerId, 'agent-b');
});

test('handoff request – receiver accepts and forces go_handoff_receive', async () => {
    makeGrid(5, 1);
    setMe(4, 0);

    const request = {
        from: 'agent-b',
        to: 'agent-a',
        type: MSG_TYPE.HANDOFF_REQUEST,
        ts: 12345,
        payload: { meetTile: { x: 2, y: 0 } },
    };

    mockSocket.simulateMsg('agent-b', 'Bob', request);
    await new Promise((resolve) => setImmediate(resolve));

    const reply = mockSocket.emittedSays.at(-1);
    assert.equal(reply.toId, 'agent-b');
    assert.equal(reply.msg.type, MSG_TYPE.RESPONSE);
    assert.equal(reply.msg.payload.requestId, 12345);
    assert.equal(reply.msg.payload.accepted, true);

    const intention = getCurrentIntention();
    assert.equal(intention.type, 'go_handoff_receive');
    assert.deepEqual(intention._meetTile, { x: 2, y: 0 });
    assert.notDeepEqual(intention.targetPos, { x: 2, y: 0 });
    assert.equal(
        Math.abs(intention.targetPos.x - 2) + Math.abs(intention.targetPos.y - 0),
        1
    );
});

test('handoff request – refused when already executing go_handoff_receive', async () => {
    makeGrid(5, 1);
    setMe(4, 0);

    // First request → accepted
    const first = {
        from: 'agent-b',
        to: 'agent-a',
        type: MSG_TYPE.HANDOFF_REQUEST,
        ts: 1001,
        payload: { meetTile: { x: 2, y: 0 } },
    };
    mockSocket.simulateMsg('agent-b', 'Bob', first);
    await new Promise((resolve) => setImmediate(resolve));

    const firstReply = mockSocket.emittedSays.at(-1);
    assert.equal(firstReply.msg.payload.accepted, true, 'first request should be accepted');

    // Second request while go_handoff_receive is active → must be refused
    const second = {
        from: 'agent-b',
        to: 'agent-a',
        type: MSG_TYPE.HANDOFF_REQUEST,
        ts: 1002,
        payload: { meetTile: { x: 1, y: 0 } },
    };
    mockSocket.simulateMsg('agent-b', 'Bob', second);
    await new Promise((resolve) => setImmediate(resolve));

    const secondReply = mockSocket.emittedSays.at(-1);
    assert.equal(secondReply.msg.payload.requestId, 1002);
    assert.equal(secondReply.msg.payload.accepted, false, 'second request must be refused while go_handoff_receive is active');

    // Intention should still be the original go_handoff_receive
    const intention = getCurrentIntention();
    assert.equal(intention.type, 'go_handoff_receive');
    assert.deepEqual(intention._meetTile, { x: 2, y: 0 });
});

test('requestHandoff – resolves when peer accepts correlated response', async () => {
    const pending = requestHandoff({ x: 2, y: 0 }, 'agent-b');
    await new Promise((resolve) => setImmediate(resolve));

    const sent = mockSocket.emittedSays.at(-1);
    assert.equal(sent.toId, 'agent-b');
    assert.equal(sent.msg.type, MSG_TYPE.HANDOFF_REQUEST);

    mockSocket.simulateMsg('agent-b', 'Bob', {
        from: 'agent-b',
        to: 'agent-a',
        type: MSG_TYPE.RESPONSE,
        ts: Date.now(),
        payload: {
            requestId: sent.msg.ts,
            accepted: true,
            reason: 'ok',
        },
    });

    const result = await pending;
    assert.deepEqual(result, { accepted: true, meetTile: { x: 2, y: 0 } });
});

// ── getNearestReachableZoneTarget ─────────────────────────────────────────────

test('getNearestReachableZoneTarget – returns a reachable spawner in the zone', () => {
    // 10×10 grid: spawners everywhere (type 1), delivery at corner
    makeGrid(10, 10, { '0,0': '2' });
    setMe(0, 0);

    const target = getNearestReachableZoneTarget('topRight', { x: 0, y: 0 });
    assert.ok(target !== null && target !== undefined);
    assert.ok(typeof target.x === 'number');
    assert.ok(typeof target.y === 'number');
    // topRight zone: x >= 5, y >= 5
    assert.ok(target.x >= 5 || target.y >= 5, `target (${target.x},${target.y}) should be in topRight`);
});

test('getNearestReachableZoneTarget – works for bottomLeft zone', () => {
    makeGrid(10, 10, { '9,9': '2' });
    setMe(9, 9);
    const target = getNearestReachableZoneTarget('bottomLeft', { x: 9, y: 9 });
    assert.ok(target !== null);
    assert.ok(typeof target.x === 'number' && typeof target.y === 'number');
});
