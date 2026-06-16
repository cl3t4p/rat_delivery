/**
 * intentionRevision.js
 *
 * Manages the lifecycle of Intentions.
 *
 */

import { beliefs, isWalkable, manhattanDistance } from './beliefs.js';
import { getBestIntention, createIntention, setZoneConstraint, resetRoamTarget, findBestLocalPickUp } from './deliberation.js';
import { broadcastIntention } from '../multi/notifier.js';
import { isParcelClaimedByPeer, shouldYieldParcel, requestTakeover, evaluateHandoff, requestHandoff, getNearestReachableZoneTarget, getPeers } from '../multi/coordinator.js';
import { MSG_TYPE, onMessage } from '../multi/communication.js';
import { aStar } from './pathfinding.js';

// Improvement threshold: replace the current intention only if the new one
// is significantly better.
const IMPROVEMENT_THRESHOLD = 5;
const SAME_ZONE_TARGET_DISTANCE = 0;

// Max lifetime of a 'wait' intention: after this, force a fresh deliberation
// so the agent can never stay idle indefinitely.
const WAIT_MAX_AGE_MS = 5000;

// Stuck watchdog: if the agent hasn't made progress toward its target for
// this long, force a fresh deliberation — escapes tight failure loops where
// the executor keeps retrying an unreachable or blocked destination.
const STUCK_TIMEOUT_MS = 4000;
const HANDOFF_BUSY_RETRY_MS = 300;
const HANDOFF_BUSY_SLOW_RETRY_MS = 1000;
const HANDOFF_BUSY_FAST_RETRIES = 6;

// When enabled, the next intention is chosen by the standalone LLM agent
// (see ../llm/intentionAgent.js) instead of the deterministic heuristic.
const USE_LLM = process.env.USE_LLM === 'true';

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

    // After each pickup, check if a handoff to the peer is beneficial.
    if (beliefs.me.carrying.length >= 1) {
        const handoff = evaluateHandoff();
        if (handoff) {
            proposeHandoffWithBusyRetry(handoff);
            return;
        }
    }

    requestRevision(true);
}

function proposeHandoffWithBusyRetry(handoff, attempt = 0) {
    if (beliefs.me.carrying.length < 1) {
        requestRevision(true);
        return;
    }

    if (!currentIntention || currentIntention.status === 'failed' || currentIntention.status === 'done') {
        const hold = createIntention(
            'wait',
            null,
            beliefs.me.x !== null && beliefs.me.y !== null
                ? { x: Math.round(beliefs.me.x), y: Math.round(beliefs.me.y) }
                : null,
            0
        );
        hold._handoffRetry = true;
        hold._handoffRetryPeerId = handoff.peerId;
        commitNewIntention(hold);
    } else if (!isHandoffRetryWait(currentIntention)) {
        return;
    }

    currentIntention.createdAt = Date.now();

    console.log(`[intentionRevision] Proposing handoff to ${handoff.peerId}`);
    requestHandoff(handoff.meetTile, handoff.peerId)
        .then((res) => {
            if (res.accepted) {
                if (currentIntention && !isHandoffRetryWait(currentIntention)) return;
                console.log(`[intentionRevision] Handoff accepted → go_handoff`);
                const intention = createIntention(
                    'go_handoff', null, handoff.meetTile, 0
                );
                intention._peerStagingTile = res.stagingTile ?? null;
                intention._peerId = handoff.peerId;
                intention._peerCarryBefore =
                    getPeers().find((p) => p.id === handoff.peerId)?.carrying ?? 0;
                commitNewIntention(intention);
                return;
            }

            if (res.reason === 'busy') {
                if (currentIntention && !isHandoffRetryWait(currentIntention)) return;
                const delay =
                    attempt < HANDOFF_BUSY_FAST_RETRIES
                        ? HANDOFF_BUSY_RETRY_MS
                        : HANDOFF_BUSY_SLOW_RETRY_MS;
                console.log(
                    `[intentionRevision] Handoff peer busy → retry ` +
                    `${attempt + 1}${attempt >= HANDOFF_BUSY_FAST_RETRIES ? ' (slow)' : `/${HANDOFF_BUSY_FAST_RETRIES}`}`
                );
                setTimeout(
                    () => proposeHandoffWithBusyRetry(handoff, attempt + 1),
                    delay
                );
                return;
            }

            abandonHandoffRetryWait();
            requestRevision(true);
        })
        .catch(() => {
            abandonHandoffRetryWait();
            requestRevision(true);
        });
}

function isHandoffRetryWait(intention) {
    return intention?.type === 'wait' && intention._handoffRetry === true;
}

// Clears a stuck _handoffRetry wait so revise() can produce a fresh intention.
// Called when a handoff attempt fails or times out, since requestRevision(true)
// alone cannot replace an already-active wait (revise skips the comparison block
// when force=true and an active intention exists).
function abandonHandoffRetryWait() {
    if (isHandoffRetryWait(currentIntention)) {
        currentIntention.status = 'failed';
        broadcastIntention(currentIntention);
        currentIntention = null;
    }
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
                    console.log(`[intentionRevision] Parcel ${intention.parcelId} yielded to closer peer`);
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
            console.warn(`[intentionRevision] Unknown intention type: ${intention.type} — keeping active`);
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
        let candidate = getBestIntention();
        if (
            currentIntention.type === 'go_to' &&
            !currentIntention.parcelId &&
            beliefs.me.x !== null &&
            beliefs.me.y !== null
        ) {
            const localPickUp = findBestLocalPickUp({ x: beliefs.me.x, y: beliefs.me.y });
            if (localPickUp && (!candidate || localPickUp.score > candidate.score || candidate.type === 'go_to')) {
                candidate = localPickUp;
            }
        }
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
            (
                currentIntention.type === 'explore' ||
                (currentIntention.type === 'go_to' && !currentIntention.parcelId)
            ) &&
            candidate.score > 0;

        // Don't let a zero-score explore/roam interrupt an active pickup, even if
        // the pickup has a negative score. Explore targets are often the spawner the
        // agent just stepped off, so replacing causes an infinite oscillation loop:
        // go_pick_up → explore (completes instantly) → go_pick_up → ...
        const exploringBeatsPickup =
            currentIntention.type === 'go_pick_up' &&
            (candidate.type === 'explore' ||
             (candidate.type === 'go_to' && !candidate.parcelId)) &&
            candidate.score <= 0;

        // Handoff intentions represent a bilateral commitment: A has already
        // accepted and may have dropped parcels at the meetTile. Never preempt
        // them with an opportunistic pickup — let the handoff complete first.
        const handoffProtected =
            currentIntention.type === 'go_handoff' ||
            currentIntention.type === 'go_handoff_receive' ||
            isHandoffRetryWait(currentIntention);

        const improvement = candidate.score - currentIntention.score;
        if ( !exploringBeatsPickup && !handoffProtected && (escapeWait || waitExpired || pickupBeatsLowValueRoaming || improvement > IMPROVEMENT_THRESHOLD) ) {
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
    if (!currentIntention) {
        _stuckWatchdog = { bestDist: Infinity, lastImprovement: 0, targetX: null, targetY: null };
        return;
    }
    // Mid-cycle (failed/done awaiting revise): preserve watchdog state so stale-time accumulates.
    if (currentIntention.status !== 'active') return;
    if (currentIntention.type === 'wait') return;
    if (!currentIntention.targetPos) return;

    const x  = Number.isFinite(beliefs.me.x) ? Math.round(beliefs.me.x) : -1;
    const y  = Number.isFinite(beliefs.me.y) ? Math.round(beliefs.me.y) : -1;
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

// Called by index_a.js and index_b.js on each sensing event
export function onSensingRevise() {
    checkStuck();
    requestRevision(false);
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

        // Resolve the navigation target: use the assigned centre if reachable,
        // otherwise find the nearest reachable tile in the zone (spawner first,
        // then the closest walkable tile to the geometric centre).
        let target = center;
        if (myPos && !aStar(myPos, target, { avoidAgents: false })) {
            const zoneName = envelope.payload?.zone ?? null;
            const alternative = zoneName
                ? getNearestReachableZoneTarget(zoneName, myPos)
                : null;
            if (alternative && aStar(myPos, alternative, { avoidAgents: false })) {
                console.log(
                    `[intentionRevision] Zone centre unreachable (${center.x},${center.y})` +
                    ` → nearest reachable (${alternative.x},${alternative.y})`
                );
                target = alternative;
            } else {
                console.log(
                    `[intentionRevision] Zone assign ignored: no reachable target in zone` +
                    ` (centre=(${center.x},${center.y}))`
                );
                return;
            }
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

        // Persist the zone so every future deliberation cycle stays within it,
        // not just the one-shot go_to waypoint.
        if (envelope.payload?.zone) setZoneConstraint(envelope.payload.zone);

        if (envelope.payload?.forceNavigation === false) {
            console.log(
                `[intentionRevision] Zone assign refreshed constraint only: ${envelope.payload.zone}`
            );
            return;
        }

        const intention = createIntention('go_to', null, target, score);
        console.log(
            `[intentionRevision] Zone assign accepted → go_to (${target.x},${target.y}) score=${score}`
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

export function resetIntentionForTests() {
    currentIntention = null;
}
