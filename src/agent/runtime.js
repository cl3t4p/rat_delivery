/**
 * agent/runtime.js
 *
 * Shared bootstrap for a single, standalone BDI agent: sense → revise beliefs →
 * revise intentions → execute, with NO multi-agent layer (no communication,
 * coordinator, or zone assignment). A solo agent owns the whole map and never
 * waits on a peer.
 *
 * Both single-agent entrypoints use this:
 *   - src/single.js — A* planning (or LLM deliberation when USE_LLM=true)
 *   - src/pddl.js   — PDDL planning (USE_PDDL=true)
 *
 * The planning/deliberation mode is read by the BDI modules from process.env at
 * load time, so an entrypoint that forces a mode MUST set the env var BEFORE
 * importing this module — which is why the entrypoints import it dynamically.
 */

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { updateMap, updateMe, updateBeliefs } from '../bdi/beliefs.js';
import { onSensingRevise } from '../bdi/intentionRevision.js';
import { startExecutor } from '../bdi/executor.js';

import {
    installTimestampedConsole,
    applyConfig,
    startDecayLoop,
    logMapGrid,
    makeLogState,
} from './common.js';

/**
 * Connects to the environment and wires the single-agent BDI loop.
 *
 * The token is supplied by the entrypoint (single.js / pddl.js), which passes the
 * shared TOKEN.
 *
 * @param {{ tag?: string, token?: string }} [options] - log tag and connection token.
 * @returns {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket}
 */
export function startSingleAgent({ tag = 'single', token } = {}) {
    installTimestampedConsole();

    if (!token) {
        console.error(`[${tag}] token missing — set TOKEN in .env`);
        process.exit(1);
    }
    const socket = DjsConnect(process.env.HOST, token);

    // No multi-agent layer: a solo agent does not communicate, coordinate, or
    // accept zone assignments. The BDI modules' notifier/coordinator calls silently
    // no-op while uninitialised (see bdi/coordination.js), so nothing here stubs them.

    const logState = makeLogState('state');

    socket.on('map', (width, height, tiles) => {
        console.log(`[${tag}] Map received: ${width}x${height}`);
        updateMap(tiles);
        logMapGrid(tiles);
    });

    socket.on('you', (agent) => {
        updateMe(agent);
    });

    socket.on('sensing', (sensing) => {
        updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
        onSensingRevise();
        logState();
    });

    socket.onConfig((config) => applyConfig(tag, config));

    startDecayLoop();
    startExecutor(socket);

    return socket;
}
