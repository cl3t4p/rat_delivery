import { beliefs, manhattanDistance } from '../../bdi/beliefs.js';

// How long without a message before we consider a peer gone
const PEER_TIMEOUT_MS = 8000;

// How long a parcel yield decision is kept before reconsidering
const YIELDED_PARCEL_TTL_MS = Number(process.env.YIELDED_PARCEL_TTL_MS) || 2000;

// Yield to a peer even if they are up to this many tiles farther than us
const CLAIM_MARGIN = 2;

// Returns true only if both x and y are real finite numbers
export function hasKnownPosition(pos) {
    return Number.isFinite(pos?.x) && Number.isFinite(pos?.y);
}

/**
 * @typedef {Object} PeerRecord
 * @property {string} id
 * @property {string} [name]
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} carrying
 * @property {number} score
 * @property {number} lastSeen
 * @property {{ type: string, parcelId: string|null, targetPos: Position|null, status: string, ts: number } | null} intention
 */
export const state = {
    // Known peers, keyed by peer id
    /** @type {Map<string, PeerRecord>} */
    peers: new Map(),
    // Which peer is heading to which parcel, keyed by parcel id
    /** @type {Map<string, { peerId: string, ts: number, status: string }>} */
    reservations: new Map(),
    // Parcels we already decided to yield; decision held for YIELDED_PARCEL_TTL_MS
    /** @type {Map<string, { peerId: string|null, expiresAt: number }>} */
    yieldedParcels: new Map(),
    // Outbound requests waiting for a reply, keyed by request timestamp
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    pendingRequests: new Map(),
};

// Injected by coordinator: called when a new peer is first seen
let _onNewPeer = null;

// Must be called once before using this module
export function initPeerState({ onNewPeer } = {}) {
    _onNewPeer = onNewPeer ?? null;
}

// Returns true if the message originates from this agent itself
export function isSelfMessage(envelope, senderId) {
    const selfId = beliefs.me.id;
    if (!selfId) return false;
    return senderId === selfId || envelope?.from === selfId;
}

/**
 * Looks up the peer record by id, creating a fresh one on first contact
 * On creation, fires _onNewPeer to trigger zone assignment
 * Refreshes lastSeen on every call to keep the peer alive
 * Returns null if id belongs to this agent
 */
export function touchPeer(id, name) {
    if (isSelfMessage(null, id)) return null;

    let peer = state.peers.get(id);
    if (!peer) {
        peer = {
            id,
            name,
            x: null,
            y: null,
            carrying: 0,
            score: 0,
            lastSeen: Date.now(),
            intention: null,
        };
        state.peers.set(id, peer);
        console.log(`[coord] new peer ${id} (${name ?? '?'}), scheduling zone assignment`);
        _onNewPeer?.();
    } else {
        peer.lastSeen = Date.now();
        if (name && !peer.name) peer.name = name;
    }
    return peer;
}

/**
 * Removes peers not heard from within PEER_TIMEOUT_MS and cleans up their reservations
 * Also drops reservations for unknown parcels
 */
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
    for (const parcelId of state.reservations.keys()) {
        if (!beliefs.parcels.has(parcelId)) state.reservations.delete(parcelId);
    }
}

// Returns all known peers after removing stale ones
export function getPeers() {
    pruneStale();
    return [...state.peers.values()];
}

// Returns true if any peer has claimed this parcel
export function isParcelClaimedByPeer(parcelId) {
    pruneStale();
    return state.reservations.has(parcelId);
}

/**
 * Returns the Manhattan distance from the claiming peer to the parcel,
 * or null if the parcel is not claimed or the peer position is unknown
 */
function peerDistanceToParcel(parcelId) {
    const r = state.reservations.get(parcelId);
    if (!r) return null;
    const peer = state.peers.get(r.peerId);
    if (!peer || peer.x === null || peer.y === null) return null;
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return null;
    return manhattanDistance({ x: peer.x, y: peer.y }, { x: parcel.x, y: parcel.y });
}

// Records that we are yielding this parcel, so we skip re-evaluating for YIELDED_PARCEL_TTL_MS
function rememberYieldedParcel(parcelId, peerId) {
    state.yieldedParcels.set(parcelId, {
        peerId,
        expiresAt: Date.now() + YIELDED_PARCEL_TTL_MS,
    });
}

/**
 * Returns true if we should let the peer take this parcel
 * Yields when the peer is closer (within CLAIM_MARGIN) or position is unknown
 * Remembers the decision for YIELDED_PARCEL_TTL_MS to avoid re-evaluating every tick
 */
export function shouldYieldParcel(parcelId, myPos) {
    if (!hasKnownPosition(myPos)) return false;

    const held = state.yieldedParcels.get(parcelId);
    if (held) {
        if (held.expiresAt > Date.now()) return true;
        state.yieldedParcels.delete(parcelId);
    }

    if (!isParcelClaimedByPeer(parcelId)) return false;
    const peerDist = peerDistanceToParcel(parcelId);
    if (peerDist === null) {
        rememberYieldedParcel(parcelId, null);
        return true;
    }
    const parcel = beliefs.parcels.get(parcelId);
    if (!parcel) return false;
    const myDist = manhattanDistance(myPos, { x: parcel.x, y: parcel.y });
    const shouldYield = peerDist < myDist + CLAIM_MARGIN;
    if (shouldYield) {
        const reservation = state.reservations.get(parcelId);
        rememberYieldedParcel(parcelId, reservation?.peerId ?? null);
    }
    return shouldYield;
}

// Returns true if agentId belongs to a known peer
export function isPeerId(agentId) {
    return getPeers().some((p) => p.id === agentId);
}

// Returns how many parcels the given peer is currently carrying
export function peerCarryingCount(agentId) {
    return getPeers().find((p) => p.id === agentId)?.carrying ?? 0;
}

/**
 * Clears all peer state and cancels pending request timers
 * Call this between tests to start from a clean slate
 */
export function resetPeerState() {
    for (const pending of state.pendingRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer);
    }
    state.peers.clear();
    state.reservations.clear();
    state.yieldedParcels.clear();
    state.pendingRequests.clear();
}
