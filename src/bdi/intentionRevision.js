/**
 * intentionRevision.js
 *
 * Gestisce il ciclo di vita delle Intentions.
 *
 * Responsabilità:
 *   1. Mantiene l'intention corrente
 *   2. Controlla se l'intention è ancora valida ad ogni sensing
 *      (es: il parcel target è sparito? Qualcuno lo ha preso?)
 *   3. Sostituisce l'intention con una migliore se ne appare una con score molto più alto
 *   4. Espone setCurrentIntention() per Persona B
 *   5. Riceve actionFailed() da Persona B per triggerare una revisione forzata
 *
 * INTERFACCIA CON PERSONA B:
 *   Persona B chiama:  getCurrentIntention()  per leggere l'intention attiva
 *   Persona B chiama:  notifyActionFailed(reason)  quando una mossa fallisce
 *   Persona B chiama:  notifyIntentionDone()  quando ha completato l'intention
*/

// ── STATO INTERNO E COSTANTI ──────────────────────────────────────────────────
import { beliefs } from "./beliefs.js";
import { getBestIntention, createIntention } from "./deliberation.js";

// soglia di miglioramento: sostituiamo l'intention corrente solo se quella nuova
const IMPROVEMENT_THRESHOLD = 5;

// intention che l'agente sta perseguendo in questo momento
let currentIntention = null;

// ── FUNZIONI PUBBLICHE ────────────────────────────────────────────────────────

// getCurrentIntention() -> restituisce l'intention corrente
export function getCurrentIntention() {
    return currentIntention;
}

// notifyActionFailed(reason) -> chiamata da Persona B quando una mossa fallisce
export function notifyActionFailed(reason) {
    console.log(`[intentionRevision] Fallita: ${reason} → rivaluto`);
    if (currentIntention) currentIntention.status = 'failed';
    revise(true);
}

// notifyIntentionDone() ->  chiamata da Persona B quando ha completato l'intention con successo
export function notifyIntentionDone() {
    console.log(`[intentionRevision] Completata: ${currentIntention?.type}`);
    if (currentIntention) currentIntention.status = 'done';
    currentIntention = null;
    revise(true);
}

// ── FUNZIONE DI VALIDITÀ ────────────────────────────────────────────────────────

// isIntentionStillValid(intention) -> controlla se l'intention corrente ha ancora senso
function isIntentionStillValid(intention) {
    switch (intention.type) {
        case 'go_pick_up' : {
            if (!intention.parcelId) return false;
            const parcel = beliefs.parcels.get(intention.parcelId);
            if (!parcel) { // sparito
                console.log(`[intentionRevision] Parcel ${intention.parcelId} sparito`);
                return false;
            }
            if (parcel.carriedBy && parcel.carriedBy !== beliefs.me.id) { // preso da altri
                console.log(`[intentionRevision] Parcel ${intention.parcelId} preso da qualcun altro (${parcel.carriedBy})`);
                return false;
            }
            if (parcel.reward <= 0) { // esaurito
                console.log(`[intentionRevision] Parcel ${intention.parcelId} reward esaurito`);
                return false;
            }
            return true;
        }

        case 'go_deliver': {
            return beliefs.me.carrying.length > 0; // valida solo se sto portando qualcosa
        }

        case 'explore':
        case 'wait':
            return true;  // sempre valide
    }
}

// ── FUNZIONE PRINCIPALE ────────────────────────────────────────────────────────

/**
 * revise(force = false) -> funzione principale di revisione. Chiamata:
 *   - Ad ogni sensing event (da index.js)
 *   - In modo forzato dopo un fallimento o completamento
*/
export function revise(force = false) {
    // ── 1. VERIFICA VALIDITÀ INTENTION CORRENTE ──────────────────────────────
    if (currentIntention && currentIntention.status === 'active') {
        if (!isIntentionStillValid(currentIntention)) {
            console.log(`[intentionRevision] Non più valida: ${currentIntention.type}`);
            currentIntention.status = 'failed';
            currentIntention = null;
        }
    }

    // ── 2. SE NON HO INTENTION ATTIVA → CALCOLA NUOVA ───────────────────────
    if (!currentIntention || currentIntention.status === 'failed' || currentIntention.status === 'done') {
        currentIntention = getBestIntention();
        console.log(`[intentionRevision] Nuova: ${currentIntention?.type} score=${currentIntention?.score}`);
        return;
    }

    // ── 3. HO GIÀ UN'INTENTION ATTIVA → CONFRONTA CON LA MIGLIORE ──────────
    if (!force && currentIntention.status === 'active') {
        const candidate = getBestIntention();
        if (!candidate) return;

        const improvement = candidate.score - currentIntention.score;
        if (improvement > IMPROVEMENT_THRESHOLD) {
            console.log(`[intentionRevision] Migliore trovata (+${improvement}): sostituisco`);
            currentIntention.status = 'failed';
            currentIntention = candidate;
        }
    }
}

// Chiamata da index.js ad ogni sensing
export function onSensingRevise() {
    revise(false);
}

