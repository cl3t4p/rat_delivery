/**
 * coordinator.js
 *
 * Policy layer built on top of communication.js. Maintains a registry
 * of peer state derived from incoming messages and exposes helpers that
 * the BDI deliberation/revision loop can consult to answer
 * "who picks which parcel?".
 *
 * Tracked state per peer:
 *   - last-known position and carrying count          (from belief_update)
 *   - last-known intention                            (from intention_update)
 * Plus a parcel reservation table keyed by `parcelId`.
 */

import { beliefs, manhattanDistance } from '../bdi/beliefs.js';
import { MSG_TYPE, onMessage, replyTo, sendDirect, sendBroadcast } from './communication.js';

/** @typedef {import('../shared/types.js').Envelope} Envelope */
/** @typedef {import('../shared/types.js').Position} Position */

const PEER_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 1500;

/**
 * @typedef {Object} PeerRecord
 * @property {string} id
 * @property {string} [name]
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} carrying
 * @property {number} lastSeen
 * @property {{ type: string, parcelId: string|null, targetPos: Position|null, status: string, ts: number } | null} intention
 */

const state = {
    /** @type {Map<string, PeerRecord>} */
    peers: new Map(),
    /** @type {Map<string, { peerId: string, ts: number, status: string }>} */
    reservations: new Map(),
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    pendingRequests: new Map(),
};

// Initialization

/**
 * Subscribes to the four message types so incoming envelopes flow into
 * the peer registry and reservation table.
 *
 * Call once, after `initCommunication(...)`.
 */
export function initCoordinator() {
    onMessage(MSG_TYPE.BELIEF_UPDATE, handleBeliefUpdate);
    onMessage(MSG_TYPE.INTENTION_UPDATE, handleIntentionUpdate);
    onMessage(MSG_TYPE.REQUEST, handleRequest);
    onMessage(MSG_TYPE.RESPONSE, handleResponse);
    console.log('[coord] init ok');
}

// Public helpers (consumed by deliberation / intentionRevision)

/**
 * Returns true if any peer has an active `go_pick_up` intention on the parcel.
 *
 * @param {string} parcelId
 * @returns {boolean}
 */
export function isParcelClaimedByPeer(parcelId) {
    pruneStale();
    return state.reservations.has(parcelId);
}

/**
 * Manhattan distance from the claiming peer to the parcel, or null if
 * the parcel is not claimed or peer position is unknown.
 *
 * @param {string} parcelId
 * @returns {number|null}
 */
export function peerDistanceToParcel(parcelId) {
    const r = state.reservations.get(parcelId);
    if (!r) return null;
    const peer = state.peers.get(r.peerId);
    if (!peer || peer.x === null || peer.y === null) return null;
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return null;
    return manhattanDistance({ x: peer.x, y: peer.y }, { x: parcel.x, y: parcel.y });
}

/**
 * True iff the parcel is claimed by a peer who is strictly closer than I am.
 * BDI deliberation calls this to skip parcels it should yield.
 *
 * @param {string} parcelId
 * @param {Position} myPos
 * @returns {boolean}
 */
export function shouldYieldParcel(parcelId, myPos) {
    if (!isParcelClaimedByPeer(parcelId)) return false;
    const peerDist = peerDistanceToParcel(parcelId);
    if (peerDist === null) return true; // unknown peer distance — be conservative and yield
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return false;
    const myDist = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    return peerDist < myDist;
}

/**
 * Asks the claiming peer to step aside so we can take the parcel.
 *
 * Resolves with the response envelope on acceptance/refusal, rejects
 * on timeout. Intended fire-and-forget from intentionRevision.
 *
 * @param {string} parcelId
 * @returns {Promise<{accepted: boolean, reason: string}>}
 */
export function requestTakeover(parcelId) {
    const reservation = state.reservations.get(parcelId);
    if (!reservation) {
        return Promise.resolve({ accepted: true, reason: 'ok' });
    }

    return new Promise((resolve, reject) => {
        const payload = { action: 'take_parcel', parcelId };
        sendDirect(reservation.peerId, MSG_TYPE.REQUEST, payload)
            .then(() => {
                // The ts on the envelope we actually sent is not exposed here.
                // We track by destination + parcelId since responses correlate
                // via requestId === request.ts, set by communication.js.
            })
            .catch(reject);

        // We do not know the ts of the envelope sent by communication.sendDirect
        // (it sets ts internally). Use a lightweight tag-by-parcelId fallback:
        const pendingKey = `${reservation.peerId}:${parcelId}`;
        const timer = setTimeout(() => {
            state.pendingRequests.delete(pendingKey);
            reject(new Error('takeover_timeout'));
        }, REQUEST_TIMEOUT_MS);

        state.pendingRequests.set(pendingKey, {
            resolve,
            reject,
            timer,
            parcelId,
            peerId: reservation.peerId,
        });

        console.log(`[coord] → request take_parcel ${parcelId} to=${reservation.peerId}`);
    });
}

/** Read-only access for debugging / tests. */
export function getPeers() {
    pruneStale();
    return [...state.peers.values()];
}

export function getReservations() {
    pruneStale();
    return [...state.reservations.entries()].map(([parcelId, r]) => ({ parcelId, ...r }));
}

// Message handlers

function handleBeliefUpdate(envelope, senderId, senderName) {
    const peer = touchPeer(senderId, senderName);
    const me = envelope.payload?.me;
    if (me) {
        if (typeof me.x === 'number') peer.x = me.x;
        if (typeof me.y === 'number') peer.y = me.y;
        if (typeof me.carrying === 'number') peer.carrying = me.carrying;
    }
    // Note: peer-reported parcel/agent deltas are not merged into our own
    // beliefs in Week 3 — doing so safely needs a provenance/trust model.
    // We use them only to keep peer position fresh.
}

function handleIntentionUpdate(envelope, senderId, senderName) {
    const peer = touchPeer(senderId, senderName);
    const intention = envelope.payload?.intention;
    if (!intention) return;

    peer.intention = {
        type: intention.type,
        parcelId: intention.parcelId ?? null,
        targetPos: intention.targetPos ?? null,
        status: intention.status,
        ts: envelope.ts,
    };

    // Reservation table maintenance
    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const isActive = intention.status === 'pending' || intention.status === 'active';
        if (isActive) {
            state.reservations.set(intention.parcelId, {
                peerId: senderId,
                ts: envelope.ts,
                status: intention.status,
            });
        } else {
            // done / failed → release the reservation if it was ours
            const existing = state.reservations.get(intention.parcelId);
            if (existing?.peerId === senderId) {
                state.reservations.delete(intention.parcelId);
            }
        }
    }
}

function handleRequest(envelope, senderId, senderName, reply) {
    touchPeer(senderId, senderName);
    const { action, parcelId } = envelope.payload ?? {};

    if (action === 'take_parcel') {
        const decision = evaluateTakeover(parcelId);
        replyTo(envelope, decision.accepted, decision.reason);
        if (decision.accepted && parcelId) {
            // Release our own reservation hold (if any) since we agreed to yield.
            const r = state.reservations.get(parcelId);
            if (r?.peerId === senderId) state.reservations.delete(parcelId);
        }
        return;
    }

    // avoid_tile / status_check — stubbed for Week 3.
    replyTo(envelope, false, 'unknown');
}

function handleResponse(envelope, senderId) {
    const { requestId, accepted, reason } = envelope.payload ?? {};
    // Resolve by (peerId, parcelId) tag since communication.js owns ts.
    // We accept whichever pending request from this peer matches.
    for (const [key, pending] of state.pendingRequests) {
        if (pending.peerId === senderId) {
            clearTimeout(pending.timer);
            state.pendingRequests.delete(key);
            pending.resolve({ accepted: !!accepted, reason: reason ?? 'ok', requestId });
            return;
        }
    }
}

// Helpers

function touchPeer(id, name) {
    let peer = state.peers.get(id);
    if (!peer) {
        peer = {
            id,
            name,
            x: null,
            y: null,
            carrying: 0,
            lastSeen: Date.now(),
            intention: null,
        };
        state.peers.set(id, peer);
        console.log(`[coord] new peer ${id} (${name ?? '?'})`);
    } else {
        peer.lastSeen = Date.now();
        if (name && !peer.name) peer.name = name;
    }
    return peer;
}

function pruneStale() {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    for (const [id, peer] of state.peers) {
        if (peer.lastSeen < cutoff) {
            state.peers.delete(id);
            for (const [parcelId, r] of state.reservations) {
                if (r.peerId === id) state.reservations.delete(parcelId);
            }
            console.log(`[coord] peer ${id} pruned`);
        }
    }
    // Also drop reservations on parcels we no longer know about.
    for (const parcelId of state.reservations.keys()) {
        if (!beliefs.parcels.has(parcelId)) state.reservations.delete(parcelId);
    }
}

function evaluateTakeover(parcelId) {
    if (!parcelId) return { accepted: false, reason: 'unknown' };
    const parcel = beliefs.parcels.get(parcelId);
    if (parcel?.carriedBy === beliefs.me.id) {
        return { accepted: false, reason: 'already_carrying' };
    }
    if (beliefs.me.carrying.includes(parcelId)) {
        return { accepted: false, reason: 'already_carrying' };
    }
    if (!parcel) {
        return { accepted: true, reason: 'out_of_range' };
    }
    return { accepted: true, reason: 'ok' };
}

// Re-exports for convenience
export { sendBroadcast, sendDirect };
