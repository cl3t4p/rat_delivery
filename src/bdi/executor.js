/**
 * executor.js  —  Persona B
 *
 *
 * Loop:
 *   1. legge intention da intentionRevision
 *   2. se manca il plan -> lo calcola con planTo
 *   3. consuma una mossa -> emitMove
 *   4. se è sul target -> emitPickup / emitPutdown
 *   5. notifica done / failed a intentionRevision
*/

import { beliefs } from './beliefs.js';
import { planTo } from './pathfinding.js';
import {
    getCurrentIntention,
    notifyIntentionDone,
    notifyActionFailed,
} from './intentionRevision.js';

// Tipi condivisi (definiti in src/shared/types.js)
/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */
/** @typedef {import('../shared/types.js').Position}  Position */

// ── HELPER ────────────────────────────────────────────────────

/**
 * Check if the agent is at the target
 * @param {Position} target 
 * @returns {boolean}
 */
function isAtTarget(target) {
    if (!target) return false;
    return Math.round(beliefs.me.x) === target.x
        && Math.round(beliefs.me.y) === target.y;
}

/**
 * Check if the position is valid
 * @returns {boolean}
 */
function meReady() {
    return beliefs.me.x !== null && beliefs.me.y !== null;
}

// ── LOOP PRINCIPALE ───────────────────────────────────────────

/**
 * Avvia il loop dell'executor. Va chiamato una sola volta dopo aver creato il socket.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 */
export async function startExecutor(socket) {
    /** @type {Intention | null} */
    let lastIntention = null;

    while (true) {
        // yield al sensing loop -- senza questo blocchiamo l'event loop
        await new Promise(r => setImmediate(r));

        if (!meReady()) continue;

        const intention = getCurrentIntention();
        if (!intention) continue;

        // Intention sostituita sotto i piedi (intentionRevision.revise)
        if (intention !== lastIntention) {
            lastIntention = intention;
            intention.status = 'active';
        }

        switch (intention.type) {
            case 'wait':
            case 'explore':
                // TODO Explore
                continue;

            case 'go_pick_up':
            case 'go_deliver':
                await stepTowardsTarget(socket, intention);
                continue;
        }
    }
}

// ── STEP VERSO IL TARGET ──────────────────────────────────────

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function stepTowardsTarget(socket, intention) {
    // 1. arrivato? -> fai l'azione finale e chiudi l'intention
    if (isAtTarget(intention.targetPos)) {
        await finalize(socket, intention);
        return;
    }

    // 2. plan vuoto -> calcola
    if (!intention.plan || intention.plan.length === 0) {
        const moves = planTo(intention.targetPos);
        if (moves.length === 0) {
            console.log(`[executor] Nessun path verso (${intention.targetPos.x},${intention.targetPos.y})`);
            notifyActionFailed('no_path');
            return;
        }
        intention.plan = moves;
    }

    // 3. esegui la prossima mossa
    const dir = intention.plan.shift();
    const moved = await socket.emitMove(dir);

    if (!moved) {
        // tile bloccata (muro, avversario, arrow). Buttiamo il plan, al prossimo giro replana.
        console.log(`[executor] Mossa fallita: ${dir} -> blocked`);
        intention.plan = [];
        notifyActionFailed('move_blocked');
        return;
    }

    // aggiorna subito la pos di me, così non aspettiamo il prossimo sensing
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
}

// ── AZIONE FINALE: PICKUP / PUTDOWN ──────────────────────────

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function finalize(socket, intention) {
    if (intention.type === 'go_pick_up') {
        const picked = await socket.emitPickup();
        if (!picked || picked.length === 0) {
            console.log(`[executor] Pickup vuoto (parcel ${intention.parcelId} probabilmente preso da altri)`);
            notifyActionFailed('pickup_empty');
            return;
        }

        // aggiornamento ottimistico: evita che la prossima deliberazione
        // ricreda che il parcel sia libero finché non arriva il prossimo sensing.
        for (const p of picked) {
            const id = p.id ?? intention.parcelId;
            const parcel = beliefs.parcels.get(id);
            if (parcel) parcel.carriedBy = beliefs.me.id;
            if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
        }

        console.log(`[executor] Pickup OK: ${picked.length} parcel(s) (carrying=${beliefs.me.carrying.length})`);
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_deliver') {
        const dropped = await socket.emitPutdown();

        // stesso trattamento ottimistico: rimuovi dal carrying e dai beliefs
        for (const p of (dropped ?? [])) {
            const id = p.id;
            if (id) beliefs.parcels.delete(id);
        }
        beliefs.me.carrying = [];

        console.log(`[executor] Delivery OK: ${(dropped ?? []).length} parcel(s)`);
        notifyIntentionDone();
        return;
    }
}
