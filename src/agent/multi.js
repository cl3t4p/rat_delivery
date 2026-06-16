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
    revise,
    initZoneAssignHandler,
} from '../bdi/intentionRevision.js';
import { startExecutor } from '../bdi/executor.js';
import { updateContext, setObjective, initLlmAgent } from '../llm/llmAgent.js';
import { initCommunication, onFallbackMsg, MSG_TYPE, onMessage, sendBroadcast } from '../multi/communication.js';
import { initCoordinator, startZoneAssignmentLoop, setCoordinatorRole } from '../multi/coordinator.js';
import { enableNotifier, tickBeliefDelta } from '../multi/notifier.js';
import { installMultiAgent } from '../multi/helper.js';

import {
    installTimestampedConsole,
    applyConfig,
    startDecayLoop,
    logMapGrid,
    makeLogState,
} from './common.js';

/**
 * Connects and wires a multi-agent BDI agent for the given role.
 *
 * @param {{ role: 'a' | 'b' }} options
 * @returns {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket}
 */
export function startMultiAgent({ role }) {
    const isB = role === 'b';
    const tag = `multiagent_${role}`;

    installTimestampedConsole();

    let socket;
    if (isB) {
        if (!process.env.TOKEN_B) {
            console.error(`[${tag}] TOKEN_B missing in .env`);
            process.exit(1);
        }
        socket = DjsConnect(process.env.HOST, process.env.TOKEN_B);
    } else {
        socket = DjsConnect();
    }

    // Multi-agent layer. installMultiAgent() injects the real coordination hooks
    // into the BDI core, which otherwise runs solo (see bdi/coordination.js).
    installMultiAgent();
    initCommunication(socket, { selfIdProvider: () => beliefs.me.id });
    initCoordinator({ getCurrentIntention, forceIntention, requestRevision });
    initZoneAssignHandler();
    enableNotifier();

    // Agent B owns the LLM coordination loop; Agent A only receives assignments.
    if (isB) {
        setCoordinatorRole();
        initLlmAgent(revise);
        startZoneAssignmentLoop();
    }

    onMessage(MSG_TYPE.OPERATOR_MESSAGE, (envelope, senderId) => {
        if (senderId && senderId === beliefs.me.id) return;
        const text = envelope.payload?.text;
        if (typeof text !== 'string' || text.trim() === '') return;
        console.log(`[${tag}] Operator message from peer: ${text}`);
        setObjective(text)
            .then(() => requestRevision(true))
            .catch((err) => console.error(`[${tag}] operator message failed: ${err?.message ?? err}`));
    });

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
            if (id && id === beliefs.me.id) return;
            console.log(`[${tag}] Message from ${name}: ${msg}`);
            if (typeof msg === 'string' && msg.trim() !== '') {
                setObjective(msg, {
                    respond: (answer) => socket.emitShout(answer),
                }).then(() => sendBroadcast(MSG_TYPE.OPERATOR_MESSAGE, { text: msg }))
                    .catch((err) => console.error(`[${tag}] objective handling failed: ${err?.message ?? err}`));
            }
        });
    }

    return socket;
}
