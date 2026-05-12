/**
 * index.js 
 *
 * Collega il socket di Deliveroo.js ai moduli BDI.
 * Questo file è il "collante": riceve gli eventi del gioco e
 * li smista ai moduli giusti.
*/

import 'dotenv/config';
import {DjsConnect} from '@unitn-asa/deliveroo-js-sdk/client';

import { beliefs, updateMap, updateMe, updateBeliefs, decayParcelsReward } from './bdi/beliefs.js';
import { onSensingRevise, getCurrentIntention } from './bdi/intentionRevision.js';

const socket = DjsConnect();

// ── 1. RICEZIONE MAPPA ──────────────────────────────────────────────────
socket.on('map', (width, height, tiles) => {
    console.log(`[index] Mappa ricevuta: ${width}x${height}`);
    updateMap(tiles);
});

// ── 2. AGGIORNAMENTO "ME" ───────────────────────────────────────────────
socket.on('you', (id, name, x, y, score) => {
    updateMe({id, name, x, y, score});
});

// ── 3. SENSING LOOP ─────────────────────────────────────────────────────
socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? []);
    onSensingRevise();
    logState();
});

// ── 4. CONFIG DEL GIOCO ─────────────────────────────────────────────────
socket.onConfig(config => {
    beliefs.config.PARCEL_DECADING_INTERVAL = config?.GAME?.parcel?.reward?.decadingInterval ?? null;
    beliefs.config.OBSERVATION_DISTANCE     = config?.GAME?.player?.observation_distance ?? null;
    console.log('[index] Config:', beliefs.config);
});


// ── DECAY LOCALE DEI PARCELS ────────────────────────────────────────────
setInterval(() => {
    decayParcelsReward();
}, 1000);

// ── DEBUG: LOG DELLO STATO CORRENTE ─────────────────────────────────────
function logState() {
    const intention = getCurrentIntention();
    console.log(
        `[state] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${beliefs.me.score}`,
        `carrying=${beliefs.me.carrying.length}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${intention?.type ?? 'nessuna'}`,
        intention?.parcelId ? `→ ${intention.parcelId}` : ''
    );
}




