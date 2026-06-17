/**
 * communication.js
 *
 * Envelope transport over the Deliveroo chat socket.
 */

import { beliefs } from '../bdi/beliefs.js';
import { getPeers } from './coordination/peerState.js';

/** @typedef {import('../shared/types.js').MsgType} MsgType */
/** @typedef {import('../shared/types.js').Envelope} Envelope */

// Re-exported here for the multi-agent modules.
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

/**
 * Wires communication to the active Deliveroo socket.
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

/**
 * Sends an envelope to known teammates.
 *
 * @param {MsgType} type
 * @param {object} payload
 * @returns {Promise<any>}
 */
export async function sendBroadcast(type, payload) {
    if (!state.socket) {
        console.warn('[comm] sendBroadcast before init; dropping', type);
        return null;
    }

    const peers = getPeers();

    if (peers.length === 0) {
        if (type !== MSG_TYPE.HELLO) {
            return null;
        }
        const envelope = makeEnvelope(type, payload, 'broadcast');
        try {
            return await state.socket.emitShout(envelope);
        } catch (err) {
            logSendError(type, err);
            return null;
        }
    }

    let result = null;
    for (const peer of peers) {
        const envelope = makeEnvelope(type, payload, peer.id);
        logSend(envelope);
        try {
            result = await state.socket.emitSay(peer.id, envelope);
        } catch (err) {
            logSendError(type, err);
        }
    }
    return result;
}

/**
 * Sends one envelope to one agent.
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
 * Builds a request before sending, so the reply handler can be registered first.
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
 * Replies to a request envelope.
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

/**
 * Registers a callback for one envelope type.
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
 * Registers a callback for non-envelope chat messages.
 *
 * @param {(senderId: string, senderName: string, msg: any, reply?: Function) => void} cb
 * @returns {() => void} Unsubscribe function.
 */
export function onFallbackMsg(cb) {
    state.fallbackListeners.add(cb);
    return () => state.fallbackListeners.delete(cb);
}

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

// Keep high-frequency sync traffic out of normal logs.
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
