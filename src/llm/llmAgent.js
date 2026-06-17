/**
 * llmAgent.js
 *
 * Infrastructure for the LLM-driven agent (agent B). Three responsibilities:
 *   1. Own the connection to the LLM server (OpenAI-compatible LiteLLM gateway).
 *   2. Hold the LLM memory: the operator objective, hard constraints, the queue
 *      of special missions received over the Deliveroo chat, the persistent
 *      strategy rules the model installs (level-2 missions), and the latest
 *      environment snapshot.
 *   3. Expose the low-level model call (`callLLM`) with a circuit breaker so a
 *      flaky model never blocks the agent — the BDI heuristic keeps playing
 *      meanwhile.
 *
 * The per-tick deliberation (reading and acting on missions, choosing the next
 * intention) lives in intentionAgent.js; this module only stores state and talks
 * to the model.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { beliefs } from '../bdi/beliefs.js';

// Config

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
const LLM_FAILURE_THRESHOLD = Number(process.env.LLM_FAILURE_THRESHOLD) || 3;
const LLM_COOLDOWN_MS = Number(process.env.LLM_COOLDOWN_MS) || 120000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 7000;
const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES) || 2;

// Keep the prompt small: only the most recent missions are retained.
const MAX_MISSIONS = 5;
const MAX_OBJECTIVE_LENGTH = 500;

/** @type {OpenAI|null} */
let llmClient = null;
/** @type {(() => Promise<void>)|null} */
let _onObjectiveChange = null;

// Circuit breaker state for the model call (callLLM).
let _llmFailures = 0;
let _llmDisabledUntil = 0;
let _lastUnavailableLog = 0;

export { llmClient };

/**
 * Initialises the LLM client. Must be called once, only by the LLM agent
 * (agent B / single-agent USE_LLM). Agent A never calls this, so it keeps the
 * LLM modules effectively unused.
 *
 * @param {() => Promise<void>} onObjectiveChange - Invoked after a new mission or
 *   objective arrives so the BDI loop can re-deliberate immediately.
 */
export function initLlmAgent(onObjectiveChange) {
    _onObjectiveChange = onObjectiveChange;

    if (!apiKey) {
        console.warn(
            '[llmAgent] LITELLM_API_KEY missing in .env — LLM disabled, heuristic fallback only'
        );
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

// LLM memory

/**
 * Persistent strategy rules the model installs while interpreting level-2
 * special missions. Unlike a one-off action, a rule stays active for the rest
 * of the match and reshapes ordinary pick-up / delivery behaviour. The
 * intention agent reads these every tick when building an intention.
 *
 * @typedef {Object} MissionRules
 * @property {number|null} deliverStackSize - Deliver exactly this many parcels
 *   per drop (e.g. "deliver stacks of exactly 3"). null = no constraint.
 * @property {Record<string, number>} deliveryTileMultipliers - Per delivery-tile
 *   reward multiplier keyed `"x,y"`. A value <= 0 marks a tile that scores
 *   nothing, so we never deliver there; > 1 marks a bonus tile to prefer.
 * @property {number|null} maxPickupReward - Never pick up a parcel whose reward
 *   exceeds this (e.g. "parcels with score > 10 give no reward"). null = no cap.
 * @property {{x: number, y: number}[]} avoidTiles - Tiles to never traverse
 *   (e.g. "do not go through (x,y)"); also blacklisted for pathfinding.
 */

/**
 * Memory shared between the infrastructure here and the intention agent.
 *
 * - objective: standing operator intent in natural language (replaced wholesale).
 * - constraints: hard rules that must never be violated (accumulated, free text).
 * - missions: special missions received over the chat, stored verbatim with the
 *   id of the sender so an answer can be routed back. The LLM reads them, decides
 *   whether each is worth doing, acts, and clears them.
 * - rules: persistent level-2 strategy modifiers (see MissionRules).
 * - environmentSnapshot: latest sensed world state (set by updateContext).
 * - sendMessage: wired by the entrypoint; sends a chat message to the peer or
 *   broadcasts. null in contexts with no chat channel.
 */
export const llmMemory = {
    /** @type {string|null} */
    objective: null,
    /** @type {string[]} */
    constraints: [],
    /** @type {{text: string, from: string|null, ts: number}[]} */
    missions: [],
    /** @type {MissionRules} */
    rules: {
        deliverStackSize: null,
        deliveryTileMultipliers: {},
        maxPickupReward: null,
        avoidTiles: [],
    },
    /** @type {object|null} */
    environmentSnapshot: null,
    /** @type {((text: string, to?: 'peer'|'all') => void) | null} */
    sendMessage: null,
};

/**
 * Records a special mission for the LLM to interpret on its next deliberation.
 *
 * Everything that arrives over the chat is stored verbatim — classification
 * (mission vs. constraint vs. junk) and all decisions are the model's job, done
 * with its tools in intentionAgent.js. We only sanitise and cap the queue here.
 *
 * @param {string} text - Raw message text.
 * @param {string|null} [from] - Sender id, so a reply can be routed back to them.
 */
export async function setObjective(text, from = null) {
    const sanitized = String(text ?? '')
        .slice(0, MAX_OBJECTIVE_LENGTH)
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .trim();

    if (!sanitized) {
        console.log('[llmAgent] Empty message ignored');
        return;
    }

    llmMemory.missions.push({ text: sanitized, from, ts: Date.now() });
    if (llmMemory.missions.length > MAX_MISSIONS) llmMemory.missions.shift();
    console.log(`[llmAgent] Mission stored (total ${llmMemory.missions.length}): "${sanitized}"`);

    updateContext();
    if (_onObjectiveChange) await _onObjectiveChange();
}

/**
 * Refreshes the environment snapshot from the current beliefs. Called on every
 * sensing tick so the model always reasons over up-to-date state.
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

// Model call + circuit breaker

/**
 * Sends a plain chat request to the model (no tools). Used by the planner.
 * Throws when the client is missing, the breaker is open, or the call fails, so
 * the caller can fall back to its heuristic. Failures feed the circuit breaker.
 *
 * @param {object[]} messages - Messages in OpenAI format.
 * @param {{ temperature?: number }} [opts]
 * @returns {Promise<string>} Model response content.
 */
export async function callLLM(messages, { temperature = 0 } = {}) {
    if (!llmClient) throw new Error('LLM client not initialised (missing API key)');
    if (isLlmCircuitOpen()) {
        throw new Error(`LLM temporarily disabled (${llmCooldownSeconds()}s cooldown remaining)`);
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

/** @returns {boolean} true while the breaker is open (model calls suppressed). */
function isLlmCircuitOpen() {
    if (_llmDisabledUntil === 0) return false;
    if (Date.now() < _llmDisabledUntil) return true;
    _llmDisabledUntil = 0;
    _llmFailures = 0;
    console.log('[llmAgent] LLM cooldown expired; trying LLM again');
    return false;
}

function llmCooldownSeconds() {
    return Math.max(0, Math.ceil((_llmDisabledUntil - Date.now()) / 1000));
}

function recordLlmSuccess() {
    if (_llmFailures > 0) console.log('[llmAgent] LLM connection recovered');
    _llmFailures = 0;
    _llmDisabledUntil = 0;
}

/**
 * Records a failed model call. After LLM_FAILURE_THRESHOLD consecutive failures
 * the breaker opens for LLM_COOLDOWN_MS, during which callers use their heuristic.
 *
 * @param {unknown} err
 * @param {string} context - Short label for the log (e.g. "Zone assignment").
 */
function recordLlmFailure(err, context) {
    _llmFailures += 1;
    const msg = err?.message ?? String(err);

    if (_llmFailures >= LLM_FAILURE_THRESHOLD) {
        _llmDisabledUntil = Date.now() + LLM_COOLDOWN_MS;
        console.log(
            `[llmAgent] ${context} failed (${msg}); LLM unavailable, ` +
                `heuristic fallback for ${Math.round(LLM_COOLDOWN_MS / 1000)}s`
        );
        return;
    }

    const now = Date.now();
    if (now - _lastUnavailableLog > 5000) {
        _lastUnavailableLog = now;
        console.log(
            `[llmAgent] ${context} failed (${msg}); ` +
                `heuristic fallback active (${_llmFailures}/${LLM_FAILURE_THRESHOLD})`
        );
    }
}
