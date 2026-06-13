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

// Prepend HH:MM:SS.mmm to every console line so A and B logs can be
// correlated by timestamp when viewed side-by-side.
{
    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);
    const ts = () => {
        const d = new Date();
        return `[${d.toISOString().slice(11, 23)}]`;
    };
    console.log   = (...a) => _log(ts(),   ...a);
    console.warn  = (...a) => _warn(ts(),  ...a);
    console.error = (...a) => _error(ts(), ...a);
}

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

    const maxX = tiles.reduce((m, t) => (t.x > m ? t.x : m), 0);
    const maxY = tiles.reduce((m, t) => (t.y > m ? t.y : m), 0);

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

// State log: only emit when something meaningful changes.
// This eliminates thousands of identical lines during long traversals.
const _lastState_a = { x: null, y: null, score: -1, carrying: -1, type: null, parcelId: null };

function logState() {
    const intention = getCurrentIntention();
    const x = beliefs.me.x !== null ? Math.round(beliefs.me.x) : null;
    const y = beliefs.me.y !== null ? Math.round(beliefs.me.y) : null;
    const score     = beliefs.me.score ?? 0;
    const carrying  = beliefs.me.carrying.length;
    const type      = intention?.type ?? 'none';
    const parcelId  = intention?.parcelId ?? null;

    if (
        x       === _lastState_a.x    &&
        y       === _lastState_a.y    &&
        score   === _lastState_a.score &&
        carrying === _lastState_a.carrying &&
        type    === _lastState_a.type  &&
        parcelId === _lastState_a.parcelId
    ) return;

    _lastState_a.x        = x;
    _lastState_a.y        = y;
    _lastState_a.score    = score;
    _lastState_a.carrying = carrying;
    _lastState_a.type     = type;
    _lastState_a.parcelId = parcelId;

    console.log(
        `[state_a] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${score}`,
        `carrying=${carrying}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${type}`,
        parcelId ? `-> ${parcelId}` : ''
    );
}