/**
 * notifier.js
 *
 * Change detection for outbound belief and intention updates.
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
 * Enables broadcasts once communication is ready.
 */
export function enableNotifier() {
    commsReady = true;
}

/**
 * Broadcasts own-state changes. each sensing
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

/**
 * Broadcasts intention changes, deduplicated by target and status.
 *
 * @param {Intention | null} intention
 */
export function broadcastIntention(intention) {
    if (!commsReady) return;
    if (!intention) return;

    let tp = '';
    if (intention.targetPos) {
        tp = `${Math.round(intention.targetPos.x)},${Math.round(intention.targetPos.y)}`;
    }
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
