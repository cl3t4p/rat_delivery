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
import { findNearestDeliveryTile, createIntention } from '../bdi/deliberation.js';

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

/**
 * Returns the zone name for a given position based on map midpoint.
 *
 * @param {{ x: number, y: number }} pos
 * @returns {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'}
 */
function getZone(pos) {
    let maxX = 0;
    let maxY = 0;
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    const midX = maxX / 2;
    const midY = maxY / 2;
    const top = pos.y >= midY;
    const right = pos.x >= midX;
    if (top && !right) return 'topLeft';
    if (top && right) return 'topRight';
    if (!top && !right) return 'bottomLeft';
    return 'bottomRight';
}

/**
 * Computes aggregated stats for each of the four map zones.
 *
 * @returns {Record<string, { totalReward: number, freeParcels: number, spawnerCount: number }>}
 */
function computeZoneStats() {
    let maxX = 0;
    let maxY = 0;
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    const midX = maxX / 2;
    const midY = maxY / 2;

    const zones = {
        topLeft:     { totalReward: 0, freeParcels: 0, spawnerCount: 0 },
        topRight:    { totalReward: 0, freeParcels: 0, spawnerCount: 0 },
        bottomLeft:  { totalReward: 0, freeParcels: 0, spawnerCount: 0 },
        bottomRight: { totalReward: 0, freeParcels: 0, spawnerCount: 0 },
    };

    for (const p of beliefs.parcels.values()) {
        if (p.carriedBy) continue;
        const zone = getZone({ x: p.x, y: p.y });
        zones[zone].freeParcels++;
        zones[zone].totalReward += p.reward;
    }

    for (const [key, tile] of beliefs.grid) {
        if (tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        const zone = getZone({ x, y });
        zones[zone].spawnerCount++;
    }

    return zones;
}

/**
 * Returns the center tile of a named zone.
 *
 * @param {'topLeft'|'topRight'|'bottomLeft'|'bottomRight'} zoneName
 * @returns {{ x: number, y: number }}
 */
function getZoneCenter(zoneName) {
    let maxX = 0;
    let maxY = 0;
    for (const key of beliefs.grid.keys()) {
        const [x, y] = key.split(',').map(Number);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }
    const midX = maxX / 2;
    const midY = maxY / 2;

    const centers = {
        topLeft:     { x: Math.round(midX / 2),         y: Math.round(midY + midY / 2) },
        topRight:    { x: Math.round(midX + midX / 2),  y: Math.round(midY + midY / 2) },
        bottomLeft:  { x: Math.round(midX / 2),         y: Math.round(midY / 2)        },
        bottomRight: { x: Math.round(midX + midX / 2),  y: Math.round(midY / 2)        },
    };

    return centers[zoneName];
}

/**
 * Evaluates whether handing off carried parcels to a peer is worthwhile.
 *
 * Uses the nearest delivery tile as the simplified meetTile.
 * Returns the meetTile if handoff is beneficial, null otherwise.
 *
 * Conditions (both must hold):
 *   1. dist(A→meet) + dist(B→meet) + dist(meet→delivery) < dist(A→delivery)
 *   2. dist(B→meet) + dist(meet→delivery) < dist(B→currentDelivery or nearestDelivery)
 *
 * @returns {{ meetTile: {x,y}, peerId: string } | null}
 */
export function evaluateHandoff() {
    if (beliefs.me.carrying.length < 2) return null;

    const peers = getPeers();
    const peer = peers[0] ?? null;
    if (!peer || peer.x === null || peer.y === null) return null;

    const posA = { x: beliefs.me.x, y: beliefs.me.y };
    const posB = { x: peer.x, y: peer.y };

    // meetTile = midpoint between A and B, rounded to nearest integer
    const meetTile = {
        x: Math.round((posA.x + posB.x) / 2),
        y: Math.round((posA.y + posB.y) / 2),
    };

    const delivery = findNearestDeliveryTile(meetTile);
    if (!delivery) return null;

    const distADel   = manhattanDistance(posA, delivery);
    const distAMeet  = manhattanDistance(posA, meetTile);
    const distBMeet  = manhattanDistance(posB, meetTile);
    const distMeetDel = manhattanDistance(meetTile, delivery);

    // Condition 1: full handoff route is shorter than A delivering alone
    const condition1 = distAMeet + distBMeet + distMeetDel < distADel;

    // Condition 2: B's detour to meetTile costs less than its current path
    const peerTarget = peer.intention?.targetPos ?? findNearestDeliveryTile(posB);
    const distBCurrent = peerTarget
        ? manhattanDistance(posB, peerTarget)
        : Infinity;
    const condition2 = distBMeet + distMeetDel < distBCurrent;

    if (!condition1 || !condition2) return null;

    console.log(
        `[coord] Handoff viable: distADel=${distADel} route=${distAMeet}+${distBMeet}+${distMeetDel}`
    );
    return { meetTile, peerId: peer.id };
}

// Initialization

/** @type {() => (import('../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../shared/types.js').Intention) => void} */
let _forceIntention = () => {};

/**
 * Initialises the coordinator.
 *
 * @param {{ getCurrentIntention: Function, forceIntention: Function }} callbacks
 */
export function initCoordinator({ getCurrentIntention, forceIntention }) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
    onMessage(MSG_TYPE.BELIEF_UPDATE, handleBeliefUpdate);
    onMessage(MSG_TYPE.INTENTION_UPDATE, handleIntentionUpdate);
    onMessage(MSG_TYPE.REQUEST, handleRequest);
    onMessage(MSG_TYPE.RESPONSE, handleResponse);
    onMessage(MSG_TYPE.HANDOFF_REQUEST, handleHandoffRequest);
    console.log('[coord] init ok');
}
// Zone assignment loop

// Runs every ZONE_ASSIGN_INTERVAL_MS. Fires early when the local agent is
// idle (wait or explore) — spare capacity the LLM can redirect immediately.

const ZONE_ASSIGN_INTERVAL_MS = 30_000;
const BOTH_BUSY_SCORE_THRESHOLD = 10;

/**
 * Starts the adaptive zone-assignment loop.
 *
 * Calls the LLM every 30 seconds (or immediately when the agent is idle)
 * and sends a go_to assignment to self and, if a peer is known, to the peer.
 *
 * Call once from index_b.js after initCoordinator().
 */
export function startZoneAssignmentLoop() {
    let lastCallTime = 0;

    async function tick() {
        const now = Date.now();
        const intention = _getCurrentIntention();
        const isIdle = !intention ||
            intention.type === 'wait' ||
            intention.type === 'explore';

        const elapsed = now - lastCallTime;
        const shouldCall = elapsed >= ZONE_ASSIGN_INTERVAL_MS || (isIdle && elapsed >= 5_000);

        if (!shouldCall || beliefs.me.x === null) {
            setTimeout(tick, 1_000);
            return;
        }

        // If both agents are busy with high-score intentions, delay the LLM
        // call — no point interrupting productive work.
        const peers = getPeers();
        const peer = peers[0] ?? null;
        const peerBusy = peer?.intention?.status === 'active' &&
            (peer.intention.score ?? 0) > BOTH_BUSY_SCORE_THRESHOLD;
        const selfBusy = intention &&
            intention.status === 'active' &&
            intention.score > BOTH_BUSY_SCORE_THRESHOLD;

        if (selfBusy && peerBusy) {
            console.log('[coord] Both agents busy with high-score intentions → delaying LLM call');
            setTimeout(tick, 5_000);
            return;
        }

        // Need at least one known peer to do a two-agent assignment

        const posA = { x: beliefs.me.x, y: beliefs.me.y };
        const posB = peer && peer.x !== null
            ? { x: peer.x, y: peer.y }
            : posA; // fallback: treat B as co-located

        const zoneStats = computeZoneStats();
        lastCallTime = now;

        const { callZoneAssignment } = await import('../llm/llmAgent.js');
        const assignment = await callZoneAssignment(zoneStats, posA, posB);
        if (!assignment) {
            setTimeout(tick, 1_000);
            return;
        }

        // Apply own assignment: send a go_to toward the zone center.
        const myZone = getZoneCenter(assignment.assignA);
        console.log(`[coord] Zone assignment → self: ${assignment.assignA} (${myZone.x},${myZone.y})`);
        sendBroadcast(MSG_TYPE.ZONE_ASSIGN, {
            targetId: beliefs.me.id,
            zone: assignment.assignA,
            center: myZone,
            totalReward: zoneStats[assignment.assignA].totalReward,
        });

        // Send peer assignment if we have a known peer.
        if (peer) {
            const peerZone = getZoneCenter(assignment.assignB);
            console.log(`[coord] Zone assignment → peer ${peer.id}: ${assignment.assignB}`);
            sendDirect(peer.id, MSG_TYPE.ZONE_ASSIGN, {
                targetId: peer.id,
                zone: assignment.assignB,
                center: peerZone,
                totalReward: zoneStats[assignment.assignB].totalReward,
            });
        }

        setTimeout(tick, 1_000);
    }

    setTimeout(tick, 5_000); // short delay on startup
    console.log('[coord] Zone assignment loop started');
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

/**
 * Proposes a parcel handoff to the first known peer.
 *
 * Sends a handoff_request with the meetTile and waits for acceptance.
 * Resolves with { accepted, meetTile } or rejects on timeout.
 *
 * @param {{ x: number, y: number }} meetTile
 * @param {string} peerId
 * @returns {Promise<{ accepted: boolean, meetTile: {x,y} }>}
 */
export function requestHandoff(meetTile, peerId) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('handoff_timeout'));
        }, REQUEST_TIMEOUT_MS);

        sendDirect(peerId, MSG_TYPE.HANDOFF_REQUEST, { meetTile })
            .then(() => {
                const pendingKey = `${peerId}:handoff`;
                state.pendingRequests.set(pendingKey, {
                    resolve: (res) => {
                        clearTimeout(timer);
                        resolve({ accepted: res.accepted, meetTile });
                    },
                    reject,
                    timer,
                    peerId,
                });
            })
            .catch(reject);
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
    // beliefs — doing so safely needs a provenance/trust model.
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
        score: intention.score ?? 0,
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

    // avoid_tile / status_check — not implemented.
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

function handleHandoffRequest(envelope, senderId) {
    touchPeer(senderId);
    const { meetTile } = envelope.payload ?? {};
    if (!meetTile) {
        replyTo(envelope, false, 'unknown');
        return;
    }

    const myIntention = _getCurrentIntention();
    const isBusy =
        myIntention &&
        myIntention.status === 'active' &&
        (myIntention.type === 'go_pick_up' || myIntention.type === 'go_deliver');

    if (isBusy) {
        replyTo(envelope, false, 'busy');
        console.log(`[coord] Handoff request refused: busy (${myIntention.type})`);
        return;
    }

    replyTo(envelope, true, 'ok');
    console.log(`[coord] Handoff request accepted: meet at (${meetTile.x},${meetTile.y})`);

    const receiveIntention = createIntention('go_handoff_receive', null, meetTile, 0);
    _forceIntention(receiveIntention);
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
