/**
 * agent/multi.js
 *
 * Shared bootstrap for the two-agent (multi) setup. multiagent_a.js and multiagent_b.js are
 * thin wrappers that call startMultiAgent({ role }).
 *
 * role 'a' — plain BDI agent: communicates and accepts zone assignments. No LLM.
 *            Connects with the default token; prints the map grid.
 * role 'b' — BDI + LLM coordinator: owns the zone-assignment loop, receives
 *            natural-language objectives, maintains LLM context. Connects with
 *            TOKEN_B.
 *
 * Everything common to both roles lives here (and in agent/common.js); only the
 * role-specific wiring is branched on `isB`.
 */

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

import { beliefs, updateMap, updateMe, updateBeliefs } from '../bdi/beliefs.js';
import {
    onSensingRevise,
    getCurrentIntention,
    forceIntention,
    requestRevision,
    commitIntention,
    clearIntention,
    interruptForRevision,
} from '../bdi/intentionRevision.js';
import { startExecutor } from '../bdi/executor.js';
import { updateContext, setObjective, initLlmAgent, llmMemory } from '../llm/llmAgent.js';
import { getPeers } from '../bdi/coordination.js';
import {
    initCommunication,
    onFallbackMsg,
    sendBroadcast,
    MSG_TYPE,
} from '../multi/communication.js';
import {
    initCoordinator,
    startZoneAssignmentLoop,
    setCoordinatorRole,
    initZoneAssignHandler,
} from '../multi/coordination/coordinator.js';
import { enableNotifier, tickBeliefDelta } from '../multi/notifier.js';
import { installMultiAgent } from '../multi/helper.js';

import {
    installTimestampedConsole,
    applyConfig,
    startDecayLoop,
    logMapGrid,
    makeLogState,
    REVISE_HEARTBEAT_MS,
} from './common.js';

/**
 * Connects and wires a multi-agent BDI agent for the given role.
 *
 * The token is supplied by the entrypoint (multiagent_a.js / multiagent_b.js),
 * each passing its own TOKEN_A / TOKEN_B.
 *
 * @param {{ role: 'a' | 'b', token: string }} options
 * @returns {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket}
 */
export function startMultiAgent({ role, token }) {
    const isB = role === 'b';
    const tag = `multiagent_${role}`;

    installTimestampedConsole();

    if (!token) {
        console.error(`[${tag}] token missing — set TOKEN_${role.toUpperCase()} in .env`);
        process.exit(1);
    }
    const socket = DjsConnect(process.env.HOST, token);

    // Multi-agent layer. installMultiAgent() injects the real coordination hooks
    // into the BDI core, which otherwise runs solo (see bdi/coordination.js).
    installMultiAgent();
    initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
    initCoordinator({
        getCurrentIntention,
        forceIntention,
        requestRevision,
        commitIntention,
        clearIntention,
    });
    initZoneAssignHandler();
    enableNotifier();

    // Agent B owns the LLM coordination loop; Agent A only receives assignments.
    if (isB) {
        setCoordinatorRole();
        initLlmAgent(interruptForRevision);
        startZoneAssignmentLoop();

        // Let the LLM intention agent talk to the teammate, a specific agent, or
        // broadcast — e.g. to coordinate or to answer a special-mission question.
        // `to` is 'all' (shout), 'peer' (say to teammate), or an agent id (say to it).
        llmMemory.sendMessage = (text, to = 'all') => {
            let targetId = null;
            if (to === 'peer') targetId = getPeers()[0]?.id ?? null;
            else if (to && to !== 'all') targetId = to;

            const send = targetId ? socket.emitSay(targetId, text) : socket.emitShout(text);
            Promise.resolve(send).catch((err) =>
                console.log(`[${tag}] sendMessage failed: ${err?.message ?? err}`)
            );
        };
    }

    const logState = makeLogState(`state_${role}`);

    socket.on('map', (width, height, tiles) => {
        console.log(`[${tag}] Map received: ${width}x${height}`);
        updateMap(tiles);
        if (!isB) logMapGrid(tiles); // Agent A dumps the grid for inspection.
    });

    socket.on('you', (agent) => {
        updateMe(agent);
    });

    socket.on('sensing', (sensing) => {
        updateBeliefs(sensing.parcels ?? [], sensing.agents ?? [], sensing.crates ?? []);
        tickBeliefDelta();
        onSensingRevise();
        if (isB) updateContext();
        logState();
    });

    socket.onConfig((config) => applyConfig(tag, config));

    startDecayLoop();
    startExecutor(socket);

    // Agent B receives natural-language objectives over the fallback channel.
    if (isB) {
        onFallbackMsg((id, name, msg) => {
            console.log(`[${tag}] Message from ${name}: ${msg}`);
            if (typeof msg === 'string' && msg.trim() !== '') setObjective(msg, id);
        });
    }

    // Heartbeat re-deliberation (see REVISE_HEARTBEAT_MS): keeps time-based
    // deliberation alive even when no sensing events arrive.
    setInterval(() => onSensingRevise(), REVISE_HEARTBEAT_MS);

    // While no teammate is known, ping the team once a second so the two agents
    // find each other; until then nothing about ourselves is broadcast.
    setInterval(() => {
        if (getPeers().length === 0) {
            sendBroadcast(MSG_TYPE.HELLO, 'YO BRO ARE YOU UP?');
        }
    }, 1000);

    return socket;
}
