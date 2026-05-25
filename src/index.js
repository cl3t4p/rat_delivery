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
import { startExecutor } from './bdi/executor.js';
import { updateContext, setObjective } from './llm/llmAgent.js';

const socket = DjsConnect();

// ── 1. RICEZIONE MAPPA ──────────────────────────────────────────────────
socket.on('map', (width, height, tiles) => {
    console.log(`[index] Map received: ${width}x${height}`);
    updateMap(tiles);

    // DEBUG: stampa la griglia (usa estensione reale dai tiles)
    const maxX = Math.max(...tiles.map(t => t.x));
    const maxY = Math.max(...tiles.map(t => t.y));
    for (let y = maxY; y >= 0; y--) {
        let row = '';
        for (let x = 0; x <= maxX; x++) {
            const t = tiles.find(t => t.x === x && t.y === y);
            row += t ? t.type : '.';
            row += ' ';
        }
        console.log(`y=${y}: ${row}`);
    }
});

// ── 2. AGGIORNAMENTO "ME" ───────────────────────────────────────────────
socket.on('you', (agent) => {
    updateMe(agent);
});

// ── 3. SENSING LOOP ─────────────────────────────────────────────────────
socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
    onSensingRevise();
    updateContext();
    logState();
});

// ── 4. CONFIG DEL GIOCO ─────────────────────────────────────────────────
socket.onConfig(config => {
    beliefs.config.PARCEL_DECADING_INTERVAL = config?.GAME?.parcels?.decaying_event ?? null;
    beliefs.config.OBSERVATION_DISTANCE     = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS              = config?.GAME?.player?.capacity ?? 1;
    console.log('[index] Config:', beliefs.config);
});


// ── DECAY LOCALE DEI PARCELS ────────────────────────────────────────────
setInterval(() => {
    decayParcelsReward();
}, 1000);

// ── AVVIO EXECUTOR ──────────────────────────────────────────────────────
startExecutor(socket);

// ── 5. RICEZIONE OBIETTIVO LLM ──────────────────────────────────────────
socket.onMsg((id, name, msg, reply) => {
    console.log(`[index] Messaggio da ${name}: ${msg}`);
    if (typeof msg === 'string' && msg.trim() !== '') {
        setObjective(msg);
    }
})

// ── DEBUG: LOG DELLO STATO CORRENTE ─────────────────────────────────────
function logState() {
    const intention = getCurrentIntention();
    console.log(
        `[state] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${beliefs.me.score}`,
        `carrying=${beliefs.me.carrying.length}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${intention?.type ?? 'none'}`,
        intention?.parcelId ? `→ ${intention.parcelId}` : ''
    );
}