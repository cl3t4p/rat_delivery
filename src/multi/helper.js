/**
 * helper.js — multi-agent layer entry
 *
 * Wires the real multi-agent implementations (coordinator, notifier, communication)
 * into the BDI coordination seam (src/bdi/coordination.js). Until this runs, the
 * BDI core behaves as a solo agent; after it runs, the same BDI core yields parcels,
 * hands off, broadcasts intentions and accepts zone assignments.
 *
 * A multi-agent entrypoint (multiagent_a.js / multiagent_b.js) calls installMultiAgent() once
 * at startup. A solo PDDL agent (pddl.js) never imports this file, so it stays solo.
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
} from './coordination/coordinator.js';
import { broadcastIntention } from './notifier.js';
import { sendBroadcast, onMessage } from './communication.js';

/**
 * Registers all multi-agent coordination hooks into the BDI seam. Idempotent.
 */
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
        broadcastIntention,
        sendBroadcast,
        onMessage,
    });
}
