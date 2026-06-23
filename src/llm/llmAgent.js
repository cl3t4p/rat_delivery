/**
 * llmAgent.js
 *
 * LLM client and shared memory for the LLM-driven agent.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { beliefs } from '../bdi/beliefs.js';

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
const LLM_FAILURE_THRESHOLD = Number(process.env.LLM_FAILURE_THRESHOLD) || 3;
const LLM_COOLDOWN_MS = Number(process.env.LLM_COOLDOWN_MS) || 120000;
// Prefer a slow answer over skipping the mission tick too early.
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;
const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES) || 1;

// Keep the prompt small: only the most recent missions are retained.
const MAX_MISSIONS = 5;
const MAX_OBJECTIVE_LENGTH = 500;

/** @type {OpenAI|null} */
let llmClient = null;
/** @type {(() => Promise<void>)|null} */
let _onObjectiveChange = null;

// Circuit breaker state.
let _llmFailures = 0;
let _llmDisabledUntil = 0;
let _lastUnavailableLog = 0;

export { llmClient };

/**
 * Initializes the LLM client.
 *
 * @param {() => Promise<void>} onObjectiveChange - Triggered after a new mission.
 */
export function initLlmAgent(onObjectiveChange) {
    _onObjectiveChange = onObjectiveChange;

    if (!apiKey) {
        console.warn('[llmAgent] LITELLM_API_KEY missing in .env — LLM disabled');
        return;
    }

    llmClient = new OpenAI({
        baseURL,
        apiKey,
        timeout: LLM_TIMEOUT_MS,
        maxRetries: LLM_MAX_RETRIES,
    });
    console.log(`[llmAgent] init ok model=${MODEL} baseURL=${baseURL}`);
}

/**
 * Shared state read by intentionAgent.js.
 */
export const llmMemory = {
    /** @type {{text: string, from: string|null, ts: number}[]} */
    missions: [],
    /** @type {Map<number, number>}  */
    stackRules: new Map(),
    /** @type {number|null} */
    maxPickupReward: null,
    /** @type {Record<string, number>} */
    deliveryRewards: {},
    /** @type {object|null} */
    environmentSnapshot: null,
    /** @type {((text: string, to?: 'peer'|'all') => void) | null} */
    sendMessage: null,
    /** @type {((prevLen: number, newLen: number) => void) | null} */
    onMissionsChanged: null,
};

/**
 * Stores a chat mission for the next LLM deliberation.
 *
 * @param {string} text - Raw message text.
 * @param {string|null} [from] - Sender id, so a reply can be routed back to them.
 */
export async function setObjective(text, from = null) {
    const sanitized = String(text ?? '')
        .slice(0, MAX_OBJECTIVE_LENGTH)
        //Sanitize
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .trim();

    if (!sanitized) {
        console.log('[llmAgent] Empty message ignored');
        return;
    }

    const prevLen = llmMemory.missions.length;
    llmMemory.missions.push({ text: sanitized, from, ts: Date.now() });
    if (llmMemory.missions.length > MAX_MISSIONS) llmMemory.missions.shift();
    console.log(`[llmAgent] Mission stored (total ${llmMemory.missions.length}): "${sanitized}"`);
    notifyMissionsChanged(prevLen, llmMemory.missions.length);

    updateContext();
    if (_onObjectiveChange) await _onObjectiveChange();
}

/**
 * Refreshes the compact world snapshot sent to the model.
 */
export function updateContext() {
    llmMemory.environmentSnapshot = {
        me: {
            x: beliefs.me.x,
            y: beliefs.me.y,
            score: beliefs.me.score,
            carrying: beliefs.me.carrying.length,
        },
        freeParcels: [...beliefs.parcels.values()]
            .filter((p) => !p.carriedBy)
            .map((p) => ({ id: p.id, x: p.x, y: p.y, reward: p.reward })),
        deliveryTiles: beliefs.deliveryTiles,
    };
}

/**
 * Reward multiplier for the current carried-parcel count.
 *
 * @param {number} carryingCount
 * @returns {number}
 */
export function getStackMultiplier(carryingCount) {
    if (llmMemory.stackRules.size === 0) return 1;
    return llmMemory.stackRules.get(carryingCount) ?? 1;
}

/**
 * Best stack size that fits the current carry capacity.
 *
 * @param {number} [capacity=Infinity]
 * @returns {number|null}
 */
export function getBestStackTarget(capacity = Infinity) {
    let bestSize = null;
    let bestValue = -Infinity;
    for (const [size, mult] of llmMemory.stackRules) {
        if (size > capacity) continue;
        const v = size * mult;
        if (v > bestValue) {
            bestValue = v;
            bestSize = size;
        }
    }
    return bestSize;
}

/**
 * Fires the mission-queue hook when its size changes.
 *
 * @param {number} prevLen
 * @param {number} newLen
 */
export function notifyMissionsChanged(prevLen, newLen) {
    if (llmMemory.onMissionsChanged) {
        llmMemory.onMissionsChanged(prevLen, newLen);
    }
}

/**
 * Sends a plain chat request to the model.
 *
 * @param {object[]} messages - Messages in OpenAI format.
 * @param {{ temperature?: number }} [opts]
 * @returns {Promise<string>} Model response content.
 */
export async function callLLM(messages, { temperature = 0 } = {}) {
    if (!llmClient) throw new Error('LLM client not initialised (missing API key)');
    if (isLlmCircuitOpen()) {
        let llmCooldownSeconds = Math.max(0, Math.ceil((_llmDisabledUntil - Date.now()) / 1000));
        throw new Error(`LLM temporarily disabled (${llmCooldownSeconds}s cooldown remaining)`);
    }

    try {
        const response = await llmClient.chat.completions.create({
            model: MODEL,
            messages,
            temperature,
        });
        recordLlmSuccess();
        return response.choices?.[0]?.message?.content ?? '';
    } catch (err) {
        recordLlmFailure(err, 'LLM call');
        throw err;
    }
}

/** @returns {boolean} true while model calls are suppressed. */
function isLlmCircuitOpen() {
    if (_llmDisabledUntil === 0) return false;
    if (Date.now() < _llmDisabledUntil) return true;
    _llmDisabledUntil = 0;
    _llmFailures = 0;
    console.log('[llmAgent] LLM cooldown expired; trying LLM again');
    return false;
}

function recordLlmSuccess() {
    if (_llmFailures > 0) console.log('[llmAgent] LLM connection recovered');
    _llmFailures = 0;
    _llmDisabledUntil = 0;
}

/**
 * Records a failed model call and opens the circuit if needed.
 *
 * @param {unknown} err
 * @param {string} context - Short label for the log (e.g. "LLM call").
 */
function recordLlmFailure(err, context) {
    _llmFailures += 1;
    const msg = err?.message ?? String(err);

    if (_llmFailures >= LLM_FAILURE_THRESHOLD) {
        _llmDisabledUntil = Date.now() + LLM_COOLDOWN_MS;
        console.log(
            `[llmAgent] ${context} failed (${msg}); LLM unavailable for ` +
                `${Math.round(LLM_COOLDOWN_MS / 1000)}s`
        );
        return;
    }

    const now = Date.now();
    if (now - _lastUnavailableLog > 5000) {
        _lastUnavailableLog = now;
        console.log(
            `[llmAgent] ${context} failed (${msg}); ` +
                `retrying (${_llmFailures}/${LLM_FAILURE_THRESHOLD})`
        );
    }
}
