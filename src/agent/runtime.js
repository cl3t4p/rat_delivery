/**
 * agent/runtime.js
 *
 * Shared bootstrap for a single, standalone BDI agent: sense, then revise beliefs,
 * then revise intentions, then execute, with NO multi-agent layer (no communication,
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

// Sensing events stop firing when the agent is idle with an empty view, so the
// time-based parts of deliberation (the spawner dwell, the wait-age safety net,
// the stuck watchdog) would never be re-evaluated and the agent would just sit
// until something moved into view. Re-deliberate on this fixed cadence so those
// timers actually elapse. Kept below the dwell so a dwell resolves promptly.
const REVISE_HEARTBEAT_MS = Number(process.env.REVISE_HEARTBEAT_MS) || 200;

import { updateMap, updateMe, updateBeliefs } from '../bdi/beliefs.js';
import { onSensingRevise, interruptForRevision } from '../bdi/intentionRevision.js';
import { startExecutor } from '../bdi/executor.js';

// The single agent uses the LLM deliberation when USE_LLM=true. That path needs
// the LLM client created up front (otherwise generateBestIntention has no client
// to call). USE_LLM_POLICY shares the same client.
const USE_LLM = process.env.USE_LLM === 'true' || process.env.USE_LLM_POLICY === 'true';

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

    // LLM deliberation needs the client initialised. Re-deliberate when an
    // objective/mission arrives. A solo agent has no peer, so sendMessage just
    // broadcasts (used to answer special-mission questions over the chat).
    if (USE_LLM) {
        import('../llm/llmAgent.js').then(({ initLlmAgent, llmMemory, setObjective }) => {
            initLlmAgent(interruptForRevision);
            llmMemory.sendMessage = (text) => {
                Promise.resolve(socket.emitShout(text)).catch((err) =>
                    console.log(`[${tag}] sendMessage failed: ${err?.message ?? err}`)
                );
            };
            // Receive natural-language objectives / special missions over chat.
            socket.onMsg((id, name, msg) => {
                if (typeof msg === 'string' && msg.trim() !== '') setObjective(msg);
            });
        });
    }

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

    // Heartbeat re-deliberation (see REVISE_HEARTBEAT_MS): keeps time-based
    // deliberation alive even when no sensing events arrive.
    setInterval(() => onSensingRevise(), REVISE_HEARTBEAT_MS);

    return socket;
}
