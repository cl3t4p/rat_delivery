/**
 * Shared test helpers.
 * Each test file imports what it needs from here.
 */

import { beliefs } from '../src/bdi/beliefs.js';
import { invalidateBounds } from '../src/shared/zones.js';
import { setZoneConstraint, resetRoamTarget } from '../src/bdi/deliberation.js';

// ── Belief reset ─────────────────────────────────────────────────────────────

export function resetBeliefs() {
    beliefs.grid.clear();
    beliefs.parcels.clear();
    beliefs.agents.clear();
    beliefs.crates.clear();
    beliefs.blacklist.clear();
    beliefs.temporaryBlacklist.clear();
    beliefs.deliveryTiles = [];
    beliefs.me = { id: 'agent-test', name: 'test', x: null, y: null, score: 0, carrying: [] };
    beliefs.config = {
        PARCEL_DECADING_INTERVAL: null,
        PARCEL_GENERATION_INTERVAL: null,
        OBSERVATION_DISTANCE: null,
        MAX_PARCELS: 5,
        PARCEL_FORGET_MS: 5000,
        AGENT_STALE_MS: 3000,
        CLAIMED_PARCEL_SUPPRESS_MS: 8000,
    };
    invalidateBounds();
    resetRoamTarget();
    setZoneConstraint(null);
}

// ── Map builders ──────────────────────────────────────────────────────────────

/**
 * Builds a simple rectangular grid and populates beliefs.grid.
 *
 * Layout (5×5, 0-indexed, y=0 bottom):
 *   All tiles are walkable (type '1' = spawner) unless overridden.
 *
 * @param {number} [w=5]
 * @param {number} [h=5]
 * @param {Record<string,string>} [overrides]  key "x,y" → type string
 */
export function makeGrid(w = 5, h = 5, overrides = {}) {
    beliefs.grid.clear();
    beliefs.deliveryTiles = [];
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            const key = `${x},${y}`;
            const type = overrides[key] ?? '1';
            beliefs.grid.set(key, { type, delivery: type === '2' });
            if (type === '2') beliefs.deliveryTiles.push({ x, y });
        }
    }
    invalidateBounds();
}

/**
 * Adds a parcel directly to beliefs.parcels.
 */
export function addParcel(id, x, y, reward, carriedBy = null) {
    beliefs.parcels.set(id, {
        id,
        x,
        y,
        reward,
        carriedBy,
        lastSeen: Date.now(),
    });
}

/**
 * Sets agent me position.
 */
export function setMe(x, y, { carrying = [], score = 0 } = {}) {
    beliefs.me.x = x;
    beliefs.me.y = y;
    beliefs.me.carrying = carrying;
    beliefs.me.score = score;
}

// ── Mock socket ───────────────────────────────────────────────────────────────

/**
 * Minimal mock of a Deliveroo socket.
 * Captures the onMsg callback so tests can fire incoming messages.
 */
export class MockSocket {
    constructor() {
        this._msgHandlers = [];
        this.emittedShouts = [];
        this.emittedSays = [];
    }

    onMsg(cb) {
        this._msgHandlers.push(cb);
    }

    async emitShout(msg) {
        this.emittedShouts.push(msg);
        return 'ok';
    }

    async emitSay(toId, msg) {
        this.emittedSays.push({ toId, msg });
        return 'ok';
    }

    /** Simulate an incoming message from another agent. */
    simulateMsg(senderId, senderName, msg, reply = undefined) {
        for (const cb of this._msgHandlers) cb(senderId, senderName, msg, reply);
    }
}
