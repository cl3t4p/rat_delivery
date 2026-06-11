/**
 * index_a.js
 *
 * Entry point for Agent A.
 *
 * Agent A is the BDI agent:
 * - senses the Deliveroo.js environment
 * - revises beliefs
 * - revises intentions
 * - executes BDI plans
 * - communicates with Agent B
 * - may accept zone assignments from Agent B
 *
 * Agent A does not call the LLM.
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
    initZoneAssignHandler,
} from './bdi/intentionRevision.js';

import { startExecutor } from './bdi/executor.js';
import { initCommunication } from './multi/communication.js';
import { initCoordinator } from './multi/coordinator.js';
import { enableNotifier, tickBeliefDelta } from './multi/notifier.js';

const socket = DjsConnect();

// Multi-agent layer.
// Agent A only communicates and receives coordination messages.
// It does not start the LLM zone-assignment loop.
initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
initCoordinator({ getCurrentIntention, forceIntention });
initZoneAssignHandler();
enableNotifier();

// Receive map data.
socket.on('map', (width, height, tiles) => {
    console.log(`[index_a] Map received: ${width}x${height}`);
    updateMap(tiles);

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

// Update agent.
socket.on('you', (agent) => {
    updateMe(agent);
});

// Sensing loop.
socket.on('sensing', (sensing) => {
    updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
    tickBeliefDelta();
    onSensingRevise();
    logState();
});

// Load config.
socket.onConfig((config) => {
    beliefs.config.PARCEL_DECADING_INTERVAL = clockEventToMs(config?.GAME?.parcels?.decaying_event) ?? null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(
        config?.GAME?.parcels?.generation_event
    );
    beliefs.config.OBSERVATION_DISTANCE = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS = config?.GAME?.player?.capacity ?? 1;

    console.log('[index_a] Config:', beliefs.config);
    console.log(
        `[index_a] Decay interval: ${beliefs.config.PARCEL_DECADING_INTERVAL}ms`
    );
});

// Decay local parcels.
setInterval(() => {
    decayParcelsReward();
}, 1000);

// Start the executor loop.
startExecutor(socket);

// Debug: log the current state.
function logState() {
    const intention = getCurrentIntention();

    console.log(
        `[state_a] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${beliefs.me.score}`,
        `carrying=${beliefs.me.carrying.length}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${intention?.type ?? 'none'}`,
        intention?.parcelId ? `-> ${intention.parcelId}` : ''
    );
}