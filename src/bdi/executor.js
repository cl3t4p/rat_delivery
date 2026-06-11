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

import { beliefs, canEnter, blacklistCellTemporary } from './beliefs.js';
import { planTo } from './pathfinding.js';
import { planWithPDDL } from '../pddl/pddlPlanner.js';
import {
    getCurrentIntention,
    notifyIntentionDone,
    notifyActionFailed,
} from './intentionRevision.js';
import { broadcastIntention } from '../multi/notifier.js';

// Planner selection:
//
// USE_PDDL=true
// Uses only the PDDL planner.
//
// USE_PDDL=true and PDDL_FALLBACK=true
// Uses the PDDL planner and falls back to A* if planning fails.
//
// Default (USE_PDDL not set)
// Uses only the A* planner.
const USE_PDDL = process.env.USE_PDDL === 'true';
const PDDL_FALLBACK = process.env.PDDL_FALLBACK === 'true';
const STUCK_FAILURE_THRESHOLD = 3;
const STUCK_BLACKLIST_TTL_MS = 5000;

// Maps each direction to its delta, used for the canEnter pre-check before emitMove.
const DIR_DELTA = {
    up: { dx: 0, dy: 1 },
    down: { dx: 0, dy: -1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 },
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

export async function startExecutor(socket) {
    /** @type {Intention | null} */
    let lastIntention = null;

    while (true) {
        await new Promise((r) => setImmediate(r));

        if (!meReady()) continue;

        const intention = getCurrentIntention();
        if (!intention) continue;

        // Mark the new intention as active
        if (intention !== lastIntention) {
            lastIntention = intention;
            intention.status = 'active';
            broadcastIntention(intention);
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
                await executeHandoff(socket, intention);
                continue;
            case 'go_handoff_receive':
                await executeHandoffReceive(socket, intention);
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
            console.log(`[executor] No path to (${intention.targetPos.x},${intention.targetPos.y})`);
            blacklistCellTemporary(
                intention.targetPos.x,
                intention.targetPos.y,
                STUCK_BLACKLIST_TTL_MS
            );
            console.log(
                `[executor] Temporary blacklist target ` +
                `(${intention.targetPos.x},${intention.targetPos.y}) for ${STUCK_BLACKLIST_TTL_MS}ms after no_path`
            );
            notifyActionFailed('no_path');
            return;
        }
        intention.plan = moves;
    }

    // Check if the next step is still valid
    const next = intention.plan[0];
    if (!isStepValid(next)) {
        console.log(`[executor] Step ${next} no longer valid → replan`);
        intention.plan = [];
        return;
    }

    // Execute the next step
    const dir = intention.plan.shift();
    const fxBefore = Math.round(beliefs.me.x);
    const fyBefore = Math.round(beliefs.me.y);
    const moved = await socket.emitMove(dir);

    if (!moved) {
        const tx = fxBefore + (DIR_DELTA[dir]?.dx ?? 0);
        const ty = fyBefore + (DIR_DELTA[dir]?.dy ?? 0);
        const targetKey = `${tx},${ty}`;
        const targetTile = beliefs.grid.get(targetKey);

        const failures = (failedMoves.get(targetKey) ?? 0) + 1;
        failedMoves.set(targetKey, failures);

        console.log(
            `[executor] Move failed: ${dir} from (${fxBefore},${fyBefore}) ` +
            `to (${tx},${ty}) tile=${targetTile?.type} failures=${failures} ` +
            `moved=${JSON.stringify(moved)}`
        );

        if (failures >= STUCK_FAILURE_THRESHOLD) {
            blacklistCellTemporary(tx, ty, STUCK_BLACKLIST_TTL_MS);
            failedMoves.delete(targetKey);

            console.log(
                `[executor] Temporary blacklist (${tx},${ty}) for ${STUCK_BLACKLIST_TTL_MS}ms after repeated move failures`
            );
        }

        intention.plan = [];
        notifyActionFailed('move_blocked');
        return;
    }

    // Update the position without waiting for the next sensing update
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
    failedMoves.clear();
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
    return canEnter(fx, fy, fx + delta.dx, fy + delta.dy);
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
        if (!PDDL_FALLBACK) {
            console.log(
                '[executor] PDDL unavailable, no fallback configured (set PDDL_FALLBACK=true to enable A*)'
            );
            return [];
        }
        console.log('[executor] PDDL unavailable → A* fallback');
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
        const picked = await socket.emitPickup();
        if (!picked || picked.length === 0) {
            console.log(
                `[executor] Empty pickup (parcel ${intention.parcelId} probably taken by another agent)`
            );
            notifyActionFailed('pickup_empty');
            return;
        }

        // Update beliefs before the next sensing event
        for (const p of picked) {
            const id = p.id ?? intention.parcelId;
            const parcel = beliefs.parcels.get(id);
            if (parcel) parcel.carriedBy = beliefs.me.id;
            if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
        }

        console.log(
            `[executor] Pickup OK: ${picked.length} parcel(s) (carrying=${beliefs.me.carrying.length})`
        );
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_deliver') {
        const dropped = await socket.emitPutdown();

        // Remove all carried parcels locally
        for (const id of beliefs.me.carrying) {
            beliefs.parcels.delete(id);
        }
        beliefs.me.carrying = [];

        // Remove parcels confirmed by the server
        for (const p of dropped ?? []) {
            if (p.id) beliefs.parcels.delete(p.id);
        }

        console.log(`[executor] Delivery OK: ${(dropped ?? []).length} parcel(s)`);
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_to') {
        // Pure positioning: nothing to pick up or drop, the target was reached.
        console.log(`[executor] Reached (${intention.targetPos.x},${intention.targetPos.y})`);
        notifyIntentionDone();
        return;
    }
}

/**
 * Executes a handoff intention: walks to the meetTile and puts down all parcels.
 * The peer will pick them up and deliver them.
 * After put_down, A resumes normal deliberation.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function executeHandoff(socket, intention) {
    if (!isAtTarget(intention.targetPos)) {
        await stepTowardsTarget(socket, intention);
        return;
    }

    // At meetTile: drop all parcels
    await socket.emitPutdown();
    for (const id of beliefs.me.carrying) {
        const parcel = beliefs.parcels.get(id);
        if (parcel) parcel.carriedBy = null;
    }
    beliefs.me.carrying = [];

    console.log(`[executor] Handoff: parcels dropped at (${intention.targetPos.x},${intention.targetPos.y})`);
    notifyIntentionDone();
}

/**
 * Executes a handoff-receive intention: B walks to the meetTile,
 * picks up all parcels dropped there by A, then delivers them.
 *
 * After emitPickup the normal BDI loop takes over: the next
 * revise() call will see carrying > 0 and produce go_deliver.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function executeHandoffReceive(socket, intention) {
    if (!isAtTarget(intention.targetPos)) {
        await stepTowardsTarget(socket, intention);
        return;
    }

    // At meetTile: try to pick up parcels dropped by A.
    // A may not have arrived yet — retry up to MAX_PICKUP_ATTEMPTS times
    // before giving up and letting BDI re-deliberate.
    const MAX_PICKUP_ATTEMPTS = 5;
    intention._pickupAttempts = (intention._pickupAttempts ?? 0) + 1;

    const picked = await socket.emitPickup();

    if (!picked || picked.length === 0) {
        if (intention._pickupAttempts >= MAX_PICKUP_ATTEMPTS) {
            console.log('[executor] Handoff receive: no parcels after max attempts → failing');
            notifyActionFailed('pickup_empty');
        } else {
            console.log(
                `[executor] Handoff receive: nothing yet, attempt ${intention._pickupAttempts}/${MAX_PICKUP_ATTEMPTS} — waiting`
            );
            await new Promise((r) => setTimeout(r, 500));
        }
        return;
    }

    // Update beliefs before the next sensing event
    for (const p of picked) {
        const id = p.id;
        const parcel = beliefs.parcels.get(id);
        if (parcel) parcel.carriedBy = beliefs.me.id;
        if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
    }

    console.log(`[executor] Handoff receive OK: picked up ${picked.length} parcel(s)`);
    notifyIntentionDone(); // triggers revise() → go_deliver
}
