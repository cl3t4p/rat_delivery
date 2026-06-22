/**
 * Manages the active BDI intention.
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
    isPeerGoToLocked,
    clearPeerGoToLock,
} from './coordination.js';

import { USE_PDDL, manhattanDistance } from './helper.js';

import { findNearestSpawnerTile } from './components/tilesearch.js';

// Minimum score gain needed to replace the active intention.
const IMPROVEMENT_THRESHOLD = 5;

// Maximum age for a wait intention.
const WAIT_MAX_AGE_MS = 3000;

// No-progress timeout for active targets.
const STUCK_TIMEOUT_MS = 4000;

// LLM deliberation mode.
const USE_LLM = process.env.USE_LLM === 'true';

// Legacy policy-codegen mode.
const USE_LLM_POLICY = process.env.USE_LLM_POLICY === 'true';

/** @type {Intention|null} */
let currentIntention = null;

// Prevents overlapping async deliberations.
let deliberationInFlight = false;

// Invalidates stale deliberation results after an interrupt.
let _deliberationGen = 0;

// Tracks progress toward the current target.
let _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };

export function requestRevision(force = false) {
    revise(force).catch((err) => {
        console.error(`[intentionRevision] revise failed: ${err?.message ?? err}`);
    });
}

/**
 * Preempts the current intention and starts a fresh deliberation.
 */
export function interruptForRevision() {
    _deliberationGen++;
    if (currentIntention && currentIntention.status === 'active') {
        currentIntention.status = 'failed';
        broadcastIntention(currentIntention);
        currentIntention = null;
    }
    requestRevision(true);
}

/**
 * Produces the next intention with the configured strategy.
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
    console.log(`[intentionRevision] Failed: ${reason}, re-evaluating`);
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
    clearPeerGoToLock();
    currentIntention = null;

    // After pickup or delivery, see whether a handoff is worth starting.
    if (beliefs.me.carrying.length >= 1) {
        const handoff = evaluateHandoff();
        if (handoff) {
            proposeHandoff(handoff);
            return;
        }
    }

    requestRevision(true);
}

// Placeholder wait used while a handoff request is in flight.
function isHandoffRetryWait(intention) {
    return intention?.type === 'wait' && intention._handoffRetry === true;
}

// Commits and broadcasts a replacement intention.
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

// Intention-control hooks used by the multi-agent layer.

/**
 * Commits a new intention without failing the previous one.
 *
 * @param {Intention} intention
 */
export function commitIntention(intention) {
    commitNewIntention(intention);
}

/**
 * Clears the active intention so the next revise() can choose a fresh one.
 */
export function clearIntention() {
    if (!currentIntention) return;
    currentIntention.status = 'failed';
    broadcastIntention(currentIntention);
    currentIntention = null;
}

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
                console.log(`[intentionRevision] Parcel ${intention.parcelId} disappeared`);
                return false;
            }
            if (parcel.carriedBy && parcel.carriedBy !== beliefs.me.id) {
                console.log(
                    `[intentionRevision] Parcel ${intention.parcelId} taken by someone else (${parcel.carriedBy})`
                );
                return false;
            }
            if (parcel.reward <= 0) {
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

        case 'go_deliver':
        case 'drop': {
            return beliefs.me.carrying.length > 0;
        }

        case 'go_to': {
            if (!intention.targetPos) return false;
            return isWalkable(intention.targetPos.x, intention.targetPos.y);
        }

        case 'go_handoff':
        case 'go_handoff_receive':
            return intention.targetPos != null

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

/**
 * Revises the active intention after sensing, failure, or completion.
 *
 * @param {boolean} [force=false]
 */
export async function revise(force = false) {
    // Drop invalid active intentions.
    if (currentIntention && currentIntention.status === 'active') {
        if (!isIntentionStillValid(currentIntention)) {
            console.log(`[intentionRevision] No longer valid: ${currentIntention.type}`);
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
            currentIntention = null;
        }
    }

    // Create a new intention while idle.
    if (
        !currentIntention ||
        currentIntention.status === 'failed' ||
        currentIntention.status === 'done'
    ) {
        // Do not stack async deliberations.
        if (deliberationInFlight) return;
        deliberationInFlight = true;

        _deliberationGen++;
        const gen = _deliberationGen;
        let rerun = false;
        try {
            const next = await deliberate();
            // A newer interrupt made this result stale.
            if (gen !== _deliberationGen) {
                rerun = true;
            } else if (
                // Only commit if the agent is still idle.
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
        // Re-run outside the in-flight guard.
        if (rerun) requestRevision(true);
        return;
    }

    // Compare an active intention against the best current option.
    if (!force && currentIntention.status === 'active') {
        // LLM mode: the model owns replacement decisions.
        if (USE_LLM) {
            if (currentIntention.type !== 'wait') return;
            if (deliberationInFlight) return;
            deliberationInFlight = true;
            try {
                const next = await deliberate();
                if (currentIntention?.type === 'wait' && next.type !== 'wait') {
                    console.log('[intentionRevision] Replacing wait (LLM)');
                    currentIntention.status = 'failed';
                    broadcastIntention(currentIntention);
                    commitNewIntention(next);
                }
            } finally {
                deliberationInFlight = false;
            }
            return;
        }

        // Heuristic mode: cheap comparison on every sensing tick.
        // Best option available right now to weigh against the active intention.
        let candidate = getBestIntention();
        // While walking a target-less go_to, prefer grabbing a parcel right next to us.
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

        // Always try to never 'wait'
        const escapeWait = currentIntention.type === 'wait' && candidate.type !== 'wait';

        // Wait has expired
        const waitExpired =
            currentIntention.type === 'wait' &&
            Date.now() - currentIntention.createdAt > WAIT_MAX_AGE_MS;


        //I'm roaming, should I switch TO a pickup?"
        const pickupBeatsLowValueRoaming =
            candidate.type === 'go_pick_up' &&
            (currentIntention.type === 'explore' ||
                (currentIntention.type === 'go_to' && !currentIntention.parcelId)) &&
            candidate.score > 0 &&
            !isPeerGoToLocked();

        //I'm heading to a pickup, should I drop it FOR roaming?
        const exploringBeatsPickup =
            currentIntention.type === 'go_pick_up' &&
            (candidate.type === 'explore' || (candidate.type === 'go_to' && !candidate.parcelId)) &&
            candidate.score <= 0;

        // is this a handoff in progress? then leave it alone
        const handoffProtected =
            currentIntention.type === 'go_handoff' ||
            currentIntention.type === 'go_handoff_receive' ||
            isHandoffRetryWait(currentIntention);

        // did a peer command this move? then don't score over it
        const peerGoToProtected =
            currentIntention.type === 'go_to' && !currentIntention.parcelId && isPeerGoToLocked();

        const improvement = candidate.score - currentIntention.score;
        if (
            !exploringBeatsPickup &&
            !handoffProtected &&
            !peerGoToProtected &&
            (escapeWait ||
                waitExpired ||
                pickupBeatsLowValueRoaming ||
                improvement > IMPROVEMENT_THRESHOLD)
        ) {
            let reason = `+${improvement}`;
            if (escapeWait) {
                reason = 'escaping wait';
            } else if (waitExpired) {
                reason = 'wait expired';
            } else if (pickupBeatsLowValueRoaming) {
                reason = 'pickup beats roaming';
            }
            console.log(`[intentionRevision] Replacing intention (${reason})`);
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
            commitNewIntention(candidate);
        }
    }
}

/**
 * Forces re-deliberation when the agent stops progressing toward its target.
 */
function checkStuck() {
    if (USE_PDDL) return;
    if (!currentIntention) {
        //Reset watchdog
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        return;
    }
    // Preserve watchdog state between failure and the next revision.
    if (currentIntention.status !== 'active') return;
    if (currentIntention.type === 'wait') return;
    if (!currentIntention.targetPos) return;

    const x = Number.isFinite(beliefs.me.x) ? Math.round(beliefs.me.x) : -1;
    const y = Number.isFinite(beliefs.me.y) ? Math.round(beliefs.me.y) : -1;
    const tx = currentIntention.targetPos.x;
    const ty = currentIntention.targetPos.y;

    //Am I already on the target tile.
    if (x === tx && y === ty) {
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        return;
    }


    const dist = manhattanDistance({ x, y }, { x: tx, y: ty });

    //Check that the goal for the watchdog had not changed from the intention
    const sameGoal = tx === _stuckWatchdog.targetX && ty === _stuckWatchdog.targetY;
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
                `for ${staleMs}ms (bestDist=${_stuckWatchdog.bestDist}), forcing re-deliberation`
        );
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        clearPeerGoToLock();
        if (currentIntention) {
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
        }
        currentIntention = null;
        requestRevision(true);
    }
}

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
