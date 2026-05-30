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

import { beliefs, canEnter } from './beliefs.js';
import { planTo } from './pathfinding.js';
import { planWithPDDL } from '../pddl/pddlPlanner.js';
import {
    getCurrentIntention,
    notifyIntentionDone,
    notifyActionFailed,
} from './intentionRevision.js';

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

// Maps each direction to its delta, used for the canEnter pre-check before emitMove.
const DIR_DELTA = {
    up:    { dx:  0, dy:  1 },
    down:  { dx:  0, dy: -1 },
    left:  { dx: -1, dy:  0 },
    right: { dx:  1, dy:  0 },
};


/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */
/** @typedef {import('../shared/types.js').Position}  Position */


/**
 * Check if the agent is at the target
 * @param {Position} target 
 * @returns {boolean}
 */
function isAtTarget(target) {
    if (!target) return false;
    return Math.round(beliefs.me.x) === target.x
        && Math.round(beliefs.me.y) === target.y;
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
 * Starts the executor loop. Must be called only once after creating the socket.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 */
export async function startExecutor(socket) {
    /** @type {Intention | null} */
    let lastIntention = null;

    while (true) {
        await new Promise(r => setImmediate(r));

        if (!meReady()) continue;

        const intention = getCurrentIntention();
        if (!intention) continue;

        // A new intention was selected, so mark it as the current active one.
        if (intention !== lastIntention) {
            lastIntention = intention;
            intention.status = 'active';
        }

        switch (intention.type) {
            case 'wait':
                continue;

            case 'explore':
            case 'go_pick_up':
            case 'go_deliver':
                await stepTowardsTarget(socket, intention);
                continue;
        }
    }
}

// Step toward the target.

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function stepTowardsTarget(socket, intention) {
    // 1. is at goal ?
    if (isAtTarget(intention.targetPos)) {
        await finalize(socket, intention);
        return;
    }

    //2. If the plan is empty, compute it using the selected planner.
    if (!intention.plan || intention.plan.length === 0) {
        const moves = await computePlan(intention);
        if (moves.length === 0) {
            console.log(`[executor] No path to (${intention.targetPos.x},${intention.targetPos.y})`);
            notifyActionFailed('no_path');
            return;
        }
        intention.plan = moves;
    }

    //3. Dynamic replanning: check whether the next planned tile is still valid.
    const next = intention.plan[0];
    if (!isStepValid(next)) {
        console.log(`[executor] Step ${next} no longer valid → replan`);
        intention.plan = [];
        return;
    }

    // 4. Execute next step
    const dir = intention.plan.shift();
    const fxBefore = Math.round(beliefs.me.x);
    const fyBefore = Math.round(beliefs.me.y);
    const moved = await socket.emitMove(dir);

    if (!moved) {
        // Blocked tile: discard the current plan and replan on the next iteration.
        const targetTile = beliefs.grid.get(`${fxBefore + (DIR_DELTA[dir]?.dx ?? 0)},${fyBefore + (DIR_DELTA[dir]?.dy ?? 0)}`);
        console.log(`[executor] Move failed: ${dir} from (${fxBefore},${fyBefore}) → tile=${targetTile?.type} moved=${JSON.stringify(moved)}`);
        intention.plan = [];
        notifyActionFailed('move_blocked');
        return;
    }

    // Update our position immediately instead of waiting for the next sensing update.
    beliefs.me.x = moved.x;
    beliefs.me.y = moved.y;
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
            console.log('[executor] PDDL unavailable, no fallback configured (set PDDL_FALLBACK=true to enable A*)');
            return [];
        }
        console.log('[executor] PDDL unavailable → A* fallback');
    }
    return planTo(intention.targetPos);
}

// Final Actions

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').DjsClientSocket} socket
 * @param {Intention} intention
 */
async function finalize(socket, intention) {
    if (intention.type === 'go_pick_up') {
        const picked = await socket.emitPickup();
        if (!picked || picked.length === 0) {
            console.log(`[executor] Empty pickup (parcel ${intention.parcelId} probably taken by another agent)`);
            notifyActionFailed('pickup_empty');
            return;
        }

        // Optimistic update: prevents the next deliberation from treating
        // the parcel as free before the next sensing update arrives.
        for (const p of picked) {
            const id = p.id ?? intention.parcelId;
            const parcel = beliefs.parcels.get(id);
            if (parcel) parcel.carriedBy = beliefs.me.id;
            if (id && !beliefs.me.carrying.includes(id)) beliefs.me.carrying.push(id);
        }

        console.log(`[executor] Pickup OK: ${picked.length} parcel(s) (carrying=${beliefs.me.carrying.length})`);
        notifyIntentionDone();
        return;
    }

    if (intention.type === 'go_deliver') {
        const dropped = await socket.emitPutdown();

        
        // Immediate cleanup of all carried parcels.
        for (const id of beliefs.me.carrying) {
            beliefs.parcels.delete(id);
        }
        beliefs.me.carrying = [];

        // Then apply the server-confirmed dropped parcels.
        for (const p of (dropped ?? [])) {
            if (p.id) beliefs.parcels.delete(p.id);
        }

        console.log(`[executor] Delivery OK: ${(dropped ?? []).length} parcel(s)`);
        notifyIntentionDone();
        return;
    }
}
