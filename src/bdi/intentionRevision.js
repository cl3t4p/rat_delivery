/**
 * intentionRevision.js
 *
 * Manages the lifecycle of Intentions.
 *
 */

import { beliefs, isWalkable } from './beliefs.js';
import { getBestIntention, resetRoamTarget, findBestLocalPickUp } from './deliberation.js';
import {
    broadcastIntention,
    isParcelClaimedByPeer,
    shouldYieldParcel,
    requestTakeover,
    evaluateHandoff,
    proposeHandoff,
} from './coordination.js';

// Improvement threshold: replace the current intention only if the new one
// is significantly better.
const IMPROVEMENT_THRESHOLD = 5;

// Max lifetime of a 'wait' intention: after this, force a fresh deliberation
// so the agent can never stay idle indefinitely.
const WAIT_MAX_AGE_MS = 5000;

// Stuck watchdog: if the agent hasn't made progress toward its target for
// this long, force a fresh deliberation — escapes tight failure loops where
// the executor keeps retrying an unreachable or blocked destination.
const STUCK_TIMEOUT_MS = 4000;

// When enabled, the next intention is chosen by the standalone LLM agent
// (see ../llm/intentionAgent.js) instead of the deterministic heuristic.
const USE_LLM = process.env.USE_LLM === 'true';

// When enabled, the next intention is produced by the LLM policy agent
// (see ../llm/policyAgent.js) instead of the per-tick intention agent.
const USE_LLM_POLICY = process.env.USE_LLM_POLICY === 'true';

// In PDDL mode the planner produces multi-step plans that legitimately detour
// away from the target (e.g. circling a crate to push it from the right side),
// which the distance-based stuck watchdog would mistake for being stuck and abort.
// The pddl branch has no watchdog and works, so we simply disable it here.
const USE_PDDL = process.env.USE_PDDL === 'true';

/** @type {Intention|null} */
let currentIntention = null;

// Guards against launching overlapping LLM deliberations: the model call is
// async and slow compared to the sensing rate, so at most one runs at a time.
let deliberationInFlight = false;

// Tracks the best (minimum) Manhattan distance achieved toward the current target
// and when it last improved. Resets on goal change or arrival.
let _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };

export function requestRevision(force = false) {
    revise(force).catch((err) => {
        console.error(`[intentionRevision] revise failed: ${err?.message ?? err}`);
    });
}

/**
 * Produces the next intention using the configured deliberation strategy.
 *
 * @returns {Promise<Intention>}
 */
async function deliberate() {
    if (USE_LLM_POLICY) {
        const { generateBestIntentionFromPolicy } = await import('../llm/policyAgent.js');
        return generateBestIntentionFromPolicy();
    }
    if (USE_LLM) {
        const { generateBestIntention } = await import('../llm/intentionAgent.js');
        return generateBestIntention();
    }
    return getBestIntention();
}

// Public functions

/**
 * Returns the current intention.
 *
 * @returns {Intention|null}
 */
export function getCurrentIntention() {
    return currentIntention;
}

/**
 * Marks the current intention as failed and triggers a forced revision.
 *
 * @param {string} reason - Reason why the action failed.
 * @returns {void}
 */
export function notifyActionFailed(reason) {
    console.log(`[intentionRevision] Failed: ${reason} → re-evaluating`);
    if (currentIntention) {
        currentIntention.status = 'failed';
        broadcastIntention(currentIntention);
    }
    requestRevision(true);
}

/**
 * Marks the current intention as completed and triggers a forced revision.
 *
 * @returns {void}
 */
export function notifyIntentionDone() {
    console.log(`[intentionRevision] Completed: ${currentIntention?.type}`);
    if (currentIntention) {
        currentIntention.status = 'done';
        broadcastIntention(currentIntention);
    }
    currentIntention = null;

    // After each pickup, check if a handoff to the peer is beneficial. The
    // handoff protocol itself lives in the multi layer (multi/coordinator.js)
    // and reaches back into the intention lifecycle through the exported
    // commitIntention / clearIntention / forceIntention primitives. In solo
    // mode evaluateHandoff() returns null, so this short-circuits and we
    // re-deliberate normally.
    if (beliefs.me.carrying.length >= 1) {
        const handoff = evaluateHandoff();
        if (handoff) {
            proposeHandoff(handoff);
            return;
        }
    }

    requestRevision(true);
}

// True when an intention is the placeholder `wait` held while a handoff request
// is in flight (see proposeHandoff in multi/coordinator.js). Such waits are
// protected from preemption in revise().
function isHandoffRetryWait(intention) {
    return intention?.type === 'wait' && intention._handoffRetry === true;
}

// Helper used internally whenever currentIntention is replaced.
// Broadcasts the new intention and, if it's a `go_pick_up` for a parcel
// claimed by a peer, fires a counter-claim request fire-and-forget.
function commitNewIntention(intention) {
    currentIntention = intention;
    if (!intention) return;

    if (intention.type !== 'go_to' && intention.type !== 'explore' && intention.type !== 'wait') {
        resetRoamTarget();
    }

    broadcastIntention(intention);

    if (
        intention.type === 'go_pick_up' &&
        intention.parcelId &&
        isParcelClaimedByPeer(intention.parcelId)
    ) {
        const parcelId = intention.parcelId;
        requestTakeover(parcelId)
            .then((res) => {
                if (!res.accepted && currentIntention?.parcelId === parcelId) {
                    console.log(
                        `[intentionRevision] Takeover refused for ${parcelId} (${res.reason})`
                    );
                    currentIntention.status = 'failed';
                    broadcastIntention(currentIntention);
                    requestRevision(true);
                }
            })
            .catch((err) => {
                console.log(`[intentionRevision] Takeover request error: ${err.message}`);
            });
    }
}

// Intention-control primitives exposed to the multi layer
//
// The handoff protocol (multi/coordinator.js) drives the intention lifecycle
// from outside the BDI core. These small wrappers give it the exact operations
// it needs without exposing the module-private `currentIntention` binding, and
// keep the bdi → multi dependency from ever being created (multi receives them
// via initCoordinator).

/**
 * Commits a new intention, replacing the current one WITHOUT marking the
 * previous one failed (used by the handoff flow when the prior intention was
 * already a completed/failed/placeholder hold).
 *
 * @param {Intention} intention
 */
export function commitIntention(intention) {
    commitNewIntention(intention);
}

/**
 * Fails, broadcasts and clears the current intention so the next revise() can
 * produce a fresh one. Used to abandon a stale handoff-retry wait — a forced
 * revision alone cannot replace an already-active wait.
 */
export function clearIntention() {
    if (!currentIntention) return;
    currentIntention.status = 'failed';
    broadcastIntention(currentIntention);
    currentIntention = null;
}

// Validity check.

/**
 * Checks whether the current intention is still valid.
 *
 * @param {Intention} intention
 * @returns {boolean}
 */
function isIntentionStillValid(intention) {
    switch (intention.type) {
        case 'go_pick_up': {
            if (!intention.parcelId) return false;
            const parcel = beliefs.parcels.get(intention.parcelId);
            if (!parcel) {
                // Parcel disappeared.
                console.log(`[intentionRevision] Parcel ${intention.parcelId} disappeared`);
                return false;
            }
            if (parcel.carriedBy && parcel.carriedBy !== beliefs.me.id) {
                // Parcel was picked up by another agent.
                console.log(
                    `[intentionRevision] Parcel ${intention.parcelId} taken by someone else (${parcel.carriedBy})`
                );
                return false;
            }
            if (parcel.reward <= 0) {
                // Parcel reward has reached zero.
                console.log(`[intentionRevision] Parcel ${intention.parcelId} reward depleted`);
                return false;
            }
            if (beliefs.me.x !== null && beliefs.me.y !== null) {
                const myPos = { x: beliefs.me.x, y: beliefs.me.y };
                if (shouldYieldParcel(intention.parcelId, myPos)) {
                    console.log(
                        `[intentionRevision] Parcel ${intention.parcelId} yielded to closer peer`
                    );
                    return false;
                }
            }
            return true;
        }

        case 'go_deliver': {
            return beliefs.me.carrying.length > 0; // Valid only if i am carrying something
        }

        case 'go_to': {
            // Still valid while the target is a known, walkable cell.
            if (!intention.targetPos) return false;
            return isWalkable(intention.targetPos.x, intention.targetPos.y);
        }

        case 'go_handoff':
        case 'go_handoff_receive':
            return !!intention.targetPos;

        case 'explore':
        case 'wait':
            return true;

        default:
            console.warn(
                `[intentionRevision] Unknown intention type: ${intention.type} — keeping active`
            );
            return true;
    }
}

// Main function

/**
 * revise(force = false) - Main revision function.
 * Called:
 *   - On each sensing event from multiagent_a.js / multiagent_b.js
 *   - In forced mode after a failure or completion
 */
export async function revise(force = false) {
    // Check if the current intention is still valid
    if (currentIntention && currentIntention.status === 'active') {
        if (!isIntentionStillValid(currentIntention)) {
            console.log(`[intentionRevision] No longer valid: ${currentIntention.type}`);
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
            currentIntention = null;
        }
    }

    // If there is no active intention, create a new one
    if (
        !currentIntention ||
        currentIntention.status === 'failed' ||
        currentIntention.status === 'done'
    ) {
        // A deliberation may already be running (LLM calls are async). Don't
        // stack a second one; the in-flight one will commit its result.
        if (deliberationInFlight) return;
        deliberationInFlight = true;
        try {
            const next = await deliberate();
            // While we were waiting, an intention may have been committed or
            // the situation may have changed; only commit if still idle.
            if (
                !currentIntention ||
                currentIntention.status === 'failed' ||
                currentIntention.status === 'done'
            ) {
                commitNewIntention(next);
                console.log(
                    `[intentionRevision] New: ${currentIntention?.type} score=${currentIntention?.score}`
                );
            }
        } finally {
            deliberationInFlight = false;
        }
        return;
    }

    // If there is already an active intention, compare it with the best option.
    // The comparison uses the cheap synchronous heuristic even in LLM mode, so
    // we don't fire a model call on every sensing tick.
    if (!force && currentIntention.status === 'active') {
        let candidate = getBestIntention();
        if (
            currentIntention.type === 'go_to' &&
            !currentIntention.parcelId &&
            beliefs.me.x !== null &&
            beliefs.me.y !== null
        ) {
            const localPickUp = findBestLocalPickUp({ x: beliefs.me.x, y: beliefs.me.y });
            if (
                localPickUp &&
                (!candidate || localPickUp.score > candidate.score || candidate.type === 'go_to')
            ) {
                candidate = localPickUp;
            }
        }
        if (!candidate) return;

        // 'wait' is a last-resort intention with no progress to protect:
        // replace it with any non-wait candidate, bypassing the threshold.
        const escapeWait = currentIntention.type === 'wait' && candidate.type !== 'wait';

        // Safety net: a wait older than WAIT_MAX_AGE_MS forces a fresh deliberation.
        const waitExpired =
            currentIntention.type === 'wait' &&
            Date.now() - currentIntention.createdAt > WAIT_MAX_AGE_MS;

        const pickupBeatsLowValueRoaming =
            candidate.type === 'go_pick_up' &&
            (currentIntention.type === 'explore' ||
                (currentIntention.type === 'go_to' && !currentIntention.parcelId)) &&
            candidate.score > 0;

        // Don't let a zero-score explore/roam interrupt an active pickup, even if
        // the pickup has a negative score. Explore targets are often the spawner the
        // agent just stepped off, so replacing causes an infinite oscillation loop:
        // go_pick_up → explore (completes instantly) → go_pick_up → ...
        const exploringBeatsPickup =
            currentIntention.type === 'go_pick_up' &&
            (candidate.type === 'explore' || (candidate.type === 'go_to' && !candidate.parcelId)) &&
            candidate.score <= 0;

        // Handoff intentions represent a bilateral commitment: A has already
        // accepted and may have dropped parcels at the meetTile. Never preempt
        // them with an opportunistic pickup — let the handoff complete first.
        const handoffProtected =
            currentIntention.type === 'go_handoff' ||
            currentIntention.type === 'go_handoff_receive' ||
            isHandoffRetryWait(currentIntention);

        const improvement = candidate.score - currentIntention.score;
        if (
            !exploringBeatsPickup &&
            !handoffProtected &&
            (escapeWait ||
                waitExpired ||
                pickupBeatsLowValueRoaming ||
                improvement > IMPROVEMENT_THRESHOLD)
        ) {
            const reason = escapeWait
                ? 'escaping wait'
                : waitExpired
                  ? 'wait expired'
                  : pickupBeatsLowValueRoaming
                    ? 'pickup beats roaming'
                    : `+${improvement}`;
            console.log(`[intentionRevision] Replacing intention (${reason})`);
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
            commitNewIntention(candidate);
        }
    }
}

/**
 * Detects when the agent has not moved toward its current target for
 * STUCK_TIMEOUT_MS and forces a fresh re-deliberation.
 * Escapes tight executor failure loops (no-path / move-blocked cycling)
 * that keep re-picking the same unreachable tile.
 */
function checkStuck() {
    if (USE_PDDL) return; // PDDL plans take legitimate detours; watchdog disabled (see USE_PDDL).
    if (!currentIntention) {
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        return;
    }
    // Mid-cycle (failed/done awaiting revise): preserve watchdog state so stale-time accumulates.
    if (currentIntention.status !== 'active') return;
    if (currentIntention.type === 'wait') return;
    if (!currentIntention.targetPos) return;

    const x = Number.isFinite(beliefs.me.x) ? Math.round(beliefs.me.x) : -1;
    const y = Number.isFinite(beliefs.me.y) ? Math.round(beliefs.me.y) : -1;
    const tx = currentIntention.targetPos.x;
    const ty = currentIntention.targetPos.y;

    // Already at target — executor will finalise; not stuck.
    if (x === tx && y === ty) {
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        return;
    }

    const sameGoal = tx === _stuckWatchdog.targetX && ty === _stuckWatchdog.targetY;
    const dist = Math.abs(x - tx) + Math.abs(y - ty);

    if (!sameGoal) {
        _stuckWatchdog = { bestDist: dist, lastImprovement: Date.now(), targetX: tx, targetY: ty };
        return;
    }

    if (dist < _stuckWatchdog.bestDist) {
        _stuckWatchdog.bestDist = dist;
        _stuckWatchdog.lastImprovement = Date.now();
        return;
    }

    const staleMs = Date.now() - _stuckWatchdog.lastImprovement;
    if (staleMs >= STUCK_TIMEOUT_MS) {
        console.log(
            `[intentionRevision] Stuck: no progress toward (${tx},${ty}) ` +
                `for ${staleMs}ms (bestDist=${_stuckWatchdog.bestDist}) → forcing re-deliberation`
        );
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        if (currentIntention) {
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
        }
        currentIntention = null;
        requestRevision(true);
    }
}

// Called by multiagent_a.js and multiagent_b.js on each sensing event
export function onSensingRevise() {
    checkStuck();
    requestRevision(false);
}

/**
 * Forces a specific intention immediately, bypassing deliberation.
 * Used by the coordinator to assign go_handoff_receive to agent B.
 *
 * @param {Intention} intention
 */
export function forceIntention(intention) {
    if (currentIntention) {
        currentIntention.status = 'failed';
        broadcastIntention(currentIntention);
    }
    commitNewIntention(intention);
    console.log(`[intentionRevision] Forced: ${intention.type}`);
}

export function resetIntentionForTests() {
    currentIntention = null;
}
