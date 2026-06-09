/**
 * index_b.js
 *
 * Entry point for agent B (BDI + LLM coordinator).
 *
 * Shares all BDI modules with agent A (beliefs, deliberation, executor,
 * intentionRevision) but connects with TOKEN_B and runs the zone-assignment
 * LLM loop, which calls the LLM every 30 seconds and sends zone assignments
 * to both agents.
 *
 * Run in a second terminal alongside index.js:
 *   node src/index_b.js
 *
 * Required .env variables:
 *   TOKEN_B              — Deliveroo token for agent B
 *   HOST                 — game server host (shared with agent A)
 *   LITELLM_API_KEY      — LLM server API key (shared with agent A)
 *   LITELLM_BASE_URL     — LLM server base URL (optional, shared with agent A)
 *   LOCAL_MODEL          — LLM model name (optional, shared with agent A)
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
import { initCoordinator, startZoneAssignmentLoop } from './multi/coordinator.js';
import { enableNotifier, tickBeliefDelta } from './multi/notifier.js';

if (!process.env.TOKEN_B) {
    console.error('[index_b] TOKEN_B missing in .env');
    process.exit(1);
}

// Connect with agent B token.
const socket = DjsConnect(process.env.HOST, process.env.TOKEN_B);

// Multi-agent layer.
// Agent B owns the zone-assignment LLM loop: it calls the LLM and sends
// assignments to both itself and agent A via broadcast/direct messages.
initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
initCoordinator();
startZoneAssignmentLoop();
enableNotifier();

// Receive map data.
socket.on('map', (width, height, tiles) => {
    console.log(`[index_b] Map received: ${width}x${height}`);
    updateMap(tiles);
});

// Update agent.
socket.on('you', (agent) => {
    updateMe(agent);
});

// Sensing loop.
socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
    tickBeliefDelta();
    onSensingRevise();
    updateContext();
    logState();
});

// Load config.
socket.onConfig((config) => {
    beliefs.config.PARCEL_DECADING_INTERVAL = config?.GAME?.parcels?.decaying_event ?? null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(
        config?.GAME?.parcels?.generation_event
    );
    beliefs.config.OBSERVATION_DISTANCE = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS = config?.GAME?.player?.capacity ?? 1;
    console.log('[index_b] Config:', beliefs.config);
});

// Decay local parcels.
setInterval(() => {
    decayParcelsReward();
}, 1000);

// Start the executor loop.
startExecutor(socket);

// Receive plain-text LLM objectives via the Deliveroo chat.
onFallbackMsg((id, name, msg) => {
    console.log(`[index_b] Message from ${name}: ${msg}`);
    if (typeof msg === 'string' && msg.trim() !== '') {
        setObjective(msg);
    }
});

// Debug: log the current state.
function logState() {
    const intention = getCurrentIntention();
    console.log(
        `[state_b] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${beliefs.me.score}`,
        `carrying=${beliefs.me.carrying.length}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${intention?.type ?? 'none'}`,
        intention?.parcelId ? `→ ${intention.parcelId}` : ''
    );
}