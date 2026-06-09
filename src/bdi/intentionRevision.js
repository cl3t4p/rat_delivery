/**
 * intentionRevision.js
 *
 * Manages the lifecycle of Intentions.
 *
 */

import { beliefs, isWalkable } from './beliefs.js';
import { getBestIntention, createIntention } from './deliberation.js';
import { generateBestIntention } from '../llm/intentionAgent.js';
import { generateBestIntentionFromPolicy } from '../llm/policyAgent.js';
import { broadcastIntention } from '../multi/notifier.js';
import { isParcelClaimedByPeer, requestTakeover } from '../multi/coordinator.js';
import { MSG_TYPE, onMessage } from '../multi/communication.js';

// Improvement threshold: replace the current intention only if the new one
// is significantly better.
const IMPROVEMENT_THRESHOLD = 5;

// When enabled, the next intention is chosen by the standalone LLM agent
// (see ../llm/intentionAgent.js) instead of the deterministic heuristic.
const USE_LLM = process.env.USE_LLM === 'true';

// When enabled, the LLM instead *writes* the deliberation code once and we run
// the compiled policy every tick (see ../llm/policyAgent.js). Takes precedence
// over USE_LLM.
const USE_LLM_CODEGEN = process.env.USE_LLM_CODEGEN === 'true';

/** @type {Intention|null} */
let currentIntention = null;

// Guards against launching overlapping LLM deliberations: the model call is
// async and slow compared to the sensing rate, so at most one runs at a time.
let deliberationInFlight = false;

/**
 * Produces the next intention using the configured deliberation strategy.
 *
 * @returns {Promise<Intention>}
 */
async function deliberate() {
    if (USE_LLM_CODEGEN) return generateBestIntentionFromPolicy();
    if (USE_LLM) return generateBestIntention();
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
    revise(true);
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
    revise(true);
}

// Helper used internally whenever currentIntention is replaced.
// Broadcasts the new intention and, if it's a `go_pick_up` for a parcel
// claimed by a peer, fires a counter-claim request fire-and-forget.
function commitNewIntention(intention) {
    currentIntention = intention;
    if (!intention) return;
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
                    revise(true);
                }
            })
            .catch((err) => {
                console.log(`[intentionRevision] Takeover request error: ${err.message}`);
            });
    }
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

        case 'explore':
        case 'wait':
            return true;
    }
}

// Main function

/**
 * revise(force = false) - Main revision function.
 * Called:
 *   - On each sensing event from index.js
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
        const candidate = getBestIntention();
        if (!candidate) return;

        const improvement = candidate.score - currentIntention.score;
        if (improvement > IMPROVEMENT_THRESHOLD) {
            console.log(`[intentionRevision] Better option found (+${improvement}): replacing`);
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
            commitNewIntention(candidate);
        }
    }
}

// Called by index.js on each sensing event
export function onSensingRevise() {
    revise(false);
}

/**
 * Registers the handler for incoming ZONE_ASSIGN messages.
 *
 * Converts a zone assignment into a go_to intention toward the zone center.
 * Accepted only if the assignment score exceeds the current intention score
 * by at least IMPROVEMENT_THRESHOLD, so the LLM cannot interrupt a
 * high-value pickup mid-execution.
 *
 * Call once from index.js after initCoordinator().
 */
export function initZoneAssignHandler() {
    onMessage(MSG_TYPE.ZONE_ASSIGN, (envelope) => {
        const { targetId, center, totalReward } = envelope.payload ?? {};

        // Ignore assignments meant for the other agent.
        if (targetId !== beliefs.me.id) return;
        if (!center) return;

        const score = totalReward ?? 0;

        if (
            currentIntention &&
            currentIntention.status === 'active' &&
            score - currentIntention.score <= IMPROVEMENT_THRESHOLD
        ) {
            console.log(
                `[intentionRevision] Zone assign ignored: score=${score} not better than current=${currentIntention.score}`
            );
            return;
        }

        const intention = createIntention('go_to', null, center, score);
        console.log(
            `[intentionRevision] Zone assign accepted → go_to (${center.x},${center.y}) score=${score}`
        );

        if (currentIntention) {
            currentIntention.status = 'failed';
            broadcastIntention(currentIntention);
        }
        commitNewIntention(intention);
    });
}
