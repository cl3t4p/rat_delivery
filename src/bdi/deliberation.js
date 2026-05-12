/**
 * deliberation.js  —  Persona A
 *
 * La "mente decisionale" dell'agente: dato il Belief Store, sceglie cosa fare.
 *
 * Responsabilità:
 *   1. Genera opzioni possibili (go_pick_up per ogni parcel libero)
 *   2. Assegna uno score di utilità a ogni opzione:
 *         utilità = reward_residuo - distanza_manhattan
 *   3. Sceglie l'opzione migliore e crea un oggetto Intention
 *   4. Gestisce anche il caso in cui non ci sono parcels (→ explore)
 *
 * INTERFACCIA CON PERSONA B:
 *   - Persona B chiama getBestIntention() per sapere cosa fare
 *   - Persona B segnala actionFailed(reason) per triggerare una revisione
*/

// oggetto standard
import { beliefs, manhattanDistance } from './beliefs.js';

// createIntention(type, parcelId, targetPos, score = 0) -> oggetto Intention standard
export function createIntention(type, parcelId, targetPos, score = 0) {
    return {
        type, // 'go_pick_up' | 'go_deliver' | 'explore' | 'wait'
        parcelId, // id del parcel target, null se non applicabile
        targetPos, // { x, y } destinazione, null se non applicabile
        plan: [], // mosse: ['up','up','right',...]
        status: 'pending', // ciclo di vita: pending -> active -> done o failed
        createdAt: Date.now(),
        score, // quanto vale questa intention
    }; 
}

// ── FUNZIONE PRINCIPALE ──────────────────────────────────────────────────

/**
 * getBestIntention() -> calcola e restituisce la migliore Intention possibile dato lo stato corrente dei beliefs
 * 1. se sto trasportando parcels -> vai a consegnare (go_deliver)
 * 2. se ci sono parcels liberi -> vai a prendere il migliore (go_pick_up)
 * 3. altrimenti -> esplora (explore)
*/

export function getBestIntention() {
    // dove sono
    if (beliefs.me.x === null || beliefs.me.y === null) {
        console.log('[deliberation] Posizione sconosciuta, aspetto...')
        return createIntention('wait', null, null, 0);
    }

    const me = {x: beliefs.me.x, y: beliefs.me.y};

    // ── CASO 1: Sto trasportando parcels → go_deliver ────────────────────────
    if (beliefs.me.carrying.length > 0) {
        const target = findNearestDeliveryTile(me);
        if (target) {
            const dist = manhattanDistance(me, target);
            // stima del reward totale che consegneremmo
            const totalReward = beliefs.me.carrying
                .map(id => beliefs.parcels.get(id)?.reward ?? 0)
                .reduce((a, b) => a + b, 0);

            console.log(`[deliberation] go_deliver verso (${target.x},${target.y}) score=${totalReward - dist}`);
            return createIntention('go_deliver', null, target, totalReward - dist);
        }
    }

    // ── CASO 2: Ci sono parcels liberi → go_pick_up ──────────────────────────
    const pickUp = findBestPickUp(me);
    if (pickUp) return pickUp;

    // ── CASO 3: Niente da fare → explore ────────────────────────────────────
    console.log('[deliberation] Nessun parcel disponibile → explore');
    return createIntention('explore', null, null, 0);
}

// ── FUNZIONI HELPER ──────────────────────────────────────────────────

// findNearestDeliveryTile(myPos) -> trova la delivery tile più vicina alla posizione corrente
export function findNearestDeliveryTile(myPos) {
    if (beliefs.deliveryTiles.length === 0) return null;

    let nearest = null;
    let nearestDist = Infinity;

    for (const tile of beliefs.deliveryTiles) {
        const dist = manhattanDistance(myPos, tile);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearest = tile;
        }
    }

    return nearest;
}

// findBestPickUp(myPos) -> cerca il parcel libero con la migliore utilità
export function findBestPickUp(myPos) {
    let bestScore = -Infinity;
    let bestIntention = null;

    for (const parcel of beliefs.parcels.values()) {
        if (parcel.carriedBy) continue; // salta i parcels già presi da qualcuno
        if (parcel.reward <= 0) continue; // salta i parcels senza reward

        const dist = manhattanDistance(myPos, {x: parcel.x, y: parcel.y});
        const score = parcel.reward - dist;

        if(score > bestScore) {
            bestScore = score;
            bestIntention = createIntention('go_pick_up', parcel.id, {x: parcel.x, y: parcel.y}, score);
        }
    }

    if (bestIntention) {
        console.log(`[deliberation] go_pick_up parcel=${bestIntention.parcelId} score=${bestIntention.score.toFixed(1)}`);
    }

    return bestIntention;
}

// ── ESPORTA TIPI (JSDoc) ──────────────────────────────────────────────────
 
/**
 * @typedef { {
 *   type: 'go_pick_up' | 'go_deliver' | 'explore' | 'wait',
 *   parcelId: string | null,
 *   targetPos: {x:number, y:number} | null,
 *   plan: string[],
 *   status: 'pending' | 'active' | 'done' | 'failed',
 *   createdAt: number,
 *   score: number
 * } } Intention
 */