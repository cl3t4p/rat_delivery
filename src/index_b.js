/**
 * index_b.js
 *
 * Entry point for Agent B.
 *
 * Agent B is the BDI + LLM coordinator:
 * - runs the same BDI loop as Agent A
 * - maintains LLM memory/context
 * - receives natural-language objectives
 * - starts the LLM zone-assignment loop
 * - sends coordination messages to Agent A
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

import {
    onSensingRevise,
    getCurrentIntention,
    forceIntention,
    revise,
    initZoneAssignHandler,
} from './bdi/intentionRevision.js';

import { startExecutor } from './bdi/executor.js';
import { updateContext, setObjective, initLlmAgent } from './llm/llmAgent.js';
import { initCommunication, onFallbackMsg } from './multi/communication.js';
import { initCoordinator, startZoneAssignmentLoop } from './multi/coordinator.js';
import { enableNotifier, tickBeliefDelta } from './multi/notifier.js';

if (!process.env.TOKEN_B) {
    console.error('[index_b] TOKEN_B missing in .env');
    process.exit(1);
}

const socket = DjsConnect(process.env.HOST, process.env.TOKEN_B);

// Multi-agent layer.
// Agent B owns the LLM coordination loop.
initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
initCoordinator({ getCurrentIntention, forceIntention });
initLlmAgent(revise);
initZoneAssignHandler();
startZoneAssignmentLoop();
enableNotifier();

socket.on('map', (width, height, tiles) => {
    console.log(`[index_b] Map received: ${width}x${height}`);
    updateMap(tiles);
});

socket.on('you', (agent) => {
    updateMe(agent);
});

socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
    tickBeliefDelta();
    onSensingRevise();
    updateContext();
    logState();
});

socket.onConfig((config) => {
    beliefs.config.PARCEL_DECADING_INTERVAL = clockEventToMs(config?.GAME?.parcels?.decaying_event) ?? null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(
        config?.GAME?.parcels?.generation_event
    );
    beliefs.config.OBSERVATION_DISTANCE = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS = config?.GAME?.player?.capacity ?? 1;

    console.log('[index_b] Config:', beliefs.config);
    console.log(
        `[index_b] Decay interval: ${beliefs.config.PARCEL_DECADING_INTERVAL}ms`
    );
});

setInterval(() => {
    decayParcelsReward();
}, 1000);

startExecutor(socket);

// Agent B receives natural-language objectives.
onFallbackMsg((id, name, msg) => {
    console.log(`[index_b] Message from ${name}: ${msg}`);

    if (typeof msg === 'string' && msg.trim() !== '') {
        setObjective(msg);
    }
});

function logState() {
    const intention = getCurrentIntention();

    console.log(
        `[state_b] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${beliefs.me.score}`,
        `carrying=${beliefs.me.carrying.length}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${intention?.type ?? 'none'}`,
        intention?.parcelId ? `-> ${intention.parcelId}` : ''
    );
}