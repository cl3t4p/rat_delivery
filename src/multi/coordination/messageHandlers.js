import { beliefs, manhattanDistance, canEnter, suppressClaimedParcel } from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { getZone } from '../../shared/zones.js';
import { MSG_TYPE, onMessage, replyTo } from '../communication.js';
import { touchPeer, isSelfMessage, state } from './peerState.js';
import { runHeuristicZoneAssignment, getNearestReachableZoneTarget } from './zoneAssignment.js';
import { handleHandoffRequest, DIR_DELTA_COORD } from './handoff.js';

/** @typedef {import('../../shared/types.js').Envelope} Envelope */

// Set when Agent B pauses this agent.
let _pausedByPeer = false;

// Auto-resume if the peer never sends a follow-up command.
const PEER_PAUSE_SAFETY_MS = 60000;
let _pauseSafetyTimer = null;

function _clearPauseSafety() {
    if (_pauseSafetyTimer !== null) {
        clearTimeout(_pauseSafetyTimer);
        _pauseSafetyTimer = null;
    }
}

function _armPauseSafety() {
    _clearPauseSafety();
    _pauseSafetyTimer = setTimeout(() => {
        _pauseSafetyTimer = null;
        if (_pausedByPeer) {
            console.log('[coord] Peer pause safety timeout — auto-resuming');
            _pausedByPeer = false;
            _requestRevision(true);
        }
    }, PEER_PAUSE_SAFETY_MS);
}

/** True while Agent B has paused this agent. */
export function isPausedByPeer() {
    return _pausedByPeer;
}

// Protects a peer-commanded go_to from normal deliberation replacement.
let _peerGoToLocked = false;

// Used by stop/go missions to freeze after the commanded move.
let _pauseAfterGoTo = false;

/** True while a peer-commanded go_to has not completed. */
export function isPeerGoToLocked() {
    return _peerGoToLocked;
}

/** Clears the peer go_to lock. */
export function clearPeerGoToLock() {
    _peerGoToLocked = false;
    if (_pauseAfterGoTo) {
        _pauseAfterGoTo = false;
        _pausedByPeer = true;
        _armPauseSafety();
        console.log('[coord] Re-pausing after peer-commanded go_to');
    }
}

// Perpendicular right-of-way moves in corridors.
const PERP_DIRS = {
    left: ['up', 'down'],
    right: ['up', 'down'],
    up: ['left', 'right'],
    down: ['left', 'right'],
};

// Same-direction backoffs before forcing an escape.
const PUSH_CHAIN_THRESHOLD = 2;
// Time window for a push chain.
const PUSH_CHAIN_WINDOW_MS = 2500;

// Yield direction consumed by the executor.
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
 * Returns and clears the pending yield direction.
 */
export function consumeYieldRequest() {
    const dir = _pendingYield;
    _pendingYield = null;
    return dir;
}

// Used by resetCoordinatorForTests.
export function clearPendingYield() {
    _pendingYield = null;
}

/**
 * Updates peer state from a belief_update message.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @param {string} [senderName]
 * @returns {void}
 */
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

/**
 * Updates the peer intention and reservation table.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @param {string} [senderName]
 * @returns {void}
 */
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

/**
 * Handles a peer request to take over a parcel.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @param {string} [senderName]
 * @returns {void}
 */
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

/**
 * Resolves an outbound request.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @returns {void}
 */
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

/**
 * Drops a local pickup if the peer already claimed it.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @param {string} [senderName]
 * @returns {void}
 */
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

/**
 * Handles peer control commands from Agent B.
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @returns {void}
 */
function handlePeerCommand(envelope, senderId) {
    const { action, x, y } = envelope.payload ?? {};
    if (action === 'pause') {
        _pausedByPeer = true;
        _armPauseSafety();
        console.log(`[coord] Paused by peer command from ${senderId}`);
    } else if (action === 'resume') {
        _pausedByPeer = false;
        _pauseAfterGoTo = false;
        _clearPauseSafety();
        console.log(`[coord] Resumed by peer command from ${senderId}`);
    } else if (action === 'handoff_bonus_active') {
        beliefs.me.handoffBonusActive = true;
        console.log('[coord] Handoff bonus activated by peer command');
    } else if (action === 'go_to') {
        const tx = Number(x);
        const ty = Number(y);
        if (Number.isInteger(tx) && Number.isInteger(ty)) {
            _pausedByPeer = false;
            _clearPauseSafety();
            _pauseAfterGoTo = !!envelope.payload?.pauseAfter;
            console.log(`[coord] Peer commanded go_to (${tx},${ty}) pauseAfter=${_pauseAfterGoTo}`);
            _peerGoToLocked = true;
            _forceIntention(createIntention('go_to', null, { x: tx, y: ty }, 0));
            _requestRevision(true);
        }
    }
}

/**
 * Handles a blocked-at signal from a peer: if we are the blocker, we yield
 * by stepping perpendicular or backing off.
 * Includes push-chain detection to escape narrow corridors after repeated backoffs
 *
 * @param {Envelope} envelope
 * @param {string} senderId
 * @returns {void}
 */
function handleBlockedAt(envelope, senderId) {
    // Ignore our own broadcast.
    if (isSelfMessage(envelope, senderId)) return;

    // Need a blocked tile and a direction to act on.
    const { x: bx, y: by, direction: blockedDir, carrying } = envelope.payload ?? {};
    if (bx === undefined || by === undefined || !blockedDir) return;

    // Only respond if we are actually standing on the blocked tile.
    const myX = Math.round(beliefs.me.x ?? -1);
    const myY = Math.round(beliefs.me.y ?? -1);
    if (myX !== bx || myY !== by) return;

    // A yield move is already queued; don't stack another.
    if (_pendingYield) return;

    // Right-of-way: the agent carrying more parcels keeps the tile.
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

    // Prefer stepping sideways (perpendicular) to clear the corridor.
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

    // No sideways exit: consider backing off along the blocked direction.
    const { dx: bfDx, dy: bfDy } = DIR_DELTA_COORD[blockedDir] ?? {};
    const fallbackX = myX + (bfDx ?? 0);
    const fallbackY = myY + (bfDy ?? 0);
    const fallbackTile = beliefs.grid.get(`${fallbackX},${fallbackY}`);
    // Don't retreat onto a delivery tile while empty-handed.
    const wouldRetreatIntoDelivery = fallbackTile?.type === '2' && beliefs.me.carrying.length === 0;

    if (
        bfDx !== undefined &&
        !wouldRetreatIntoDelivery &&
        canEnter(myX, myY, fallbackX, fallbackY)
    ) {
        // Track repeated backoffs in the same direction within a time window.
        const now = Date.now();
        if (_pushChainDir === blockedDir && now - _pushChainTs < PUSH_CHAIN_WINDOW_MS) {
            _pushChainCount++;
        } else {
            _pushChainCount = 1;
            _pushChainDir = blockedDir;
        }
        _pushChainTs = now;

        // Too many backoffs: break the loop by heading to a fresh zone target.
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

        // Otherwise queue a single backoff step in the blocked direction.
        _pendingYield = blockedDir;
        console.log(`[coord] Right-of-way: backing off ${blockedDir} from (${myX},${myY})`);
        return;
    }

    // Backoff would land on a delivery tile while empty: stay put instead.
    if (wouldRetreatIntoDelivery) {
        console.log(
            `[coord] Right-of-way: not backing off ${blockedDir} into delivery ` +
                `from (${myX},${myY}) while empty`
        );
        return;
    }

    // No perpendicular and no backoff available: hold position.
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
