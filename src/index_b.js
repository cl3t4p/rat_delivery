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
    revise,
    initZoneAssignHandler,
} from './bdi/intentionRevision.js';

import { startExecutor } from './bdi/executor.js';
import { updateContext, setObjective, initLlmAgent } from './llm/llmAgent.js';
import { initCommunication, onFallbackMsg } from './multi/communication.js';
import { initCoordinator, startZoneAssignmentLoop, setCoordinatorRole } from './multi/coordinator.js';
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
setCoordinatorRole();
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

const _lastState_b = { x: null, y: null, score: -1, carrying: -1, type: null, parcelId: null };

function logState() {
    const intention = getCurrentIntention();
    const x        = beliefs.me.x !== null ? Math.round(beliefs.me.x) : null;
    const y        = beliefs.me.y !== null ? Math.round(beliefs.me.y) : null;
    const score    = beliefs.me.score ?? 0;
    const carrying = beliefs.me.carrying.length;
    const type     = intention?.type ?? 'none';
    const parcelId = intention?.parcelId ?? null;

    if (
        x        === _lastState_b.x        &&
        y        === _lastState_b.y        &&
        score    === _lastState_b.score    &&
        carrying === _lastState_b.carrying &&
        type     === _lastState_b.type     &&
        parcelId === _lastState_b.parcelId
    ) return;

    _lastState_b.x        = x;
    _lastState_b.y        = y;
    _lastState_b.score    = score;
    _lastState_b.carrying = carrying;
    _lastState_b.type     = type;
    _lastState_b.parcelId = parcelId;

    console.log(
        `[state_b] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
        `score=${score}`,
        `carrying=${carrying}`,
        `parcels=${beliefs.parcels.size}`,
        `intention=${type}`,
        parcelId ? `-> ${parcelId}` : ''
    );
}