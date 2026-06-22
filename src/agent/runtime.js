/**
 * agent/runtime.js
 *
 * Shared bootstrap for single-agent entrypoints.
 */

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { updateMap, updateMe, updateBeliefs } from '../bdi/beliefs.js';
import { onSensingRevise, interruptForRevision } from '../bdi/intentionRevision.js';
import { startExecutor } from '../bdi/executor.js';

const USE_LLM = process.env.USE_LLM === 'true' || process.env.USE_LLM_POLICY === 'true';

import {
    installTimestampedConsole,
    applyConfig,
    startDecayLoop,
    logMapGrid,
    makeLogState,
    REVISE_HEARTBEAT_MS,
} from './common.js';

/**
 * Connects and wires the single-agent BDI loop.
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

    // LLM mode needs the client before the first deliberation.
    if (USE_LLM) {
        import('../llm/llmAgent.js').then(({ initLlmAgent, llmMemory, setObjective }) => {
            initLlmAgent(interruptForRevision);
            // In solo mode, messages go to chat directly.
            llmMemory.sendMessage = (text, to = 'all') => {
                const send =
                    to && to !== 'all' && to !== 'peer'
                        ? socket.emitSay(to, text)
                        : socket.emitShout(text);
                Promise.resolve(send).catch((err) =>
                    console.log(`[${tag}] sendMessage failed: ${err?.message ?? err}`)
                );
            };
            // Receive natural-language missions over chat.
            socket.onMsg((id, name, msg) => {
                if (typeof msg === 'string' && msg.trim() !== '') setObjective(msg, id);
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

    socket.onConfig((config) => {
        applyConfig(tag, config)
    });


    startExecutor(socket);

    // Keep timers moving even when sensing is quiet.
    setInterval(() => onSensingRevise(), REVISE_HEARTBEAT_MS);

    return socket;
}
