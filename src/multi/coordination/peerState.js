import { beliefs, manhattanDistance } from '../../bdi/beliefs.js';

// Peer expiry window.
const PEER_TIMEOUT_MS = 8000;

// How long to keep a local yield decision.
const YIELDED_PARCEL_TTL_MS = Number(process.env.YIELDED_PARCEL_TTL_MS) || 2000;

// Distance slack when respecting a peer claim.
const CLAIM_MARGIN = 2;

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
    /** @type {Map<string, PeerRecord>} */
    peers: new Map(),
    /** @type {Map<string, { peerId: string, ts: number, status: string }>} */
    reservations: new Map(),
    /** @type {Map<string, { peerId: string|null, expiresAt: number }>} */
    yieldedParcels: new Map(),
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    pendingRequests: new Map(),
};

// Called when a new peer is first seen.
let _onNewPeer = null;

export function initPeerState({ onNewPeer } = {}) {
    _onNewPeer = onNewPeer ?? null;
}

export function isSelfMessage(envelope, senderId) {
    const selfId = beliefs.me.id;
    if (!selfId) return false;
    return senderId === selfId || envelope?.from === selfId;
}

/**
 * Finds or creates a peer record.
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
 * Drops stale peers and reservations.
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

export function getPeers() {
    pruneStale();
    return [...state.peers.values()];
}

export function isParcelClaimedByPeer(parcelId) {
    pruneStale();
    return state.reservations.has(parcelId);
}

/**
 * Distance from the claiming peer to the parcel.
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

function rememberYieldedParcel(parcelId, peerId) {
    state.yieldedParcels.set(parcelId, {
        peerId,
        expiresAt: Date.now() + YIELDED_PARCEL_TTL_MS,
    });
}

/**
 * True when the peer claim should win locally.
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

export function isPeerId(agentId) {
    return getPeers().some((p) => p.id === agentId);
}

export function peerCarryingCount(agentId) {
    return getPeers().find((p) => p.id === agentId)?.carrying ?? 0;
}

/**
 * Clears peer state and pending request timers.
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
