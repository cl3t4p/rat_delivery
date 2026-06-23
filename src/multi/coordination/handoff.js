import {
    beliefs,
    manhattanDistance,
    canEnter,
    isWalkable,
    suppressHandoffDrop,
    clearParcelSuppressions,
} from '../../bdi/beliefs.js';
import { createIntention } from '../../bdi/deliberation.js';
import { notifyIntentionDone, notifyActionFailed } from '../../bdi/intentionRevision.js';
import {
    deliveryValue,
    estimatedRewardAtDelivery,
    HANDOFF_DELIVERY_BONUS,
} from '../../bdi/scoring.js';
import { findNearestDeliveryTile } from '../../bdi/components/tilesearch.js';
import { MSG_TYPE, prepareDirect, replyTo } from '../communication.js';
import { getPeers, isPeerId, peerCarryingCount, state, touchPeer } from './peerState.js';
import { markHandoffActivity, findNearestWalkableTile } from './zoneAssignment.js';

// Required saving relative to A's direct delivery path.
const HANDOFF_GAIN_FRACTION = 0.2;
// Absolute minimum saving.
const HANDOFF_GAIN_MIN = 3;
// Maximum reward loss accepted for a handoff.
const HANDOFF_MAX_REWARD_LOSS = 2;

// Retry pacing when the peer is busy: fast retries first, then slower
const HANDOFF_BUSY_RETRY_MS = 300;
const HANDOFF_BUSY_SLOW_RETRY_MS = 1000;
const HANDOFF_BUSY_FAST_RETRIES = 6;

// Receiver wait budget at the staging tile.
const HANDOFF_STAGING_MAX_WAIT = 20;
// Sender waits for pickup confirmation before releasing.
const HANDOFF_SENDER_RELEASE_TIMEOUT_MS = 2000;
// Receiver pickup retry budget.
const HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS = 5;

// Cooldown between reactive blocked-delivery handoff attempts
const BLOCKED_HANDOFF_COOLDOWN_MS = 3000;

// Timeout for takeover and handoff request replies
export const REQUEST_TIMEOUT_MS = 1500;

// Cardinal direction deltas in grid coordinates
export const DIR_DELTA_COORD = {
    up: { dx: 0, dy: 1 },
    down: { dx: 0, dy: -1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
};

let _blockedHandoffInFlight = false;
let _lastBlockedHandoffAt = 0;

/** @type {() => (import('../../shared/types.js').Intention|null)} */
let _getCurrentIntention = () => null;
/** @type {(intention: import('../../shared/types.js').Intention) => void} */
let _forceIntention = () => {};
/** @type {(force?: boolean) => void} */
let _requestRevision = () => {};
/** @type {(intention: import('../../shared/types.js').Intention) => void} */
let _commitIntention = () => {};
/** @type {() => void} */
let _clearIntention = () => {};

export function initHandoff({
    getCurrentIntention,
    forceIntention,
    requestRevision,
    commitIntention,
    clearIntention,
}) {
    _getCurrentIntention = getCurrentIntention;
    _forceIntention = forceIntention;
    if (requestRevision) _requestRevision = requestRevision;
    if (commitIntention) _commitIntention = commitIntention;
    if (clearIntention) _clearIntention = clearIntention;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAtTile(tile) {
    if (!tile) return false;
    return Math.round(beliefs.me.x) === tile.x && Math.round(beliefs.me.y) === tile.y;
}

function directionTo(from, to) {
    if (!from || !to) return null;
    const dx = Math.round(to.x) - Math.round(from.x);
    const dy = Math.round(to.y) - Math.round(from.y);
    // Reverse lookup: find the direction name whose delta matches (dx, dy).
    for (const [name, delta] of Object.entries(DIR_DELTA_COORD)) {
        if (delta.dx === dx && delta.dy === dy) return name;
    }
    return null;
}

/**
 * Chooses a reachable meet tile between sender, receiver, and delivery.
 */
function findBestMeetTile(posA, posB) {
    const deliveryA = findNearestDeliveryTile(posA);
    if (!deliveryA) return null;

    // Balance both agents' travel cost along A's delivery path.
    const candidates = [];
    const steps = manhattanDistance(posA, deliveryA);
    for (let t = 0; t <= steps; t++) {
        const frac = steps === 0 ? 0 : t / steps;
        const cx = Math.round(posA.x + frac * (deliveryA.x - posA.x));
        const cy = Math.round(posA.y + frac * (deliveryA.y - posA.y));
        if (isWalkable(cx, cy)) {
            candidates.push({ x: cx, y: cy });
        }
    }
    // Midpoint fallback for maps where the delivery line is awkward.
    const mid = {
        x: Math.round((posA.x + posB.x) / 2),
        y: Math.round((posA.y + posB.y) / 2),
    };
    if (isWalkable(mid.x, mid.y)) candidates.push(mid);

    if (candidates.length === 0) {
        const nearest = findNearestWalkableTile(mid);
        return nearest ?? null;
    }

    candidates.sort(
        (a, b) =>
            Math.max(manhattanDistance(posA, a), manhattanDistance(posB, a)) -
            Math.max(manhattanDistance(posA, b), manhattanDistance(posB, b))
    );
    return candidates[0];
}

/**
 * Returns handoff data only when the route and score are worth it.
 */
export function evaluateHandoff() {
    if (beliefs.me.carrying.length < 1) return null;

    const peers = getPeers();
    const peer = peers[0] ?? null;
    if (!peer || peer.x === null || peer.y === null) return null;
    if (peer.x === null || peer.y === null) return null;

    const posA = { x: beliefs.me.x, y: beliefs.me.y };
    const posB = { x: peer.x, y: peer.y };

    const meetTile = findBestMeetTile(posA, posB);
    if (!meetTile) return null;

    const delivery = findNearestDeliveryTile(meetTile);
    if (!delivery) return null;

    const distADel = manhattanDistance(posA, delivery);
    const distAMeet = manhattanDistance(posA, meetTile);
    const distBMeet = manhattanDistance(posB, meetTile);
    const distMeetDel = manhattanDistance(meetTile, delivery);

    // Bonus handoffs can accept smaller step savings.
    let gainThreshold = 0;
    if (!beliefs.me.handoffBonusActive) {
        gainThreshold = Math.max(HANDOFF_GAIN_MIN, Math.round(distADel * HANDOFF_GAIN_FRACTION));
    }
    const savedASteps = distADel - distAMeet;
    const condition1 = savedASteps > gainThreshold;

    // If B is idle, compare against A delivering alone.
    let peerTarget = null;
    if (
        peer.intention?.status === 'active' &&
        (peer.intention.type === 'go_pick_up' || peer.intention.type === 'go_deliver') &&
        peer.intention.targetPos
    ) {
        peerTarget = peer.intention.targetPos;
    }
    const distBCurrent = peerTarget ? manhattanDistance(posB, peerTarget) : distADel;
    const condition2 = distBMeet + distMeetDel < distBCurrent;

    const valueAAlone = deliveryValue(beliefs.me.carrying, posA, delivery);
    const handoffSteps = distAMeet + distMeetDel;
    let bonus = 0;
    if (beliefs.me.handoffBonusActive) bonus = HANDOFF_DELIVERY_BONUS;
    let valueHandoff = 0;
    for (const id of beliefs.me.carrying) {
        const parcel = beliefs.parcels.get(id);
        if (!parcel) continue;
        valueHandoff += estimatedRewardAtDelivery(parcel.reward, handoffSteps) + bonus;
    }
    let conditionValue = false;
    if (savedASteps > gainThreshold && valueHandoff + HANDOFF_MAX_REWARD_LOSS >= valueAAlone) {
        conditionValue = true;
    }

    if (!condition1 || !condition2 || !conditionValue) {
        if (condition1 && condition2) {
            console.log(
                `[coord] Handoff rejected: Aalone=${valueAAlone.toFixed(1)} ` +
                    `handoff=${valueHandoff.toFixed(1)} savedA=${savedASteps} threshold=${gainThreshold}`
            );
        }
        return null;
    }

    console.log(
        `[coord] Handoff viable: Aalone=${valueAAlone.toFixed(1)} ` +
            `handoff=${valueHandoff.toFixed(1)} savedA=${savedASteps} threshold=${gainThreshold} ` +
            `route=max(${distAMeet},${distBMeet})+${distMeetDel} ` +
            `parcelDecay=${distAMeet}+${distMeetDel}`
    );
    return { meetTile, peerId: peer.id };
}

/**
 * Sends a handoff request to the peer and waits for acceptance.
 * Resolves with { accepted, reason, meetTile, stagingTile } or rejects on timeout
 */
function requestHandoff(meetTile, peerId) {
    return new Promise((resolve, reject) => {
        const { ts, send } = prepareDirect(peerId, MSG_TYPE.HANDOFF_REQUEST, { meetTile });
        const timer = setTimeout(() => {
            state.pendingRequests.delete(ts);
            reject(new Error('handoff_timeout'));
        }, REQUEST_TIMEOUT_MS);

        state.pendingRequests.set(ts, {
            resolve: (res) => {
                clearTimeout(timer);
                if (res.accepted) markHandoffActivity();
                resolve({
                    accepted: res.accepted,
                    reason: res.reason ?? 'ok',
                    meetTile,
                    stagingTile: res.stagingTile ?? null,
                });
            },
            reject,
            timer,
            peerId,
        });

        send()
            .then((result) => {
                if (result === null) {
                    clearTimeout(timer);
                    state.pendingRequests.delete(ts);
                    reject(new Error('send_failed'));
                }
            })
            .catch((err) => {
                clearTimeout(timer);
                state.pendingRequests.delete(ts);
                reject(err);
            });
    });
}

// Returns true if the intention is the placeholder wait held during a handoff retry
function isHandoffRetryWait(intention) {
    return intention?.type === 'wait' && intention._handoffRetry === true;
}

// Clears a stuck handoff retry wait so revision can produce a fresh intention
function abandonHandoffRetryWait() {
    if (isHandoffRetryWait(_getCurrentIntention())) {
        _clearIntention();
    }
}

/**
 * Proposes a handoff to the peer, retrying while the peer is busy.
 * Parks the agent on a placeholder wait intention during negotiation,
 * then commits go_handoff on acceptance
 */
export function proposeHandoff(handoff, attempt = 0) {
    // Nothing to hand off anymore: drop the plan and re-deliberate now.
    if (beliefs.me.carrying.length === 0) {
        _requestRevision(true);
        return;
    }

    // Park on a placeholder wait intention while negotiating with the peer.
    let current = _getCurrentIntention();
    if (!current || current.status === 'failed' || current.status === 'done') {
        // Hold position at the current tile, or null if it is unknown.
        let holdPos = null;
        if (beliefs.me.x !== null && beliefs.me.y !== null) {
            holdPos = { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) };
        }
        const hold = createIntention('wait', null, holdPos, 0);
        hold._handoffRetry = true;
        hold._handoffRetryPeerId = handoff.peerId;
        _commitIntention(hold);
        current = _getCurrentIntention();
    } else if (!isHandoffRetryWait(current)) {
        // Busy with a real intention, not a handoff wait: don't interrupt it.
        return;
    }

    // Refresh the timestamp so the wait intention is not pruned as stale.
    if (current) current.createdAt = Date.now();

    console.log(`[coord] Proposing handoff to ${handoff.peerId}`);
    requestHandoff(handoff.meetTile, handoff.peerId)
        .then((res) => {
            if (res.accepted) {
                // Bail if the agent moved off the handoff wait while we waited.
                const live = _getCurrentIntention();
                if (live && !isHandoffRetryWait(live)) return;
                console.log(`[coord] Handoff accepted, go_handoff`);
                // Commit the real go_handoff and attach peer tracking data.
                const intention = createIntention('go_handoff', null, handoff.meetTile, 0);
                intention._peerStagingTile = res.stagingTile ?? null;
                intention._peerId = handoff.peerId;
                intention._peerCarryBefore =
                    getPeers().find((p) => p.id === handoff.peerId)?.carrying ?? 0;
                _commitIntention(intention);
                return;
            }

            if (res.reason === 'busy') {
                // Peer is busy: bail if we left the wait, else schedule a retry.
                const live = _getCurrentIntention();
                if (live && !isHandoffRetryWait(live)) return;
                // Fast retries first, then back off to the slow interval.
                const delay =
                    attempt < HANDOFF_BUSY_FAST_RETRIES
                        ? HANDOFF_BUSY_RETRY_MS
                        : HANDOFF_BUSY_SLOW_RETRY_MS;
                console.log(
                    `[coord] Handoff peer busy, retry ` +
                        `${attempt + 1}${attempt >= HANDOFF_BUSY_FAST_RETRIES ? ' (slow)' : `/${HANDOFF_BUSY_FAST_RETRIES}`}`
                );
                setTimeout(() => proposeHandoff(handoff, attempt + 1), delay);
                return;
            }

            // Refused for any other reason: drop the wait and re-deliberate.
            abandonHandoffRetryWait();
            _requestRevision(true);
        })
        .catch(() => {
            // Request timed out or failed to send: drop the wait and re-deliberate.
            abandonHandoffRetryWait();
            _requestRevision(true);
        });
}

/**
 * Offers the load to an empty teammate blocking a delivery path.
 */
export async function tryBlockedDeliveryHandoff(intention, blockingAgent, blockerCarryCount) {
    // Only applies when delivering and an empty peer is blocking the path.
    if (
        intention.type !== 'go_deliver' ||
        beliefs.me.carrying.length === 0 ||
        !blockingAgent ||
        !isPeerId(blockingAgent.id) ||
        blockerCarryCount > 0
    ) {
        return false;
    }

    // Throttle: skip if a handoff is in flight or the cooldown has not elapsed.
    const now = Date.now();
    if (_blockedHandoffInFlight || now - _lastBlockedHandoffAt < BLOCKED_HANDOFF_COOLDOWN_MS) {
        await sleep(250);
        return true;
    }

    // Hand off right where we stand, on the blocked delivery tile.
    const meetTile = {
        x: Math.round(beliefs.me.x),
        y: Math.round(beliefs.me.y),
    };
    _blockedHandoffInFlight = true;
    _lastBlockedHandoffAt = now;

    console.log(
        `[coord] Blocked delivery: proposing handoff at (${meetTile.x},${meetTile.y}) ` +
            `to blocker ${blockingAgent.id}`
    );

    try {
        // Ask the blocker to take the load.
        const res = await requestHandoff(meetTile, blockingAgent.id);
        if (!res.accepted) {
            console.log(
                `[coord] Blocked delivery handoff refused by ${blockingAgent.id} ` +
                    `(${res.reason ?? 'unknown'})`
            );
            // Busy: hold briefly and signal a retry; otherwise give up.
            if (res.reason === 'busy') {
                await sleep(300);
                return true;
            }
            return false;
        }

        // Accepted: commit go_handoff and attach peer tracking data.
        const handoff = createIntention('go_handoff', null, meetTile, 0);
        handoff._peerId = blockingAgent.id;
        handoff._peerCarryBefore = blockerCarryCount;
        // Stage the peer on its own tile when it offered no staging tile.
        handoff._peerStagingTile = res.stagingTile ?? {
            x: Math.round(blockingAgent.x),
            y: Math.round(blockingAgent.y),
        };
        console.log(
            `[coord] Blocked delivery handoff accepted by ${blockingAgent.id}, ` +
                `go_handoff at (${meetTile.x},${meetTile.y})`
        );
        _forceIntention(handoff);
        return true;
    } catch (err) {
        // Request timed out or failed to send.
        console.log(`[coord] Blocked delivery handoff failed: ${err?.message ?? err}`);
        return false;
    } finally {
        _blockedHandoffInFlight = false;
    }
}

// Dispatches a handoff intention to its executor body (sender or receiver side)
export async function runHandoff(socket, intention, execCtx) {
    if (intention.type === 'go_handoff_receive') {
        await executeHandoffReceive(socket, intention, execCtx);
    } else {
        await executeHandoff(socket, intention, execCtx);
    }
}

/**
 * Sender side: walks to the meet tile, drops all parcels, vacates the tile
 * so the peer can enter and pick up, then waits for confirmation
 */
async function executeHandoff(socket, intention, execCtx) {
    if (!isAtTile(intention.targetPos)) {
        await execCtx.stepTowardsTarget(socket, intention);
        return;
    }

    const dropped = await execCtx.safeSocketAction('handoff putdown', () => socket.emitPutdown());
    if (dropped === null) return;
    const droppedIds = [...beliefs.me.carrying];
    beliefs.me.carrying = [];
    for (const id of droppedIds) suppressHandoffDrop(id);

    console.log(
        `[coord] Handoff: parcels dropped at (${intention.targetPos.x},${intention.targetPos.y})`
    );

    const stagingDir =
        intention._peerApproachDir ?? directionTo(intention.targetPos, intention._peerStagingTile);
    for (const dir of ['right', 'left', 'up', 'down']) {
        if (dir === stagingDir) continue;
        const fx = Math.round(beliefs.me.x);
        const fy = Math.round(beliefs.me.y);
        const { dx, dy } = DIR_DELTA_COORD[dir];
        const nx = fx + dx;
        const ny = fy + dy;
        if (canEnter(fx, fy, nx, ny)) {
            await execCtx.safeSocketAction(`handoff vacate ${dir}`, () => socket.emitMove(dir));
            console.log(`[coord] Handoff: vacated meet tile, moved ${dir}`);
            break;
        }
    }

    await waitForHandoffReceiver(intention);

    notifyIntentionDone();
}

// Waits until the peer's carrying count increases (confirming pickup) or times out
async function waitForHandoffReceiver(intention) {
    if (!intention._peerId) {
        await sleep(500);
        return;
    }

    const startedAt = Date.now();
    const peerCarryBefore = intention._peerCarryBefore ?? peerCarryingCount(intention._peerId);
    while (Date.now() - startedAt < HANDOFF_SENDER_RELEASE_TIMEOUT_MS) {
        const peerCarryNow = peerCarryingCount(intention._peerId);
        if (peerCarryNow > peerCarryBefore) {
            console.log(
                `[coord] Handoff: receiver ${intention._peerId} picked up; releasing sender`
            );
            return;
        }
        await sleep(100);
    }

    console.log(
        `[coord] Handoff: receiver confirmation timeout after ` +
            `${HANDOFF_SENDER_RELEASE_TIMEOUT_MS}ms; releasing sender`
    );
}

/**
 * Receiver side: walks to the staging tile and waits for parcels to appear,
 * then moves to the meet tile and picks them up.
 * After pickup the normal BDI loop takes over and produces go_deliver
 */
async function executeHandoffReceive(socket, intention, execCtx) {
    // The tile where the parcels will actually be dropped for pickup.
    const meetTile = intention._meetTile ?? intention.targetPos;

    // Not at the target yet: keep stepping toward it.
    if (!isAtTile(intention.targetPos)) {
        await execCtx.stepTowardsTarget(socket, intention);
        return;
    }

    // At the staging tile, waiting for the sender to drop on the meet tile.
    if (intention._meetTile && !isAtTile(meetTile)) {
        clearParcelSuppressions();

        // Have the dropped parcels appeared on the meet tile yet?
        const parcelReady = [...beliefs.parcels.values()].some(
            (parcel) =>
                !parcel.carriedBy &&
                Math.round(parcel.x) === meetTile.x &&
                Math.round(parcel.y) === meetTile.y
        );

        if (!parcelReady) {
            // Count this wait tick and fail once the budget runs out.
            intention._stagingWait = (intention._stagingWait ?? 0) + 1;
            if (intention._stagingWait >= HANDOFF_STAGING_MAX_WAIT) {
                console.log('[coord] Handoff receive: timed out waiting at staging tile, failing');
                notifyActionFailed('handoff_timeout');
                return;
            }
            console.log(
                `[coord] Handoff receive: waiting near meet tile ` +
                    `(${meetTile.x},${meetTile.y}) [${intention._stagingWait}/${HANDOFF_STAGING_MAX_WAIT}]`
            );
            await sleep(500);
            return;
        }

        // Parcels are ready: retarget onto the meet tile to go pick them up.
        intention.targetPos = meetTile;
        intention._pickupAttempts = 0;
        return;
    }

    // On the meet tile: try to pick up the dropped parcels.
    intention._pickupAttempts = (intention._pickupAttempts ?? 0) + 1;

    const picked = await execCtx.safeSocketAction('handoff pickup', () => socket.emitPickup());
    // Socket action failed: retry on a later tick.
    if (picked === null) return;

    if (!picked || picked.length === 0) {
        // Nothing picked up: fail after the attempt budget, else wait and retry.
        if (intention._pickupAttempts >= HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS) {
            console.log('[coord] Handoff receive: no parcels after max attempts, failing');
            notifyActionFailed('pickup_empty');
        } else {
            console.log(
                `[coord] Handoff receive: nothing yet, attempt ${intention._pickupAttempts}/${HANDOFF_RECEIVE_MAX_PICKUP_ATTEMPTS} — waiting`
            );
            await sleep(500);
        }
        return;
    }

    // Record each picked parcel as carried and flag it for the delivery bonus.
    for (const p of picked) {
        const id = p.id;
        const parcel = beliefs.parcels.get(id);
        if (parcel) parcel.carriedBy = beliefs.me.id;
        if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
        if (id) beliefs.me.handoffReceivedParcels.add(id);
    }

    console.log(
        `[coord] Handoff receive OK: picked up ${picked.length} parcel(s), +${HANDOFF_DELIVERY_BONUS} bonus each at delivery`
    );
    notifyIntentionDone();
}

// Returns the adjacent tile nearest to the receiver that can serve as a waiting spot
function findHandoffStagingTile(meetTile, myPos) {
    const candidates = Object.values(DIR_DELTA_COORD)
        .map(({ dx, dy }) => ({ x: meetTile.x + dx, y: meetTile.y + dy }))
        .filter((tile) => isWalkable(tile.x, tile.y));

    candidates.sort((a, b) => manhattanDistance(myPos, a) - manhattanDistance(myPos, b));

    return candidates[0] ?? null;
}

/**
 * Handles an incoming handoff request from the sender.
 * Accepts if not currently busy, picks a staging tile, and commits go_handoff_receive.
 * Exported so messageHandlers.js can register it with onMessage
 */
export function handleHandoffRequest(envelope, senderId) {
    if (!touchPeer(senderId)) return;
    const { meetTile } = envelope.payload ?? {};
    if (!meetTile) {
        replyTo(envelope, false, 'unknown');
        return;
    }

    const myIntention = _getCurrentIntention();
    const isHandoffCommitted =
        myIntention &&
        (myIntention.status === 'active' || myIntention.status === 'pending') &&
        (myIntention.type === 'go_handoff' || myIntention.type === 'go_handoff_receive');
    const isBusy =
        isHandoffCommitted ||
        (myIntention &&
            myIntention.status === 'active' &&
            (myIntention.type === 'go_pick_up' || myIntention.type === 'go_deliver'));

    if (isBusy) {
        replyTo(envelope, false, 'busy');
        console.log(`[coord] Handoff request refused: busy (${myIntention.type})`);
        return;
    }

    const stagingTile =
        findHandoffStagingTile(meetTile, {
            x: beliefs.me.x,
            y: beliefs.me.y,
        }) ?? meetTile;

    replyTo(envelope, true, 'ok', { stagingTile });
    markHandoffActivity();
    console.log(`[coord] Handoff request accepted: meet at (${meetTile.x},${meetTile.y})`);
    clearParcelSuppressions();

    const receiveIntention = createIntention('go_handoff_receive', null, stagingTile, 0);
    receiveIntention._meetTile = meetTile;
    _forceIntention(receiveIntention);
}
