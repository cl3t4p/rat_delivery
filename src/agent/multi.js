/**
 * agent/multi.js
 *
 * Bootstrap shared by multiagent_a.js and multiagent_b.js.
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

// Keep peerState fresh even while an LLM call is pending.
const PEER_HEARTBEAT_MS = 3000;

/**
 * Sends periodic HELLO pings to known peers.
 */
function startPeerHeartbeat() {
    setInterval(() => {
        if (getPeers().length > 0) {
            sendBroadcast(MSG_TYPE.HELLO, null);
        }
    }, PEER_HEARTBEAT_MS);
}

/**
 * Connects and wires one multi-agent role.
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

    // Inject the multi-agent coordination hooks into the BDI core.
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

    // Agent B owns the LLM coordination loop.
    if (isB) {
        setCoordinatorRole();
        initLlmAgent(interruptForRevision);
        startZoneAssignmentLoop();

        // `to` can be 'all', 'peer', or a specific agent id.
        llmMemory.sendMessage = (text, to = 'all') => {
            let targetId = null;
            if (to === 'peer') targetId = getPeers()[0]?.id ?? null;
            else if (to && to !== 'all') targetId = to;

            const send = targetId ? socket.emitSay(targetId, text) : socket.emitShout(text);
            Promise.resolve(send).catch((err) =>
                console.log(`[${tag}] sendMessage failed: ${err?.message ?? err}`)
            );
        };

        // Pause the peer while Agent B is handling a mission.
        let _peerPaused = false;
        llmMemory.onMissionsChanged = (prevLen, newLen) => {
            const peers = getPeers();
            if (peers.length === 0) return;
            if (prevLen === 0 && newLen > 0 && !_peerPaused) {
                _peerPaused = true;
                sendBroadcast(MSG_TYPE.PEER_COMMAND, { action: 'pause' }).catch((err) =>
                    console.log(`[${tag}] PEER_COMMAND pause failed: ${err?.message ?? err}`)
                );
                console.log(`[${tag}] Mission arrived — pausing peer`);
            } else if (newLen === 0 && _peerPaused) {
                _peerPaused = false;
                sendBroadcast(MSG_TYPE.PEER_COMMAND, { action: 'resume' }).catch((err) =>
                    console.log(`[${tag}] PEER_COMMAND resume failed: ${err?.message ?? err}`)
                );
                console.log(`[${tag}] Missions cleared — resuming peer`);
            }
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

    // Agent B receives natural-language objectives over chat.
    if (isB) {
        onFallbackMsg((id, name, msg) => {
            console.log(`[${tag}] Message from ${name}: ${msg}`);
            if (typeof msg === 'string' && msg.trim() !== '') setObjective(msg, id);
        });
    }

    // Keep time-based deliberation alive when sensing is quiet.
    setInterval(() => onSensingRevise(), REVISE_HEARTBEAT_MS);

    // Discovery ping before the teammate is known.
    setInterval(() => {
        if (getPeers().length === 0) {
            sendBroadcast(MSG_TYPE.HELLO, 'YO BRO ARE YOU UP?');
        }
    }, 1000);

    startPeerHeartbeat();

    return socket;
}
