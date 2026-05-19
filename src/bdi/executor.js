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

import { beliefs, canEnter } from './beliefs.js';
import { planTo } from './pathfinding.js';
import { planWithPDDL } from '../pddl/pddlPlanner.js';
import {
    getCurrentIntention,
    notifyIntentionDone,
    notifyActionFailed,
} from './intentionRevision.js';

// Planner selector:
//   USE_PDDL=true                    → use PDDL only (no fallback)
//   USE_PDDL=true + PDDL_FALLBACK=true → use PDDL, fall back to A* if it fails
//   default (USE_PDDL unset)         → use A* only
const USE_PDDL = process.env.USE_PDDL === 'true';
const PDDL_FALLBACK = process.env.PDDL_FALLBACK === 'true';

// Mappa direzione → delta, usata per il pre-check di canEnter prima di emitMove.
const DIR_DELTA = {
    up:    { dx:  0, dy:  1 },
    down:  { dx:  0, dy: -1 },
    left:  { dx: -1, dy:  0 },
    right: { dx:  1, dy:  0 },
};

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
                continue;

            case 'explore':
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

    // 2. plan vuoto -> calcola (PDDL se abilitato, altrimenti A*; fallback su A*)
    if (!intention.plan || intention.plan.length === 0) {
        const moves = await computePlan(intention);
        if (moves.length === 0) {
            console.log(`[executor] No path to (${intention.targetPos.x},${intention.targetPos.y})`);
            notifyActionFailed('no_path');
            return;
        }
        intention.plan = moves;
    }

    // 3. replan dinamico: la prossima tile del piano è ancora valida?
    //    Tra il momento in cui abbiamo pianificato e adesso può essere comparso
    //    un crate, un agente avversario, o l'arrow direction non torna.
    const next = intention.plan[0];
    if (!isStepValid(next)) {
        console.log(`[executor] Step ${next} no longer valid → replan`);
        intention.plan = [];
        return; // al prossimo giro entra nel ramo 2 e ricalcola
    }

    // 4. esegui la prossima mossa
    const dir = intention.plan.shift();
    const fxBefore = Math.round(beliefs.me.x);
    const fyBefore = Math.round(beliefs.me.y);
    const moved = await socket.emitMove(dir);

    if (!moved) {
        // tile bloccata (muro, avversario, arrow). Buttiamo il plan, al prossimo giro replana.
        const targetTile = beliefs.grid.get(`${fxBefore + (DIR_DELTA[dir]?.dx ?? 0)},${fyBefore + (DIR_DELTA[dir]?.dy ?? 0)}`);
        console.log(`[executor] Move failed: ${dir} from (${fxBefore},${fyBefore}) → tile=${targetTile?.type} moved=${JSON.stringify(moved)}`);
        intention.plan = [];
        notifyActionFailed('move_blocked');
        return;
    }

    // aggiorna subito la pos di me, così non aspettiamo il prossimo sensing
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
}

/**
 * Verifica che la prossima direzione del piano sia ancora percorribile
 * rispetto allo stato corrente dei beliefs (muri, crate, frecce one-way).
 * @param {Direction} dir
 * @returns {boolean}
 */
function isStepValid(dir) {
    const delta = DIR_DELTA[dir];
    if (!delta) return false;
    const fx = Math.round(beliefs.me.x);
    const fy = Math.round(beliefs.me.y);
    return canEnter(fx, fy, fx + delta.dx, fy + delta.dy);
}

/**
 * Calcola il piano per raggiungere targetPos: prima PDDL se USE_PDDL=true,
 * poi cade su A*. Restituisce [] se entrambi falliscono.
 * @param {Intention} intention
 * @returns {Promise<Direction[]>}
 */
async function computePlan(intention) {
    if (USE_PDDL) {
        const pddlMoves = await planWithPDDL(intention);
        if (pddlMoves && pddlMoves.length > 0) {
            console.log(`[executor] PDDL plan (${pddlMoves.length} moves)`);
            return pddlMoves;
        }
        if (!PDDL_FALLBACK) {
            console.log('[executor] PDDL unavailable, no fallback configured (set PDDL_FALLBACK=true to enable A*)');
            return [];
        }
        console.log('[executor] PDDL unavailable → A* fallback');
    }
    return planTo(intention.targetPos);
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
            console.log(`[executor] Empty pickup (parcel ${intention.parcelId} probably taken by another agent)`);
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

        // pulizia immediata e completa
        for (const id of beliefs.me.carrying) {
            beliefs.parcels.delete(id);   // rimuovi dai beliefs
        }
        beliefs.me.carrying = [];         // svuota carrying

        // poi aggiorna con quello che il server conferma
        for (const p of (dropped ?? [])) {
            if (p.id) beliefs.parcels.delete(p.id);
        }

        console.log(`[executor] Delivery OK: ${(dropped ?? []).length} parcel(s)`);
        notifyIntentionDone();
        return;
    }
}
