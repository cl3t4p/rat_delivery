import { beliefs, manhattanDistance, canEnter, suppressClaimedParcel } from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { getZone } from '../../shared/zones.js';
import { MSG_TYPE, onMessage, replyTo } from '../communication.js';
import { touchPeer, isSelfMessage, state } from './peerState.js';
import { runHeuristicZoneAssignment, getNearestReachableZoneTarget } from './zoneAssignment.js';
import { handleHandoffRequest, DIR_DELTA_COORD } from './handoff.js';

// Flag set when Agent B commands this agent to pause via PEER_COMMAND
let _pausedByPeer = false;

/** Returns true while Agent B has commanded this agent to pause. */
export function isPausedByPeer() {
    return _pausedByPeer;
}

// Perpendicular directions to use when yielding right-of-way in a corridor
const PERP_DIRS = {
    left: ['up', 'down'],
    right: ['up', 'down'],
    up: ['left', 'right'],
    down: ['left', 'right'],
};

// How many consecutive same-direction backoffs before forcing a navigation escape
const PUSH_CHAIN_THRESHOLD = 2;
// Time window in which consecutive backoffs count as a push chain
const PUSH_CHAIN_WINDOW_MS = 2500;

// Pending yield direction consumed by the executor at the top of each tick
let _pendingYield = null;

let _pushChainDir = null;
let _pushChainCount = 0;
let _pushChainTs = 0;

/** @type {() => (import('../../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../../shared/types.js').Intention) => void} */
let _forceIntention = () => {};
/** @type {(force?: boolean) => void} */
let _requestRevision = () => {};

// Must be called once before using this module; also registers all message handlers
export function initMessageHandlers({ getCurrentIntention, forceIntention, requestRevision }) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
    if (requestRevision) _requestRevision = requestRevision;

    onMessage(MSG_TYPE.HELLO, (envelope, senderId, senderName) => {
        touchPeer(senderId, senderName);
    });
    onMessage(MSG_TYPE.BELIEF_UPDATE, handleBeliefUpdate);
    onMessage(MSG_TYPE.INTENTION_UPDATE, handleIntentionUpdate);
    onMessage(MSG_TYPE.REQUEST, handleRequest);
    onMessage(MSG_TYPE.RESPONSE, handleResponse);
    onMessage(MSG_TYPE.HANDOFF_REQUEST, handleHandoffRequest);
    onMessage(MSG_TYPE.BLOCKED_AT, handleBlockedAt);
    onMessage(MSG_TYPE.PARCEL_CLAIMED, handleParcelClaimed);
    onMessage(MSG_TYPE.PEER_COMMAND, handlePeerCommand);
}

/**
 * Returns and clears the pending yield direction, if any.
 * Called by the executor at the top of each loop tick
 */
export function consumeYieldRequest() {
    const dir = _pendingYield;
    _pendingYield = null;
    return dir;
}

// Clears _pendingYield; used by resetCoordinatorForTests in coordinator.js
export function clearPendingYield() {
    _pendingYield = null;
}

// Updates peer position, carrying count, and score from a belief_update message.
// Triggers a heuristic zone split the first time the peer's position becomes known
function handleBeliefUpdate(envelope, senderId, senderName) {
    const wasPositionUnknown = (state.peers.get(senderId)?.x ?? null) === null;
    const peer = touchPeer(senderId, senderName);
    if (!peer) return;
    const me = envelope.payload?.me;
    if (me) {
        if (typeof me.x === 'number') peer.x = me.x;
        if (typeof me.y === 'number') peer.y = me.y;
        if (typeof me.carrying === 'number') peer.carrying = me.carrying;
        if (typeof me.score === 'number') peer.score = me.score;
    }

    if (wasPositionUnknown && peer.x !== null && beliefs.me.x !== null) {
        runHeuristicZoneAssignment().catch(() => {});
    }
}

// Updates the peer's known intention and maintains the reservation table
function handleIntentionUpdate(envelope, senderId, senderName) {
    const peer = touchPeer(senderId, senderName);
    if (!peer) return;
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

    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const isActive = intention.status === 'pending' || intention.status === 'active';
        if (isActive) {
            state.reservations.set(intention.parcelId, {
                peerId: senderId,
                ts: envelope.ts,
                status: intention.status,
            });
        } else {
            const existing = state.reservations.get(intention.parcelId);
            if (existing?.peerId === senderId) {
                state.reservations.delete(intention.parcelId);
            }
        }
    }
}

// Handles a take_parcel request from a peer; replies with accept/refuse
function handleRequest(envelope, senderId, senderName) {
    if (!touchPeer(senderId, senderName)) return;
    const { action, parcelId } = envelope.payload ?? {};

    if (action === 'take_parcel') {
        const decision = evaluateTakeover(parcelId);
        replyTo(envelope, decision.accepted, decision.reason);
        if (decision.accepted && parcelId) {
            const r = state.reservations.get(parcelId);
            if (r?.peerId === senderId) state.reservations.delete(parcelId);
        }
        return;
    }

    replyTo(envelope, false, 'unknown');
}

// Resolves a pending outbound request when the peer replies
function handleResponse(envelope, senderId) {
    const { requestId, accepted, reason, ...extraPayload } = envelope.payload ?? {};
    const pending = state.pendingRequests.get(requestId);
    if (pending && pending.peerId === senderId) {
        clearTimeout(pending.timer);
        state.pendingRequests.delete(requestId);
        pending.resolve({
            accepted: !!accepted,
            reason: reason ?? 'ok',
            requestId,
            ...extraPayload,
        });
    }
}

// Handles notification that the peer has claimed a parcel we may have been targeting.
// Suppresses our local pickup intention and triggers revision if needed
function handleParcelClaimed(envelope, senderId, senderName) {
    if (!touchPeer(senderId, senderName)) return;
    const parcelId = envelope.payload?.parcelId;
    if (!parcelId) return;

    state.reservations.delete(parcelId);
    state.yieldedParcels.delete(parcelId);

    suppressClaimedParcel(parcelId);

    const current = _getCurrentIntention();
    if (current?.type === 'go_pick_up' && current.parcelId === parcelId) {
        current.status = 'failed';
        console.log(`[coord] Parcel ${parcelId} claimed by ${senderId}; abandoning local pickup`);
        _requestRevision(true);
    }
}

// Handles a pause/resume command from Agent B (level-3 peer control)
function handlePeerCommand(envelope, senderId) {
    const { action } = envelope.payload ?? {};
    if (action === 'pause') {
        _pausedByPeer = true;
        console.log(`[coord] Paused by peer command from ${senderId}`);
    } else if (action === 'resume') {
        _pausedByPeer = false;
        console.log(`[coord] Resumed by peer command from ${senderId}`);
    }
}

/**
 * Handles a blocked-at signal from a peer: if we are the blocker, we yield
 * by stepping perpendicular or backing off.
 * Includes push-chain detection to escape narrow corridors after repeated backoffs
 */
function handleBlockedAt(envelope, senderId) {
    if (isSelfMessage(envelope, senderId)) return;

    const { x: bx, y: by, direction: blockedDir, carrying } = envelope.payload ?? {};
    if (bx === undefined || by === undefined || !blockedDir) return;

    const myX = Math.round(beliefs.me.x ?? -1);
    const myY = Math.round(beliefs.me.y ?? -1);
    if (myX !== bx || myY !== by) return;

    if (_pendingYield) return;

    const requesterCarry = Number.isFinite(carrying)
        ? carrying
        : (state.peers.get(senderId)?.carrying ?? 0);
    const myCarry = beliefs.me.carrying.length;
    if (myCarry > requesterCarry) {
        console.log(
            `[coord] Right-of-way: keeping priority at (${myX},${myY}) ` +
                `mine=${myCarry} requester=${requesterCarry}`
        );
        return;
    }

    const candidates = PERP_DIRS[blockedDir] ?? [];
    for (const dir of candidates) {
        const { dx, dy } = DIR_DELTA_COORD[dir];
        if (canEnter(myX, myY, myX + dx, myY + dy)) {
            _pendingYield = dir;
            _pushChainCount = 0;
            _pushChainDir = null;
            console.log(`[coord] Right-of-way: yielding ${dir} from (${myX},${myY})`);
            return;
        }
    }

    const { dx: bfDx, dy: bfDy } = DIR_DELTA_COORD[blockedDir] ?? {};
    const fallbackX = myX + (bfDx ?? 0);
    const fallbackY = myY + (bfDy ?? 0);
    const fallbackTile = beliefs.grid.get(`${fallbackX},${fallbackY}`);
    const wouldRetreatIntoDelivery = fallbackTile?.type === '2' && beliefs.me.carrying.length === 0;

    if (
        bfDx !== undefined &&
        !wouldRetreatIntoDelivery &&
        canEnter(myX, myY, fallbackX, fallbackY)
    ) {
        const now = Date.now();
        if (_pushChainDir === blockedDir && now - _pushChainTs < PUSH_CHAIN_WINDOW_MS) {
            _pushChainCount++;
        } else {
            _pushChainCount = 1;
            _pushChainDir = blockedDir;
        }
        _pushChainTs = now;

        if (_pushChainCount >= PUSH_CHAIN_THRESHOLD) {
            _pushChainCount = 0;
            _pushChainDir = null;
            const myPos = { x: myX, y: myY };
            const zone = getZone(myPos, beliefs.grid);
            const target = getNearestReachableZoneTarget(zone, myPos);
            if (target && (target.x !== myX || target.y !== myY)) {
                console.log(
                    `[coord] Push-chain break (${PUSH_CHAIN_THRESHOLD}×${blockedDir}), ` +
                        `go_to (${target.x},${target.y})`
                );
                _forceIntention(createIntention('go_to', null, target, 5));
            } else {
                _requestRevision(true);
            }
            return;
        }

        _pendingYield = blockedDir;
        console.log(`[coord] Right-of-way: backing off ${blockedDir} from (${myX},${myY})`);
        return;
    }

    if (wouldRetreatIntoDelivery) {
        console.log(
            `[coord] Right-of-way: not backing off ${blockedDir} into delivery ` +
                `from (${myX},${myY}) while empty`
        );
        return;
    }

    console.log(`[coord] Right-of-way: no free direction at (${myX},${myY}), staying`);
}

// Decides whether to accept a peer's request to take a parcel we are targeting
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
