import { MSG_TYPE, prepareDirect } from '../communication.js';
import { initPeerState, resetPeerState, state } from './peerState.js';
import { initZoneAssignment, scheduleZoneAssignment } from './zoneAssignment.js';
import { initHandoff, REQUEST_TIMEOUT_MS } from './handoff.js';
import { initMessageHandlers, clearPendingYield } from './messageHandlers.js';

/**
 * Wires coordinator submodules to the BDI callbacks.
 */
export function initCoordinator({
    getCurrentIntention,
    forceIntention,
    requestRevision,
    commitIntention,
    clearIntention,
}) {
    initPeerState({
        onNewPeer: () => scheduleZoneAssignment(),
    });

    initZoneAssignment({ getCurrentIntention, forceIntention });

    initHandoff({
        getCurrentIntention,
        forceIntention,
        requestRevision,
        commitIntention,
        clearIntention,
    });

    initMessageHandlers({ getCurrentIntention, forceIntention, requestRevision });

    console.log('[coord] init ok');
}

/**
 * Asks the claiming peer to release a parcel target.
 */
export function requestTakeover(parcelId) {
    const reservation = state.reservations.get(parcelId);
    if (!reservation) {
        return Promise.resolve({ accepted: true, reason: 'ok' });
    }

    return new Promise((resolve, reject) => {
        const payload = { action: 'take_parcel', parcelId };
        const { ts, send } = prepareDirect(reservation.peerId, MSG_TYPE.REQUEST, payload);
        const timer = setTimeout(() => {
            state.pendingRequests.delete(ts);
            reject(new Error('takeover_timeout'));
        }, REQUEST_TIMEOUT_MS);

        state.pendingRequests.set(ts, {
            resolve,
            reject,
            timer,
            parcelId,
            peerId: reservation.peerId,
        });

        console.log(
            `[coord] sending request take_parcel ${parcelId} to=${reservation.peerId} ts=${ts}`
        );

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

// Test reset hook.
export function resetCoordinatorForTests() {
    resetPeerState();
    clearPendingYield();
}

// Public coordinator API.
export { getPeers, isParcelClaimedByPeer, shouldYieldParcel } from './peerState.js';
export {
    setCoordinatorRole,
    startZoneAssignmentLoop,
    initZoneAssignHandler,
    getNearestReachableZoneTarget,
} from './zoneAssignment.js';
export {
    evaluateHandoff,
    proposeHandoff,
    tryBlockedDeliveryHandoff,
    runHandoff,
} from './handoff.js';
export {
    consumeYieldRequest,
    isPausedByPeer,
    isPeerGoToLocked,
    clearPeerGoToLock,
} from './messageHandlers.js';
