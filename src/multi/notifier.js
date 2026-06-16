/**
 * notifier.js
 *
 * Change-detection helper that turns local belief / intention updates
 * into outbound `belief_update` and `intention_update` messages.
 *
 * Kept separate from `beliefs.js` and `intentionRevision.js` so the BDI
 * modules don't gain a hard dependency on the multi-agent layer: they
 * simply call notifier functions, which silently no-op until
 * `initCommunication` has run.
 */

import { beliefs } from '../bdi/beliefs.js';
import { MSG_TYPE, sendBroadcast } from './communication.js';

/** @typedef {import('../shared/types.js').Intention} Intention */

const snapshot = {
    me: {
        x: null,
        y: null,
        carrying: 0,
        score: 0,
    },
    intentionKey: null,
};

let commsReady = false;

/**
 * Tells the notifier that the communication layer is wired up.
 * Until called, `tickBeliefDelta` and `broadcastIntention` short-circuit.
 */
export function enableNotifier() {
    commsReady = true;
}

// Belief delta

/**
 * Computes the delta vs. the last snapshot of own beliefs and, if any,
 * broadcasts a `belief_update`. Called from `multiagent_a.js` / `multiagent_b.js` after every
 * `updateBeliefs(...)`.
 */
export function tickBeliefDelta() {
    if (!commsReady) return;

    const me = {
        x: beliefs.me.x,
        y: beliefs.me.y,
        carrying: beliefs.me.carrying.length,
        score: beliefs.me.score,
    };
    const meChanged =
        snapshot.me.x !== me.x ||
        snapshot.me.y !== me.y ||
        snapshot.me.carrying !== me.carrying ||
        snapshot.me.score !== me.score;

    if (!meChanged) return;

    snapshot.me = { ...me };
    sendBroadcast(MSG_TYPE.BELIEF_UPDATE, { me });
}

// Intention broadcast

/**
 * Broadcasts an `intention_update` describing the current intention.
 * Called from `intentionRevision.js` whenever the intention is replaced
 * or its status changes (active / done / failed).
 *
 * Deduplication: the same (parcelId, type, status) is not re-broadcast.
 *
 * @param {Intention | null} intention
 */
export function broadcastIntention(intention) {
    if (!commsReady) return;
    if (!intention) return;

    const tp = intention.targetPos
        ? `${Math.round(intention.targetPos.x)},${Math.round(intention.targetPos.y)}`
        : '';
    const key = `${intention.type}|${intention.parcelId ?? ''}|${intention.status}|${tp}`;
    if (key === snapshot.intentionKey) return;
    snapshot.intentionKey = key;

    sendBroadcast(MSG_TYPE.INTENTION_UPDATE, {
        intention: {
            type: intention.type,
            parcelId: intention.parcelId ?? null,
            targetPos: intention.targetPos ?? null,
            status: intention.status,
            score: intention.score ?? 0,
        },
    });
}
