/**
 * intentionRevision.js
 *
 * Manages the lifecycle of Intentions.
 *
 */

import { beliefs, isWalkable, manhattanDistance } from './beliefs.js';
import { getBestIntention, createIntention } from './deliberation.js';
import { broadcastIntention } from '../multi/notifier.js';
import { isParcelClaimedByPeer, requestTakeover, evaluateHandoff, requestHandoff } from '../multi/coordinator.js';
import { MSG_TYPE, onMessage } from '../multi/communication.js';
import { aStar } from './pathfinding.js';

// Improvement threshold: replace the current intention only if the new one
// is significantly better.
const IMPROVEMENT_THRESHOLD = 5;
const SAME_ZONE_TARGET_DISTANCE = 2;

// Max lifetime of a 'wait' intention: after this, force a fresh deliberation
// so the agent can never stay idle indefinitely.
const WAIT_MAX_AGE_MS = 5000;

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
    if (USE_LLM_CODEGEN) {
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

    // After each pickup, check if a handoff to the peer is beneficial.
    if (beliefs.me.carrying.length >= 2) {
        const handoff = evaluateHandoff();
        if (handoff) {
            console.log(`[intentionRevision] Proposing handoff to ${handoff.peerId}`);
            requestHandoff(handoff.meetTile, handoff.peerId)
                .then((res) => {
                    if (res.accepted) {
                        console.log(`[intentionRevision] Handoff accepted → go_handoff`);
                        const intention = createIntention(
                            'go_handoff', null, handoff.meetTile, 0
                        );
                        commitNewIntention(intention);
                    } else {
                        revise(true);
                    }
                })
                .catch(() => revise(true));
            return;
        }
    }

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

        case 'go_handoff':
        case 'go_handoff_receive':
            return !!intention.targetPos;

        case 'explore':
        case 'wait':
            return true;
    }
}

// Main function

/**
 * revise(force = false) - Main revision function.
 * Called:
 *   - On each sensing event from index_a.js / index_b.js
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

        // 'wait' is a last-resort intention with no progress to protect:
        // replace it with any non-wait candidate, bypassing the threshold.
        const escapeWait =
            currentIntention.type === 'wait' && candidate.type !== 'wait';

        // Safety net: a wait older than WAIT_MAX_AGE_MS forces a fresh deliberation.
        const waitExpired =
            currentIntention.type === 'wait' &&
            Date.now() - currentIntention.createdAt > WAIT_MAX_AGE_MS;

        const pickupBeatsLowValueRoaming =
            candidate.type === 'go_pick_up' &&
            candidate.score > 0 &&
            (
                currentIntention.type === 'explore' ||
                (currentIntention.type === 'go_to' && currentIntention.score <= 0)
            );

        const improvement = candidate.score - currentIntention.score;
        if ( escapeWait || waitExpired || pickupBeatsLowValueRoaming || improvement > IMPROVEMENT_THRESHOLD ) {
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

// Called by index_a.js and index_b.js on each sensing event
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
 * Call once from index_a.js / index_b.js after initCoordinator().
 */
export function initZoneAssignHandler() {
    onMessage(MSG_TYPE.ZONE_ASSIGN, (envelope) => {
        const { targetId, center, score: payloadScore, totalReward } = envelope.payload ?? {};

        // Ignore assignments meant for the other agent.
        if (targetId !== beliefs.me.id) return;
        if (!center) return;

        const score = payloadScore ?? totalReward ?? 0;

        const currentScore = currentIntention?.score ?? 0;
        const currentType = currentIntention?.type ?? null;

        const isLowValueIntention =
            !currentIntention ||
            currentType === 'wait' ||
            currentType === 'explore' ||
            (currentType === 'go_to' && currentScore <= 0);

        const hasImportantIntention =
            currentIntention &&
            currentIntention.status === 'active' &&
            !isLowValueIntention;

        if (
            currentIntention?.targetPos &&
            manhattanDistance(currentIntention.targetPos, center) <= SAME_ZONE_TARGET_DISTANCE
        ) {
            console.log(
                `[intentionRevision] Zone assign ignored: target already close ` +
                `current=(${currentIntention.targetPos.x},${currentIntention.targetPos.y}) ` +
                `assigned=(${center.x},${center.y})`
            );
            return;
        }

        const myPos =
        beliefs.me.x !== null && beliefs.me.y !== null
            ? { x: beliefs.me.x, y: beliefs.me.y }
            : null;

        if (myPos && !aStar(myPos, center, { avoidAgents: false })) {
            console.log(
                `[intentionRevision] Zone assign ignored: unreachable center ` +
                `(${center.x},${center.y})`
            );
            return;
        }

        if (
            hasImportantIntention &&
            score - currentScore <= IMPROVEMENT_THRESHOLD
        ) {
            console.log(
                `[intentionRevision] Zone assign ignored: ` +
                `assignment=${score.toFixed(1)} ` +
                `current=${currentScore.toFixed(1)} ` +
                `threshold=${IMPROVEMENT_THRESHOLD}`
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
