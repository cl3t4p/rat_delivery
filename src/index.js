/**
 * index.js
 *
 * Connects the Deliveroo.js socket to the BDI modules.
 * This file acts as the glue layer: it receives game events
 * and forwards them to the appropriate modules.
 */

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import {
    beliefs,
    updateMap,
    updateMe,
    updateBeliefs,
    decayParcelsReward,
    clockEventToMs,
} from './bdi/beliefs.js';
import { onSensingRevise, getCurrentIntention } from './bdi/intentionRevision.js';
import { startExecutor } from './bdi/executor.js';
import { updateContext, setObjective } from './llm/llmAgent.js';
import { initCommunication, onFallbackMsg } from './multi/communication.js';
import { initCoordinator } from './multi/coordinator.js';
import { enableNotifier, tickBeliefDelta } from './multi/notifier.js';

const socket = DjsConnect();

// Multi-agent layer (Phase 2)
initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
initCoordinator();
enableNotifier();

// Receive map data.
socket.on('map', (width, height, tiles) => {
    console.log(`[index] Map received: ${width}x${height}`);
    updateMap(tiles);

    // Debug stuff
    const maxX = Math.max(...tiles.map((t) => t.x));
    const maxY = Math.max(...tiles.map((t) => t.y));
    for (let y = maxY; y >= 0; y--) {
        let row = '';
        for (let x = 0; x <= maxX; x++) {
            const t = tiles.find((t) => t.x === x && t.y === y);
            row += t ? t.type : '.';
            row += ' ';
        }
        console.log(`y=${y}: ${row}`);
    }
});

// Update agent
socket.on('you', (agent) => {
    updateMe(agent);
});

// Sensing loop
socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
    tickBeliefDelta();
    onSensingRevise();
    updateContext();
    logState();
});

// Load config
socket.onConfig((config) => {
    beliefs.config.PARCEL_DECADING_INTERVAL = config?.GAME?.parcels?.decaying_event ?? null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(
        config?.GAME?.parcels?.generation_event
    );
    beliefs.config.OBSERVATION_DISTANCE = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS = config?.GAME?.player?.capacity ?? 1;
    console.log('[index] Config:', beliefs.config);
});

// Decay local parcels
setInterval(() => {
    decayParcelsReward();
}, 1000);

// Start of the executor
startExecutor(socket);

// Receive plain-text LLM objectives via the Deliveroo chat.
// Structured envelopes are routed inside communication.js; this fallback
// covers non-envelope messages only.
onFallbackMsg((id, name, msg) => {
    console.log(`[index] Messaggio da ${name}: ${msg}`);
    if (typeof msg === 'string' && msg.trim() !== '') {
        setObjective(msg);
    }
});

// Debug: log the current state.
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
