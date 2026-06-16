/**
 * communication.js
 *
 * Transport layer for the message protocol between the BDI and LLM layers.
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

// Defined in the BDI seam so the BDI core can reference message types without
// importing the multi layer; re-exported here for the rest of multi/.
export { MSG_TYPE } from '../bdi/coordination.js';
import { MSG_TYPE } from '../bdi/coordination.js';

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

let _lastSendErrorLog = 0;
let _msgSeq = 0;

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
    try {
        return await state.socket.emitShout(envelope);
    } catch (err) {
        logSendError(type, err);
        return null;
    }
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
    try {
        await state.socket.emitSay(toId, envelope);
        return envelope.ts;
    } catch (err) {
        logSendError(type, err);
        return null;
    }
}

/**
 * Prepares a directed envelope synchronously and returns its ts plus a send
 * function. Use this when you need to register a response handler BEFORE the
 * message is sent — calling sendDirect and registering in its .then() creates
 * a race where a fast peer response can arrive before the handler is stored.
 *
 * @param {string} toId
 * @param {MsgType} type
 * @param {object} payload
 * @returns {{ ts: number, send: () => Promise<number|null> }}
 */
export function prepareDirect(toId, type, payload) {
    const envelope = makeEnvelope(type, payload, toId);
    return {
        ts: envelope.ts,
        send: async () => {
            if (!state.socket) {
                console.warn('[comm] prepareDirect: socket not init; dropping', type);
                return null;
            }
            logSend(envelope);
            try {
                await state.socket.emitSay(toId, envelope);
                return envelope.ts;
            } catch (err) {
                logSendError(type, err);
                return null;
            }
        },
    };
}

/**
 * Sends a `response` envelope correlated to a previously received `request`.
 *
 * @param {Envelope} requestEnvelope - The envelope that triggered this reply.
 * @param {boolean} accepted
 * @param {'ok'|'already_carrying'|'out_of_range'|'unknown'|'busy'} [reason]
 * @param {object} [extraPayload]
 * @returns {Promise<any>}
 */
export async function replyTo(requestEnvelope, accepted, reason = 'ok', extraPayload = {}) {
    const payload = {
        requestId: requestEnvelope.ts,
        accepted,
        reason,
        ...extraPayload,
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
        ts: Date.now() + (++_msgSeq % 1000) / 1000,
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

// belief_update and intention_update fire on every sensing tick and create
// thousands of log lines that bury the interesting events.
// Set LOG_COMM=true in the environment to restore full verbosity for debugging.
const LOG_COMM_VERBOSE = process.env.LOG_COMM === 'true';
const QUIET_TYPES = new Set([MSG_TYPE.BELIEF_UPDATE, MSG_TYPE.INTENTION_UPDATE]);

function logSend(envelope) {
    if (!LOG_COMM_VERBOSE && QUIET_TYPES.has(envelope.type)) return;
    const dst = envelope.to === 'broadcast' ? '*' : envelope.to;
    console.log(`[comm] send ${envelope.type} to=${dst}`);
}

function logRecv(envelope, senderId) {
    if (!LOG_COMM_VERBOSE && QUIET_TYPES.has(envelope.type)) return;
    console.log(`[comm] recv ${envelope.type} from=${senderId}`);
}

function logSendError(type, err) {
    const now = Date.now();
    if (now - _lastSendErrorLog < 2000) return;
    _lastSendErrorLog = now;
    console.log(`[comm] send ${type} failed: ${err?.message ?? err}`);
}
