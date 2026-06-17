/**
 * Executes the active intention one socket action at a time.
 */

import { beliefs, canEnter, canPush, blacklistCellTemporary } from './beliefs.js';
import { planTo } from './pathfinding.js';
import { planWithPDDL } from '../pddl/pddlPlanner.js';
import {
    getCurrentIntention,
    notifyIntentionDone,
    notifyActionFailed,
} from './intentionRevision.js';
import {
    broadcastIntention,
    MSG_TYPE,
    sendBroadcast,
    consumeYieldRequest,
    getPeers,
    isPausedByPeer,
    tryBlockedDeliveryHandoff,
    runHandoff,
} from './coordination.js';

// USE_PDDL=true uses only PDDL; default uses A*.
const USE_PDDL = process.env.USE_PDDL === 'true';
const STUCK_FAILURE_THRESHOLD = 3;
const STUCK_BLACKLIST_TTL_MS = 5000;
const NO_PATH_RETRY_DELAY_MS = 400;
const SOCKET_RETRY_DELAY_MS = 1000;
const SOCKET_DISCONNECTED_SLEEP_MS = 500;
const MOVE_BLOCK_BACKOFF_MAX_MS = 800;
const EMPTY_YIELD_HOLD_MS = Number(process.env.EMPTY_YIELD_HOLD_MS) || 350;
const BLOCKING_CONTEXT_TTL_MS = 1500;

// Direction deltas for movement pre-checks.
const DIR_DELTA = {
    up: { dx: 0, dy: 1 },
    down: { dx: 0, dy: -1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
};

const OPPOSITE_DIR = {
    up: 'down',
    down: 'up',
    left: 'right',
    right: 'left',
};

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */
/** @typedef {import('../shared/types.js').Position}  Position */

/**
 * Checks whether the agent is at the target.
 *
 * @param {Position|null} target - Target position to check.
 * @returns {boolean} True if the agent is at the target position.
 */
function isAtTarget(target) {
    if (!target) return false;
    return Math.round(beliefs.me.x) === target.x && Math.round(beliefs.me.y) === target.y;
}

/**
 * @returns {boolean}
 */
function meReady() {
    return beliefs.me.x !== null && beliefs.me.y !== null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let _lastSocketActionErrorLog = 0;
let _lastSocketConnectErrorLog = 0;
let _transportAvailable = true;
let _socketHooksInstalled = false;
let _everDisconnected = false;
let _yieldHoldUntil = 0;

async function safeSocketAction(label, action) {
    if (!_transportAvailable) {
        await sleep(SOCKET_DISCONNECTED_SLEEP_MS);
        return null;
    }

    try {
        return await action();
    } catch (err) {
        const now = Date.now();
        if (now - _lastSocketActionErrorLog > 2000) {
            _lastSocketActionErrorLog = now;
            console.log(`[executor] Socket action failed (${label}): ${err.message ?? err}`);
        }
        await sleep(SOCKET_RETRY_DELAY_MS);
        return null;
    }
}

function setupSocketLifecycle(socket) {
    if (_socketHooksInstalled) return;
    _socketHooksInstalled = true;

    if (socket.connected === false) _transportAvailable = false;

    if (typeof socket.on === 'function') {
        socket.on('connect', () => {
            _transportAvailable = true;
            if (_everDisconnected) {
                console.log('[executor] Socket reconnected; resuming actions');
            }
        });
        socket.on('disconnect', (reason) => {
            _transportAvailable = false;
            _everDisconnected = true;
            console.log(`[executor] Socket disconnected; pausing actions (${reason ?? 'unknown'})`);
        });
        socket.on('connect_error', (err) => {
            _transportAvailable = false;
            const now = Date.now();
            if (now - _lastSocketConnectErrorLog > 2000) {
                _lastSocketConnectErrorLog = now;
                console.log(
                    `[executor] Socket connect error; actions paused (${err?.message ?? err})`
                );
            }
        });
    }
}

/**
 * Starts the executor loop.
 *
 * Must be called once after the socket is created.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket - Client socket used to send actions.
 */
const failedMoves = new Map();
const blockedMoveContext = new Map();

// Current pickup cycle timing.
let _cycleStart = null;
let _cyclePickupReward = 0;

export async function startExecutor(socket) {
    setupSocketLifecycle(socket);

    /** @type {Intention | null} */
    let lastIntention = null;

    while (true) {
        await new Promise((r) => setImmediate(r));

        if (!_transportAvailable) {
            await sleep(SOCKET_DISCONNECTED_SLEEP_MS);
            continue;
        }

        if (!meReady()) continue;

        // Peer-command pause.
        if (isPausedByPeer()) {
            await sleep(100);
            continue;
        }

        const holdRemaining = _yieldHoldUntil - Date.now();
        if (holdRemaining > 0) {
            await sleep(Math.min(holdRemaining, 250));
            continue;
        }

        // Right-of-way yield requested by the coordinator.
        const yieldDir = consumeYieldRequest();
        if (yieldDir) {
            const moved = await safeSocketAction(`yield ${yieldDir}`, () =>
                socket.emitMove(yieldDir)
            );
            if (moved) {
                beliefs.me.x = moved.x;
                beliefs.me.y = moved.y;
                console.log(
                    `[executor] Right-of-way yield: stepped ${yieldDir} to (${moved.x},${moved.y})`
                );
                if (beliefs.me.carrying.length === 0 && EMPTY_YIELD_HOLD_MS > 0) {
                    _yieldHoldUntil = Date.now() + EMPTY_YIELD_HOLD_MS;
                }
            }
            await sleep(100);
            continue;
        }

        const intention = getCurrentIntention();
        if (!intention) continue;

        // Activate a newly committed intention.
        if (intention !== lastIntention) {
            lastIntention = intention;
            intention.status = 'active';
            broadcastIntention(intention);
            failedMoves.clear();
        }

        switch (intention.type) {
            case 'wait':
                continue;

            case 'explore':
            case 'go_to':
            case 'go_pick_up':
            case 'go_deliver':
            case 'drop':
                await stepTowardsTarget(socket, intention);
                continue;
            case 'go_handoff':
            case 'go_handoff_receive':
                await runHandoff(socket, intention, { stepTowardsTarget, safeSocketAction });
                continue;
        }
    }
}

/**
 * Moves the agent one step toward the target of the intention.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket - Client socket used to send moves.
 * @param {Intention} intention - Current intention to execute.
 */
async function stepTowardsTarget(socket, intention) {
    if (isAtTarget(intention.targetPos)) {
        await finalize(socket, intention);
        return;
    }

    // Build a plan on demand.
    if (!intention.plan || intention.plan.length === 0) {
        const moves = await computePlan(intention);
        if (moves.length === 0) {
            console.log(
                `[executor] No path to (${intention.targetPos.x},${intention.targetPos.y})`
            );

            await sleep(NO_PATH_RETRY_DELAY_MS);

            notifyActionFailed('no_path');
            return;
        }
        intention.plan = moves;
    }

    // Replan if the next step became blocked.
    const next = intention.plan[0];
    if (!isStepValid(next)) {
        console.log(`[executor] Step ${next} no longer valid, replanning`);
        intention.plan = [];
        return;
    }

    const dir = intention.plan.shift();
    const fxBefore = Math.round(beliefs.me.x);
    const fyBefore = Math.round(beliefs.me.y);

    // Remember crate pushes before sensing catches up.
    const delta = DIR_DELTA[dir];
    const crateKey =
        delta && beliefs.crates.has(`${fxBefore + delta.dx},${fyBefore + delta.dy}`)
            ? `${fxBefore + delta.dx},${fyBefore + delta.dy}`
            : null;

    const moved = await safeSocketAction(`move ${dir}`, () => socket.emitMove(dir));

    if (moved === null) {
        intention.plan.unshift(dir);
        return;
    }

    if (!moved) {
        const tx = fxBefore + (DIR_DELTA[dir]?.dx ?? 0);
        const ty = fyBefore + (DIR_DELTA[dir]?.dy ?? 0);
        const targetKey = `${tx},${ty}`;
        const targetTile = beliefs.grid.get(targetKey);

        const failures = (failedMoves.get(targetKey) ?? 0) + 1;
        failedMoves.set(targetKey, failures);

        // Include blockers in logs when known.
        const blockingAgent = [...beliefs.agents.values()].find(
            (a) => !a.stale && Math.round(a.x) === tx && Math.round(a.y) === ty
        );
        const goalStr = intention.targetPos
            ? `goal=(${intention.targetPos.x},${intention.targetPos.y})`
            : 'goal=?';
        console.log(
            `[executor] Move failed: ${dir} from (${fxBefore},${fyBefore}) ` +
                `to (${tx},${ty}) tile=${targetTile?.type ?? '?'} failures=${failures} ` +
                `${goalStr}` +
                (blockingAgent ? ` blocker=${blockingAgent.id}` : '')
        );

        const isKnownTeammateBlocker = blockingAgent && isKnownPeer(blockingAgent.id);
        const myCarryCount = beliefs.me.carrying.length;
        const blockerCarryCount = isKnownTeammateBlocker ? peerCarryingCount(blockingAgent.id) : 0;
        if (blockingAgent) {
            rememberBlockingContext(
                targetKey,
                blockingAgent,
                isKnownTeammateBlocker,
                blockerCarryCount
            );
        }

        if (isKnownTeammateBlocker && blockerCarryCount > myCarryCount) {
            const retreatDir = OPPOSITE_DIR[dir];
            const retreatDelta = retreatDir ? DIR_DELTA[retreatDir] : null;
            const rx = fxBefore + (retreatDelta?.dx ?? 0);
            const ry = fyBefore + (retreatDelta?.dy ?? 0);
            const retreatTile = beliefs.grid.get(`${rx},${ry}`);
            const emptyWouldRetreatIntoDelivery = myCarryCount === 0 && retreatTile?.type === '2';

            if (
                retreatDir &&
                !emptyWouldRetreatIntoDelivery &&
                canEnter(fxBefore, fyBefore, rx, ry)
            ) {
                const retreated = await safeSocketAction(`priority retreat ${retreatDir}`, () =>
                    socket.emitMove(retreatDir)
                );
                if (retreated) {
                    beliefs.me.x = retreated.x;
                    beliefs.me.y = retreated.y;
                    if (myCarryCount === 0 && EMPTY_YIELD_HOLD_MS > 0) {
                        _yieldHoldUntil = Date.now() + EMPTY_YIELD_HOLD_MS;
                    }
                    console.log(
                        `[executor] Priority yield: blocker ${blockingAgent.id} ` +
                            `carrying=${blockerCarryCount} > mine=${myCarryCount}; ` +
                            `stepped ${retreatDir}` +
                            (myCarryCount === 0 && EMPTY_YIELD_HOLD_MS > 0
                                ? `; holding ${EMPTY_YIELD_HOLD_MS}ms`
                                : '')
                    );
                }
            } else {
                if (myCarryCount === 0 && EMPTY_YIELD_HOLD_MS > 0) {
                    _yieldHoldUntil = Date.now() + EMPTY_YIELD_HOLD_MS;
                }
                console.log(
                    `[executor] Priority yield: blocker ${blockingAgent.id} ` +
                        `carrying=${blockerCarryCount} > mine=${myCarryCount}; waiting` +
                        (emptyWouldRetreatIntoDelivery
                            ? ' (delivery tile not used as empty retreat)'
                            : '') +
                        (myCarryCount === 0 && EMPTY_YIELD_HOLD_MS > 0
                            ? ` ${EMPTY_YIELD_HOLD_MS}ms`
                            : '')
                );
                await sleep(250);
            }
            failedMoves.delete(targetKey);
            intention.plan = [];
            return;
        }

        // Only teammates speak the right-of-way protocol.
        if (failures === 1) {
            if (isKnownTeammateBlocker) {
                sendBroadcast(MSG_TYPE.BLOCKED_AT, {
                    x: tx,
                    y: ty,
                    direction: dir,
                    carrying: myCarryCount,
                }).catch((err) => {
                    console.log(`[executor] blocked_at broadcast failed: ${err.message ?? err}`);
                });

                // Empty teammate blocking delivery can become a handoff receiver.
                if (intention.type === 'go_deliver' && blockerCarryCount === 0) {
                    const handled = await tryBlockedDeliveryHandoff(
                        intention,
                        blockingAgent,
                        blockerCarryCount
                    );
                    if (handled) {
                        intention.plan = [];
                        return;
                    }
                }

                await sleep(250);
            }
        }

        if (failures >= STUCK_FAILURE_THRESHOLD) {
            const isGoal = intention.targetPos?.x === tx && intention.targetPos?.y === ty;
            const isCriticalTile = targetTile?.type === '1' || targetTile?.type === '2';
            failedMoves.delete(targetKey);
            const recentBlocker = getBlockingContext(targetKey);
            const recentPeerBlocker =
                recentBlocker?.teammate && recentBlocker.blockerId
                    ? getPeerById(recentBlocker.blockerId)
                    : null;
            const effectiveBlocker = blockingAgent ?? recentPeerBlocker;
            const effectiveBlockerCarry = blockingAgent
                ? blockerCarryCount
                : (recentBlocker?.carrying ?? 0);

            const blockedHandoffHandled = await tryBlockedDeliveryHandoff(
                intention,
                effectiveBlocker,
                effectiveBlockerCarry
            );
            if (blockedHandoffHandled) {
                intention.plan = [];
                return;
            }

            const occupiedByRecentBlocker = Boolean(recentBlocker?.occupied);
            const teammateBlockedRecently = Boolean(recentBlocker?.teammate);

            if (
                !isGoal &&
                !isCriticalTile &&
                !blockingAgent &&
                !isKnownTeammateBlocker &&
                !occupiedByRecentBlocker &&
                !teammateBlockedRecently
            ) {
                blacklistCellTemporary(tx, ty, STUCK_BLACKLIST_TTL_MS);
                console.log(
                    `[executor] Temporary blacklist (${tx},${ty}) for ${STUCK_BLACKLIST_TTL_MS}ms after repeated move failures`
                );
            } else {
                console.log(
                    `[executor] Skip blacklist for critical blocked tile (${tx},${ty}) ` +
                        `goal=${isGoal} tile=${targetTile?.type ?? '?'} ` +
                        `occupied=${Boolean(blockingAgent) || occupiedByRecentBlocker} ` +
                        `teammate=${Boolean(isKnownTeammateBlocker) || teammateBlockedRecently}`
                );
            }

            await sleep(Math.min(MOVE_BLOCK_BACKOFF_MAX_MS, failures * 150));
            intention.plan = [];
            notifyActionFailed('move_blocked');
            return;
        }

        // Replan inside the same intention until the blocker persists.
        await sleep(Math.min(MOVE_BLOCK_BACKOFF_MAX_MS, failures * 150));
        intention.plan = [];
        return;
    }

    // Update position before the next sensing event.
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
    failedMoves.delete(`${Math.round(moved.x)},${Math.round(moved.y)}`);

    // Move pushed crates locally before sensing catches up.
    if (crateKey) {
        const crate = beliefs.crates.get(crateKey);
        beliefs.crates.delete(crateKey);
        const bx = fxBefore + 2 * delta.dx;
        const by = fyBefore + 2 * delta.dy;
        beliefs.crates.set(`${bx},${by}`, { ...crate, x: bx, y: by });
    }
}

function isKnownPeer(agentId) {
    return getPeers().some((p) => p.id === agentId);
}

function getPeerById(agentId) {
    return getPeers().find((p) => p.id === agentId) ?? null;
}

function peerCarryingCount(agentId) {
    return getPeerById(agentId)?.carrying ?? 0;
}

function rememberBlockingContext(targetKey, blockingAgent, teammate, carrying) {
    blockedMoveContext.set(targetKey, {
        occupied: true,
        teammate: Boolean(teammate),
        blockerId: blockingAgent.id ?? null,
        carrying,
        expiresAt: Date.now() + BLOCKING_CONTEXT_TTL_MS,
    });
}

function getBlockingContext(targetKey) {
    const context = blockedMoveContext.get(targetKey);
    if (!context) return null;
    if (context.expiresAt <= Date.now()) {
        blockedMoveContext.delete(targetKey);
        return null;
    }
    return context;
}

/**
 * Checks whether the next planned move is still valid.
 *
 * @param {Direction} dir
 * @returns {boolean}
 */
function isStepValid(dir) {
    const delta = DIR_DELTA[dir];
    if (!delta) return false;
    const fx = Math.round(beliefs.me.x);
    const fy = Math.round(beliefs.me.y);
    const nx = fx + delta.dx;
    const ny = fy + delta.dy;
    return canEnter(fx, fy, nx, ny) || canPush(fx, fy, nx, ny);
}

/**
 * Computes a path to the intention target.
 *
 * @param {Intention} intention
 * @returns {Promise<Direction[]>}
 */
async function computePlan(intention) {
    if (USE_PDDL) {
        const pddlMoves = await planWithPDDL(intention);
        if (pddlMoves && pddlMoves.length > 0) {
            console.log(`[executor] PDDL plan (${pddlMoves.length} moves)`);
            return pddlMoves;
        }
        console.log('[executor] PDDL planning produced no plan');
        return [];
    }
    return planTo(intention.targetPos);
}

/**
 * Finalizes the current intention.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket - Client socket used to send actions.
 * @param {Intention} intention - Intention to finalize.
 */
async function finalize(socket, intention) {
    if (intention.type === 'go_pick_up') {
        const picked = await safeSocketAction('pickup', () => socket.emitPickup());
        if (picked === null) return;
        if (!picked || picked.length === 0) {
            console.log(
                `[executor] Empty pickup (parcel ${intention.parcelId} probably taken by another agent)`
            );
            if (intention.parcelId) beliefs.parcels.delete(intention.parcelId);
            await sleep(100);
            notifyActionFailed('pickup_empty');
            return;
        }

        _cycleStart = Date.now();
        _cyclePickupReward = picked.reduce((s, p) => {
            const stored = beliefs.parcels.get(p.id ?? intention.parcelId);
            return s + (stored?.reward ?? p.reward ?? 0);
        }, 0);

        for (const p of picked) {
            const id = p.id ?? intention.parcelId;
            const parcel = beliefs.parcels.get(id);
            if (parcel) parcel.carriedBy = beliefs.me.id;
            if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
            if (id) {
                await sendBroadcast(MSG_TYPE.PARCEL_CLAIMED, {
                    parcelId: id,
                    x: p.x ?? parcel?.x ?? intention.targetPos?.x ?? null,
                    y: p.y ?? parcel?.y ?? intention.targetPos?.y ?? null,
                }).catch((err) => {
                    console.log(
                        `[executor] PARCEL_CLAIMED broadcast failed: ${err?.message ?? err}`
                    );
                });
            }
        }

        console.log(
            `[executor] Pickup OK: ${picked.length} parcel(s) reward=${_cyclePickupReward} (carrying=${beliefs.me.carrying.length})`
        );
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_deliver' || intention.type === 'drop') {
        const dropped = await safeSocketAction('putdown', () => socket.emitPutdown());
        if (dropped === null) return;
        const cycleMs = _cycleStart ? Date.now() - _cycleStart : null;
        const actual = (dropped ?? []).length;

        for (const id of beliefs.me.carrying) {
            beliefs.parcels.delete(id);
        }
        beliefs.me.carrying = [];
        for (const p of dropped ?? []) {
            if (p.id) beliefs.parcels.delete(p.id);
        }

        const cycleInfo =
            cycleMs !== null
                ? ` cycle=${(cycleMs / 1000).toFixed(1)}s pickupReward=${_cyclePickupReward}`
                : '';
        console.log(
            `[executor] Delivery OK: ${actual} parcel(s) score=${beliefs.me.score}${cycleInfo}`
        );
        _cycleStart = null;
        _cyclePickupReward = 0;
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_to') {
        console.log(`[executor] Reached (${intention.targetPos.x},${intention.targetPos.y})`);
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'explore') {
        console.log(
            `[executor] Reached spawner (${intention.targetPos.x},${intention.targetPos.y})`
        );
        notifyIntentionDone();
        return;
    }
}
