/**
 * Level 4 — Protocollo messaggi / chat
 *
 * Tests the communication layer: envelope parsing, dispatch, send, fallback.
 * Uses a fresh MockSocket (this file runs in its own process).
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { beliefs } from '../src/bdi/beliefs.js';
import {
    initCommunication,
    MSG_TYPE,
    sendBroadcast,
    sendDirect,
    replyTo,
    onMessage,
    onFallbackMsg,
} from '../src/multi/communication.js';

import { MockSocket } from './helpers.mjs';

let socket;

before(() => {
    beliefs.me.id = 'test-agent';
    socket = new MockSocket();
    initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
});

// ── sendBroadcast ─────────────────────────────────────────────────────────────

test('sendBroadcast – emits a valid envelope via emitShout', async () => {
    socket.emittedShouts.length = 0;
    await sendBroadcast(MSG_TYPE.BELIEF_UPDATE, { parcels: [], agents: [], me: {} });
    assert.equal(socket.emittedShouts.length, 1);
    const env = socket.emittedShouts[0];
    assert.equal(env.type, MSG_TYPE.BELIEF_UPDATE);
    assert.equal(env.to, 'broadcast');
    assert.equal(env.from, 'test-agent');
    assert.ok(typeof env.ts === 'number');
    assert.ok('payload' in env);
});

// ── sendDirect ────────────────────────────────────────────────────────────────

test('sendDirect – emits to the correct recipient via emitSay', async () => {
    socket.emittedSays.length = 0;
    await sendDirect('peer-99', MSG_TYPE.REQUEST, { action: 'take_parcel', parcelId: 'p1' });
    assert.equal(socket.emittedSays.length, 1);
    const { toId, msg } = socket.emittedSays[0];
    assert.equal(toId, 'peer-99');
    assert.equal(msg.type, MSG_TYPE.REQUEST);
    assert.equal(msg.to, 'peer-99');
    assert.equal(msg.payload.action, 'take_parcel');
});

// ── onMessage / dispatch ──────────────────────────────────────────────────────

test('onMessage – dispatches envelope to registered listener', () => {
    let received = null;
    const unsub = onMessage(MSG_TYPE.ZONE_ASSIGN, (env) => { received = env; });

    const envelope = {
        from: 'coordinator',
        to: 'test-agent',
        type: MSG_TYPE.ZONE_ASSIGN,
        ts: Date.now(),
        payload: { zone: 'topLeft', center: { x: 2, y: 8 }, score: 5 },
    };
    socket.simulateMsg('coordinator', 'Coordinator', envelope);

    assert.ok(received !== null);
    assert.equal(received.payload.zone, 'topLeft');
    unsub();
});

test('onMessage – does not dispatch envelope to wrong type listener', () => {
    let received = null;
    const unsub = onMessage(MSG_TYPE.HANDOFF_REQUEST, (env) => { received = env; });

    const envelope = {
        from: 'peer', to: 'broadcast',
        type: MSG_TYPE.BELIEF_UPDATE, ts: Date.now(),
        payload: { parcels: [], agents: [], me: {} },
    };
    socket.simulateMsg('peer', 'Peer', envelope);

    assert.equal(received, null);
    unsub();
});

test('onMessage – unsubscribe prevents further calls', () => {
    let callCount = 0;
    const unsub = onMessage(MSG_TYPE.PARCEL_CLAIMED, () => { callCount++; });

    const envelope = { from: 'x', to: 'broadcast', type: MSG_TYPE.PARCEL_CLAIMED, ts: Date.now(), payload: { parcelId: 'px' } };
    socket.simulateMsg('x', 'X', envelope);
    assert.equal(callCount, 1);

    unsub();
    socket.simulateMsg('x', 'X', { ...envelope, ts: Date.now() + 1 });
    assert.equal(callCount, 1); // still 1 after unsub
});

// ── onFallbackMsg ─────────────────────────────────────────────────────────────

test('onFallbackMsg – receives non-envelope plain string messages', () => {
    let fallbackMsg = null;
    const unsub = onFallbackMsg((_, __, msg) => { fallbackMsg = msg; });

    socket.simulateMsg('human', 'Human', 'focus on the top area');

    assert.equal(fallbackMsg, 'focus on the top area');
    unsub();
});

test('onFallbackMsg – does NOT receive structured envelope messages', () => {
    let fallbackCalled = false;
    const unsub = onFallbackMsg(() => { fallbackCalled = true; });

    // Structured envelope → should go to onMessage handlers, not fallback
    const envelope = {
        from: 'peer', to: 'broadcast',
        type: MSG_TYPE.BELIEF_UPDATE, ts: Date.now(),
        payload: { parcels: [], agents: [], me: {} },
    };
    socket.simulateMsg('peer', 'Peer', envelope);

    assert.equal(fallbackCalled, false);
    unsub();
});

// ── replyTo ───────────────────────────────────────────────────────────────────

test('replyTo – sends a RESPONSE envelope back to the requester', async () => {
    socket.emittedSays.length = 0;
    const requestEnvelope = {
        from: 'requester-77',
        to: 'test-agent',
        type: MSG_TYPE.REQUEST,
        ts: 12345,
        payload: { action: 'take_parcel', parcelId: 'p42' },
    };
    await replyTo(requestEnvelope, true, 'ok');

    assert.equal(socket.emittedSays.length, 1);
    const { toId, msg } = socket.emittedSays[0];
    assert.equal(toId, 'requester-77');
    assert.equal(msg.type, MSG_TYPE.RESPONSE);
    assert.equal(msg.payload.accepted, true);
    assert.equal(msg.payload.reason, 'ok');
    assert.equal(msg.payload.requestId, 12345);
});

// ── envelope shape validation ─────────────────────────────────────────────────

test('invalid envelope (missing type field) goes to fallback', () => {
    let fallbackMsg = null;
    const unsub = onFallbackMsg((_, __, msg) => { fallbackMsg = msg; });

    const badMsg = { ts: Date.now(), payload: {} }; // no `type`
    socket.simulateMsg('peer', 'Peer', badMsg);

    assert.deepEqual(fallbackMsg, badMsg);
    unsub();
});

test('invalid envelope (unknown type) goes to fallback', () => {
    let fallbackMsg = null;
    const unsub = onFallbackMsg((_, __, msg) => { fallbackMsg = msg; });

    const badMsg = { from: 'x', to: 'y', type: 'unknown_type_xyz', ts: Date.now(), payload: {} };
    socket.simulateMsg('peer', 'Peer', badMsg);

    assert.deepEqual(fallbackMsg, badMsg);
    unsub();
});

// ── MSG_TYPE constants ────────────────────────────────────────────────────────

test('MSG_TYPE contains all expected keys', () => {
    const expected = [
        'BELIEF_UPDATE', 'INTENTION_UPDATE', 'REQUEST', 'RESPONSE',
        'ZONE_ASSIGN', 'HANDOFF_REQUEST', 'HANDOFF_RESPONSE',
        'BLOCKED_AT', 'PARCEL_CLAIMED',
    ];
    for (const key of expected) {
        assert.ok(key in MSG_TYPE, `Missing MSG_TYPE.${key}`);
    }
});

test('MSG_TYPE is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(MSG_TYPE));
});
