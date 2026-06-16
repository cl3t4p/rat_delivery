/**
 * coordination.js — seam between single-agent and multi-agent modes
 *
 * The single-agent BDI core (deliberation, intentionRevision, executor) needs to
 * occasionally ask "is a peer handling this?" or "tell my peer what I'm doing".
 * To keep the BDI core free of any dependency on the multi-agent layer, those
 * calls go through this seam instead of importing `../multi/*` directly.
 *
 * By default every hook is a single-agent no-op: no peers, nothing claimed, no
 * broadcasts, no handoffs. A solo agent (pddl.js) therefore behaves as if it owns
 * the whole map. The multi-agent layer (src/multi/helper.js calls installMultiAgent())
 * overrides these hooks at startup with the real coordinator/notifier/communication
 * implementations.
 *
 * Dependency direction: bdi depends on coordination (no import of multi); multi depends on bdi.
 * This breaks the previous circular import between bdi and multi.
 */

/**
 * Message-type constants for the multi-agent protocol. Defined here (not in
 * multi/communication.js) so the BDI core can reference them without importing the
 * multi layer; communication.js re-exports these for the rest of multi/.
 */
export const MSG_TYPE = Object.freeze({
    BELIEF_UPDATE: 'belief_update',
    INTENTION_UPDATE: 'intention_update',
    REQUEST: 'request',
    RESPONSE: 'response',
    ZONE_ASSIGN: 'zone_assign',
    HANDOFF_REQUEST: 'handoff_request',
    HANDOFF_RESPONSE: 'handoff_response',
    BLOCKED_AT: 'blocked_at',
    PARCEL_CLAIMED: 'parcel_claimed',
});

// Single-agent defaults. Overridden by installMultiAgent() in multi mode.
const defaults = {
    // coordinator
    shouldYieldParcel: () => false,
    isParcelClaimedByPeer: () => false,
    requestTakeover: () => Promise.resolve({ accepted: true, reason: 'solo' }),
    evaluateHandoff: () => null,
    proposeHandoff: () => {},
    requestHandoff: () => Promise.resolve({ accepted: false }),
    // Handoff execution lives in the multi layer; in solo mode no go_handoff
    // intention is ever produced, so these stay inert no-ops.
    tryBlockedDeliveryHandoff: () => Promise.resolve(false),
    runHandoff: () => Promise.resolve(),
    getNearestReachableZoneTarget: () => null,
    consumeYieldRequest: () => null,
    getPeers: () => [],
    // notifier
    broadcastIntention: () => {},
    // communication. sendBroadcast must return a Promise: callers do
    // `sendBroadcast(...).catch(...)`, so a bare value would throw in solo mode.
    sendBroadcast: () => Promise.resolve(null),
    onMessage: () => {},
};

let impl = { ...defaults };

/**
 * Installs real multi-agent implementations. Called once at startup by the
 * multi-agent entrypoints (via multi/helper.js). Unlisted hooks keep their
 * single-agent default.
 *
 * @param {Partial<typeof defaults>} overrides
 */
export function registerCoordination(overrides) {
    impl = { ...defaults, ...overrides };
}

/** Restores single-agent no-op behaviour (used by tests). */
export function resetCoordination() {
    impl = { ...defaults };
}

// Delegating named exports: the BDI core imports these exactly as it used to
// import the multi functions, but they now route through the seam.
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
export const broadcastIntention = (...a) => impl.broadcastIntention(...a);
export const sendBroadcast = (...a) => impl.sendBroadcast(...a);
export const onMessage = (...a) => impl.onMessage(...a);
