/**
 * intentionRevision.js
 *
 * Manages the lifecycle of Intentions.
 *
 */

import { beliefs } from "./beliefs.js";
import { getBestIntention, createIntention } from "./deliberation.js";

// Improvement threshold: replace the current intention only if the new one
// is significantly better.
const IMPROVEMENT_THRESHOLD = 5;

/** @type {Intention|null} */
let currentIntention = null;

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
    if (currentIntention) currentIntention.status = 'failed';
    revise(true);
}

/**
 * Marks the current intention as completed and triggers a forced revision.
 *
 * @returns {void}
 */
export function notifyIntentionDone() {
    console.log(`[intentionRevision] Completed: ${currentIntention?.type}`);
    if (currentIntention) currentIntention.status = 'done';
    currentIntention = null;
    revise(true);
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
        case 'go_pick_up' : {
            if (!intention.parcelId) return false;
            const parcel = beliefs.parcels.get(intention.parcelId);
            if (!parcel) { // Parcel disappeared.
                console.log(`[intentionRevision] Parcel ${intention.parcelId} disappeared`);
                return false;
            }
            if (parcel.carriedBy && parcel.carriedBy !== beliefs.me.id) { // Parcel was picked up by another agent.
                console.log(`[intentionRevision] Parcel ${intention.parcelId} taken by someone else (${parcel.carriedBy})`);
                return false;
            }
            if (parcel.reward <= 0) { // Parcel reward has reached zero.
                console.log(`[intentionRevision] Parcel ${intention.parcelId} reward depleted`);
                return false;
            }
            return true;
        }

        case 'go_deliver': {
            return beliefs.me.carrying.length > 0; // Valid only if i am carrying something
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
export function revise(force = false) {
    // Check if the current intention is still valid
    if (currentIntention && currentIntention.status === 'active') {
        if (!isIntentionStillValid(currentIntention)) {
            console.log(`[intentionRevision] No longer valid: ${currentIntention.type}`);
            currentIntention.status = 'failed';
            currentIntention = null;
        }
    }

    // If there is no active intention, create a new one
    if (!currentIntention || currentIntention.status === 'failed' || currentIntention.status === 'done') {
        currentIntention = getBestIntention();
        console.log(`[intentionRevision] New: ${currentIntention?.type} score=${currentIntention?.score}`);
        return;
    }

    // If there is already an active intention, compare it with the best option
    if (!force && currentIntention.status === 'active') {
        const candidate = getBestIntention();
        if (!candidate) return;

        const improvement = candidate.score - currentIntention.score;
        if (improvement > IMPROVEMENT_THRESHOLD) {
            console.log(`[intentionRevision] Better option found (+${improvement}): replacing`);
            currentIntention.status = 'failed';
            currentIntention = candidate;
        }
    }
}

// Called by index.js on each sensing event
export function onSensingRevise() {
    revise(false);
}