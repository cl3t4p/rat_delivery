/**
 * executor.js
 *
 * Loop:
 *   1. Reads the intention from intentionRevision
 *   2. If the plan is missing, computes it with planTo
 *   3. Consumes one move and calls emitMove
 *   4. If on the target, calls emitPickup / emitPutdown
 *   5. Notifies intentionRevision with done / failed
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
    tryBlockedDeliveryHandoff,
    runHandoff,
} from './coordination.js';

// Planner selection:
//
// USE_PDDL=true        — uses only the PDDL planner (no A* fallback).
// Default (unset)      — uses only the A* planner.
const USE_PDDL = process.env.USE_PDDL === 'true';
const STUCK_FAILURE_THRESHOLD = 3;
const STUCK_BLACKLIST_TTL_MS = 5000;
const NO_PATH_RETRY_DELAY_MS = 400;
const SOCKET_RETRY_DELAY_MS = 1000;
const SOCKET_DISCONNECTED_SLEEP_MS = 500;
const MOVE_BLOCK_BACKOFF_MAX_MS = 800;
const EMPTY_YIELD_HOLD_MS = Number(process.env.EMPTY_YIELD_HOLD_MS) || 350;
const BLOCKING_CONTEXT_TTL_MS = 1500;

// Maps each direction to its delta, used for the canEnter pre-check before emitMove.
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
 * Checks if the agent is at the target position.
 *
 * @param {Position|null} target - Target position to check.
 * @returns {boolean} True if the agent is at the target position.
 */
function isAtTarget(target) {
    if (!target) return false;
    return Math.round(beliefs.me.x) === target.x && Math.round(beliefs.me.y) === target.y;
}

/**
 * Check if the position is valid
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

// Loop

/**
 * Starts the executor loop.
 *
 * Must be called only once after the socket is created.
 * Reads the current intention and executes it until it is completed or fails.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket - Client socket used to send actions.
 */
const failedMoves = new Map();
const blockedMoveContext = new Map();

// Tracks the start time of the current pickup to compute cycle duration on delivery.
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

        const holdRemaining = _yieldHoldUntil - Date.now();
        if (holdRemaining > 0) {
            await sleep(Math.min(holdRemaining, 250));
            continue;
        }

        // Right-of-way yield: execute a lateral step requested by the coordinator
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

        // Mark the new intention as active
        if (intention !== lastIntention) {
            lastIntention = intention;
            intention.status = 'active';
            broadcastIntention(intention);
            // Stale failure counts from the previous intention could cause tiles that
            // were only transiently blocked to be prematurely blacklisted if the agent
            // navigates through them again under a different intention.
            failedMoves.clear();
        }

        switch (intention.type) {
            case 'wait':
                continue;

            case 'explore':
            case 'go_to':
            case 'go_pick_up':
            case 'go_deliver':
                await stepTowardsTarget(socket, intention);
                continue;
            case 'go_handoff':
            case 'go_handoff_receive':
                // Handoff execution lives in the multi layer; hand it the
                // executor primitives it needs to walk and act (see runHandoff
                // in multi/coordinator.js).
                await runHandoff(socket, intention, { stepTowardsTarget, safeSocketAction });
                continue;
        }
    }
}

// Step toward the target.

/**
 * Moves the agent one step toward the target of the intention.
 *
 * If the agent is already at the target, the intention is finalized.
 * If there is no plan, a new one is computed.
 * If the next step is no longer valid, the plan is cleared and recomputed later.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket - Client socket used to send moves.
 * @param {Intention} intention - Current intention to execute.
 */
async function stepTowardsTarget(socket, intention) {
    // Check if the agent is already at the target
    if (isAtTarget(intention.targetPos)) {
        await finalize(socket, intention);
        return;
    }

    // If the plan is empty, compute it
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

    // Check if the next step is still valid
    const next = intention.plan[0];
    if (!isStepValid(next)) {
        console.log(`[executor] Step ${next} no longer valid, replanning`);
        intention.plan = [];
        return;
    }

    // Execute the next step
    const dir = intention.plan.shift();
    const fxBefore = Math.round(beliefs.me.x);
    const fyBefore = Math.round(beliefs.me.y);

    // If the next tile holds a crate, this step is a push: remember it so the local
    // crate beliefs can be updated immediately after the move, before the next sensing
    // event, keeping chained pushes and the next isStepValid check consistent.
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

        // Include who (if anyone) is on the target tile to make blocked logs actionable.
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

        // Right-of-way: only ask known teammates to yield. External agents do
        // not speak our protocol, so broadcasting for them only adds log noise.
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

                // Fast-path: if delivering and the blocker is empty, propose a
                // handoff immediately instead of waiting for STUCK_FAILURE_THRESHOLD.
                // Saves ~2 × (backoff + retry) ≈ 0.6 s per reactive handoff cycle.
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

        // Below threshold: replan within the same intention without triggering
        // a full intention replacement. This lets failedMoves accumulate so the
        // threshold is reached if the blocker persists.
        await sleep(Math.min(MOVE_BLOCK_BACKOFF_MAX_MS, failures * 150));
        intention.plan = [];
        return;
    }

    // Update the position without waiting for the next sensing update
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
    failedMoves.delete(`${Math.round(moved.x)},${Math.round(moved.y)}`);

    // If this step pushed a crate, advance it one tile in the same direction locally
    // so the rest of the plan sees the new layout before sensing catches up.
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
 * Checks whether the next planned move is still valid
 * according to the current beliefs.
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
    // The step is valid if the agent can walk onto the tile, or push a crate off it.
    return canEnter(fx, fy, nx, ny) || canPush(fx, fy, nx, ny);
}

/**
 * Computes the plan needed to reach targetPos.
 * Uses PDDL first if enabled, otherwise uses A*.
 * Returns an empty array if planning fails.
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

// Final Actions

/**
 * Finalizes the current intention.
 *
 * For go_pick_up, tries to pick up the parcel and updates the local beliefs.
 * For go_deliver, drops the carried parcels and removes them from the local beliefs.
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

    if (intention.type === 'go_deliver') {
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
        // Pure positioning: nothing to pick up or drop, the target was reached.
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
