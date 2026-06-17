/**
 * Seam between the BDI core and the optional multi-agent layer.
 */

/**
 * Message-type constants shared by BDI and multi-agent code.
 */
export const MSG_TYPE = Object.freeze({
    HELLO: 'hello',
    BELIEF_UPDATE: 'belief_update',
    INTENTION_UPDATE: 'intention_update',
    REQUEST: 'request',
    RESPONSE: 'response',
    ZONE_ASSIGN: 'zone_assign',
    HANDOFF_REQUEST: 'handoff_request',
    HANDOFF_RESPONSE: 'handoff_response',
    BLOCKED_AT: 'blocked_at',
    PARCEL_CLAIMED: 'parcel_claimed',
    PEER_COMMAND: 'peer_command',
});

// Solo defaults. installMultiAgent() replaces these in multi-agent mode.
const defaults = {
    shouldYieldParcel: () => false,
    isParcelClaimedByPeer: () => false,
    requestTakeover: () => Promise.resolve({ accepted: true, reason: 'solo' }),
    evaluateHandoff: () => null,
    proposeHandoff: () => {},
    requestHandoff: () => Promise.resolve({ accepted: false }),
    // Handoff intentions are never produced in solo mode.
    tryBlockedDeliveryHandoff: () => Promise.resolve(false),
    runHandoff: () => Promise.resolve(),
    getNearestReachableZoneTarget: () => null,
    consumeYieldRequest: () => null,
    getPeers: () => [],
    isPausedByPeer: () => false,
    isPeerGoToLocked: () => false,
    clearPeerGoToLock: () => {},
    broadcastIntention: () => {},
    // Callers expect sendBroadcast(...).catch(...).
    sendBroadcast: () => Promise.resolve(null),
    onMessage: () => {},
};

let impl = { ...defaults };

/**
 * Installs multi-agent implementations.
 *
 * @param {Partial<typeof defaults>} overrides
 */
export function registerCoordination(overrides) {
    impl = { ...defaults, ...overrides };
}

/** Restores solo no-op behaviour. */
export function resetCoordination() {
    impl = { ...defaults };
}

// Delegating exports used by the BDI core.
export const shouldYieldParcel = (...a) => impl.shouldYieldParcel(...a);
export const isParcelClaimedByPeer = (...a) => impl.isParcelClaimedByPeer(...a);
export const requestTakeover = (...a) => impl.requestTakeover(...a);
export const evaluateHandoff = (...a) => impl.evaluateHandoff(...a);
export const proposeHandoff = (...a) => impl.proposeHandoff(...a);
export const requestHandoff = (...a) => impl.requestHandoff(...a);
export const tryBlockedDeliveryHandoff = (...a) => impl.tryBlockedDeliveryHandoff(...a);
export const runHandoff = (...a) => impl.runHandoff(...a);
export const getNearestReachableZoneTarget = (...a) => impl.getNearestReachableZoneTarget(...a);
export const consumeYieldRequest = (...a) => impl.consumeYieldRequest(...a);
export const getPeers = (...a) => impl.getPeers(...a);
export const isPausedByPeer = (...a) => impl.isPausedByPeer(...a);
export const isPeerGoToLocked = (...a) => impl.isPeerGoToLocked(...a);
export const clearPeerGoToLock = (...a) => impl.clearPeerGoToLock(...a);
export const broadcastIntention = (...a) => impl.broadcastIntention(...a);
export const sendBroadcast = (...a) => impl.sendBroadcast(...a);
export const onMessage = (...a) => impl.onMessage(...a);
