/**
 * communication.js
 *
 * Transport layer for the BDI ↔ LLM message protocol.
 *
 * Wraps the Deliveroo socket primitives:
 *   - socket.emitShout(msg)        — broadcast envelope to all agents
 *   - socket.emitSay(toId, msg)    — directed envelope
 *   - socket.onMsg((id, name, msg, reply)) — single inbound stream
 *
 * The same `onMsg` stream carries both structured envelopes and the
 * plain-string LLM objectives accepted by `llmAgent.setObjective`. We
 * differentiate at parse time: envelopes match `isEnvelope(msg)`,
 * everything else is forwarded to a fallback listener so the existing
 * objective flow keeps working.
 */

import { beliefs } from '../bdi/beliefs.js';

/** @typedef {import('../shared/types.js').MsgType} MsgType */
/** @typedef {import('../shared/types.js').Envelope} Envelope */

export const MSG_TYPE = Object.freeze({
    BELIEF_UPDATE: 'belief_update',
    INTENTION_UPDATE: 'intention_update',
    REQUEST: 'request',
    RESPONSE: 'response',
    ZONE_ASSIGN: 'zone_assign',
    HANDOFF_REQUEST: 'handoff_request',
    HANDOFF_RESPONSE: 'handoff_response',
});

const KNOWN_TYPES = new Set(Object.values(MSG_TYPE));

const state = {
    /** @type {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket | null} */
    socket: null,
    /** @type {() => (string|null)} */
    selfIdProvider: () => beliefs.me.id,
    /** @type {Map<MsgType, Set<Function>>} */
    listeners: new Map(),
    /** @type {Set<Function>} */
    fallbackListeners: new Set(),
};

// Initialization

/**
 * Wires the communication layer to the active Deliveroo socket.
 *
 * Must be called exactly once, right after `DjsConnect()`.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {{ selfIdProvider?: () => (string|null) }} [options]
 */
export function initCommunication(socket, options = {}) {
    if (state.socket) {
        console.warn('[comm] initCommunication called twice; ignoring');
        return;
    }
    state.socket = socket;
    if (options.selfIdProvider) state.selfIdProvider = options.selfIdProvider;

    socket.onMsg((senderId, senderName, msg, reply) => {
        if (isEnvelope(msg)) {
            dispatchEnvelope(msg, senderId, senderName, reply);
        } else {
            for (const cb of state.fallbackListeners) {
                try {
                    cb(senderId, senderName, msg, reply);
                } catch (err) {
                    console.error('[comm] fallback listener threw:', err);
                }
            }
        }
    });

    console.log('[comm] init ok');
}

// Send

/**
 * Broadcasts an envelope to every agent via `socket.emitShout`.
 *
 * @param {MsgType} type
 * @param {object} payload
 * @returns {Promise<any>} Server acknowledgment.
 */
export async function sendBroadcast(type, payload) {
    const envelope = makeEnvelope(type, payload, 'broadcast');
    if (!state.socket) {
        console.warn('[comm] sendBroadcast before init; dropping', type);
        return null;
    }
    logSend(envelope);
    return state.socket.emitShout(envelope);
}

/**
 * Sends a directed envelope to a single agent via `socket.emitSay`.
 *
 * @param {string} toId
 * @param {MsgType} type
 * @param {object} payload
 * @returns {Promise<'successful'|'failed'|any>}
 */
export async function sendDirect(toId, type, payload) {
    const envelope = makeEnvelope(type, payload, toId);
    if (!state.socket) {
        console.warn('[comm] sendDirect before init; dropping', type);
        return null;
    }
    logSend(envelope);
    return state.socket.emitSay(toId, envelope);
}

/**
 * Sends a `response` envelope correlated to a previously received `request`.
 *
 * @param {Envelope} requestEnvelope - The envelope that triggered this reply.
 * @param {boolean} accepted
 * @param {'ok'|'already_carrying'|'out_of_range'|'unknown'} [reason]
 * @returns {Promise<any>}
 */
export async function replyTo(requestEnvelope, accepted, reason = 'ok') {
    const payload = {
        requestId: requestEnvelope.ts,
        accepted,
        reason,
    };
    const targetId = requestEnvelope.from;
    if (targetId) {
        return sendDirect(targetId, MSG_TYPE.RESPONSE, payload);
    }
    return sendBroadcast(MSG_TYPE.RESPONSE, payload);
}

// Receive

/**
 * Registers a callback for envelopes of the given type.
 *
 * @param {MsgType} type
 * @param {(envelope: Envelope, senderId: string, senderName: string, reply?: Function) => void} cb
 * @returns {() => void} Unsubscribe function.
 */
export function onMessage(type, cb) {
    if (!state.listeners.has(type)) state.listeners.set(type, new Set());
    state.listeners.get(type).add(cb);
    return () => state.listeners.get(type)?.delete(cb);
}

/**
 * Registers a callback for non-envelope messages (e.g., natural-language
 * objectives received over the Deliveroo chat).
 *
 * @param {(senderId: string, senderName: string, msg: any, reply?: Function) => void} cb
 * @returns {() => void} Unsubscribe function.
 */
export function onFallbackMsg(cb) {
    state.fallbackListeners.add(cb);
    return () => state.fallbackListeners.delete(cb);
}

// Internals

function dispatchEnvelope(envelope, senderId, senderName, reply) {
    logRecv(envelope, senderId);
    const subs = state.listeners.get(envelope.type);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) {
        try {
            cb(envelope, senderId, senderName, reply);
        } catch (err) {
            console.error(`[comm] listener for ${envelope.type} threw:`, err);
        }
    }
}

function makeEnvelope(type, payload, to) {
    return {
        from: state.selfIdProvider() ?? null,
        to,
        type,
        ts: Date.now(),
        payload,
    };
}

function isEnvelope(msg) {
    return (
        msg !== null &&
        typeof msg === 'object' &&
        typeof msg.type === 'string' &&
        KNOWN_TYPES.has(msg.type) &&
        typeof msg.ts === 'number' &&
        'payload' in msg
    );
}

function logSend(envelope) {
    const dst = envelope.to === 'broadcast' ? '*' : envelope.to;
    console.log(`[comm] → ${envelope.type} to=${dst}`);
}

function logRecv(envelope, senderId) {
    console.log(`[comm] ← ${envelope.type} from=${senderId}`);
}
