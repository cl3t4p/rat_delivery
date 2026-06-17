/**
 * Installs the multi-agent hooks into the BDI coordination seam.
 */

import { registerCoordination } from '../bdi/coordination.js';
import {
    shouldYieldParcel,
    isParcelClaimedByPeer,
    requestTakeover,
    evaluateHandoff,
    proposeHandoff,
    tryBlockedDeliveryHandoff,
    runHandoff,
    getNearestReachableZoneTarget,
    consumeYieldRequest,
    getPeers,
    isPausedByPeer,
    isPeerGoToLocked,
    clearPeerGoToLock,
} from './coordination/coordinator.js';
import { broadcastIntention } from './notifier.js';
import { sendBroadcast, onMessage } from './communication.js';

/** Registers all multi-agent hooks. */
export function installMultiAgent() {
    registerCoordination({
        shouldYieldParcel,
        isParcelClaimedByPeer,
        requestTakeover,
        evaluateHandoff,
        proposeHandoff,
        tryBlockedDeliveryHandoff,
        runHandoff,
        getNearestReachableZoneTarget,
        consumeYieldRequest,
        getPeers,
        isPausedByPeer,
        isPeerGoToLocked,
        clearPeerGoToLock,
        broadcastIntention,
        sendBroadcast,
        onMessage,
    });
}
