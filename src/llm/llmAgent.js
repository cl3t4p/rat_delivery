/**
 * This module must:
 *   1. Connect to the LLM server.
 *   2. Store the LLM memory, including the goal and environment state.
 *   3. Receive the goal from the Deliveroo chat.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { beliefs, blacklistCell } from '../bdi/beliefs.js';

// Config

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
const LLM_FAILURE_THRESHOLD = Number(process.env.LLM_FAILURE_THRESHOLD) || 3;
const LLM_COOLDOWN_MS = Number(process.env.LLM_COOLDOWN_MS) || 120000;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 5000;
const LLM_MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES) || 1;

let llmClient = null;
let _onObjectiveChange = null;
let _llmFailures = 0;
let _llmDisabledUntil = 0;
let _lastUnavailableLog = 0;

/**
 * Initialises the LLM agent.
 *
 * Must be called once from multiagent_b.js before any LLM function is used.
 * Agent A must NOT call this — it keeps the LLM modules unloaded entirely.
 *
 * @param {() => Promise<void>} onObjectiveChange - Called after a new objective
 *   or constraint is received, so the BDI loop can re-deliberate immediately.
 */
export function initLlmAgent(onObjectiveChange) {
    if (!apiKey) {
        console.warn(
            '[llmAgent] LITELLM_API_KEY missing in .env — LLM disabled, using heuristic fallback'
        );
        _onObjectiveChange = onObjectiveChange;
        return;
    }
    llmClient = new OpenAI({
        baseURL,
        apiKey,
        timeout: LLM_TIMEOUT_MS,
        maxRetries: LLM_MAX_RETRIES,
    });
    _onObjectiveChange = onObjectiveChange;
    console.log(`[llmAgent] init ok model=${MODEL} baseURL=${baseURL}`);
}

export { llmClient };

// LLM memory

/**
 * Memory used by the LLM agent.
 *
 * Contains the information needed before planning:
 *   - objective: current strategy in natural language; replaced on each new strategic message.
 *   - constraints: rules that must never be violated; accumulated over time and never reset.
 *   - environmentSnapshot: latest game state; updated on every sensing tick.
 */
export const llmMemory = {
    objective: null, // e.g. "Focus on the top-left area"
    constraints: [],
    environmentSnapshot: null, // position, visible parcels, delivery tiles
};

/**
 * Keywords that identify a constraint message.
 * If any keyword is found in the incoming text, the message is treated as a
 * constraint rather than a strategy.
 */
const CONSTRAINT_KEYWORDS = ['avoid', 'do not enter', 'ignore', 'block', 'stay away'];

/**
 * Returns true if the message text describes a constraint.
 */
function isConstraint(text) {
    const lower = text.toLowerCase();
    return CONSTRAINT_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Extracts (x, y) cell coordinates from a message text.
 */
function extractCells(text) {
    const matches = [...text.matchAll(/\b(\d+)\s*,\s*(\d+)\b/g)];
    return matches.map((m) => ({ x: parseInt(m[1]), y: parseInt(m[2]) }));
}

// Context update

/**
 * Updates the environment snapshot in the LLM memory.
 *
 * Called by multiagent_b.js on each sensing event, so the LLM always has
 * updated information before planning.
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

// New objective

/**
 * Receives a new objective in natural language from the Deliveroo chat
 * and saves it in the LLM memory. The objective is then used as extra
 * context by the LLM intention agent on its next deliberation.
 *
 * Called by multiagent_b.js when a message arrives via onFallbackMsg.
 *
 * @param {string} objectiveText - Example: "Pick up the nearest parcel and deliver it".
 */
const MAX_OBJECTIVE_LENGTH = 500;

export async function setObjective(objectiveText) {
    // Sanitize: cap length and strip control characters that could escape the prompt context.
    const sanitized = String(objectiveText ?? '')
        .slice(0, MAX_OBJECTIVE_LENGTH)
        .replace(/[\x00-\x1F\x7F]/g, ' ')
        .trim();

    if (!sanitized) {
        console.log('[llmAgent] Empty or invalid objective; ignoring');
        return;
    }

    console.log(`[llmAgent] Message received: "${sanitized}"`);
    objectiveText = sanitized;

    if (isConstraint(objectiveText)) {
        llmMemory.constraints.push(objectiveText);
        console.log(`[llmAgent] Constraint added. Total: ${llmMemory.constraints.length}`);

        const cells = extractCells(objectiveText);
        for (const cell of cells) {
            blacklistCell(cell.x, cell.y);
            console.log(`[llmAgent] Blacklisted cell (${cell.x},${cell.y})`);
        }
    } else {
        llmMemory.objective = objectiveText;
        console.log(`[llmAgent] New strategy: "${objectiveText}"`);
    }

    updateContext();
    if (_onObjectiveChange) await _onObjectiveChange();
}

// Model call

/**
 * Sends a plain chat request to the LLM (no tools).
 *
 * Kept as a generic helper for free-text prompts. The intention agent uses
 * the shared `llmClient` directly so it can pass tool definitions.
 *
 * @param {object[]} messages - Messages in OpenAI format.
 * @param {number} temperature - 0 for deterministic output, higher values for more variation.
 * @returns {Promise<string>} Model response as a string.
 */
export async function callLLM(messages, { temperature = 0 } = {}) {
    if (!llmClient) throw new Error('LLM client not initialised (missing API key)');
    if (isLlmCircuitOpen()) {
        throw new Error(`LLM temporarily disabled (${llmCooldownSeconds()}s cooldown remaining)`);
    }

    const response = await llmClient.chat.completions.create({
        model: MODEL,
        messages,
        temperature,
    });
    recordLlmSuccess();
    return response.choices?.[0]?.message?.content ?? '';
}

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

function recordLlmFailure(err, context) {
    _llmFailures += 1;
    const msg = err?.message ?? String(err);

    if (_llmFailures >= LLM_FAILURE_THRESHOLD) {
        _llmDisabledUntil = Date.now() + LLM_COOLDOWN_MS;
        console.log(
            `[llmAgent] ${context} failed (${msg}); LLM unavailable, ` +
                `using heuristic fallback for ${Math.round(LLM_COOLDOWN_MS / 1000)}s`
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

// Zone diagonally opposite to each zone, used as a last-resort fallback.
const OPPOSITE_ZONE = {
    topLeft: 'bottomRight',
    topRight: 'bottomLeft',
    bottomLeft: 'topRight',
    bottomRight: 'topLeft',
};

/**
 * Picks the best zone for one agent among the zones not yet taken.
 * Criteria: agent-specific score, then spawner count, then the zone
 * diagonally opposite to the contested one. Never returns `excluded`.
 *
 * @param {object} zoneStats - Stats for all four zones.
 * @param {'bestScoreForSelf'|'bestScoreForPeer'} scoreKey - Which agent's score to use.
 * @param {string} excluded - The contested zone to avoid.
 * @returns {string} A zone name different from `excluded`.
 */
function pickBestRemainingZone(zoneStats, scoreKey, excluded) {
    const candidates = Object.entries(zoneStats)
        .filter(([name]) => name !== excluded)
        .sort(
            ([, s1], [, s2]) =>
                (s2[scoreKey] ?? 0) - (s1[scoreKey] ?? 0) ||
                (s2.spawnerCount ?? 0) - (s1.spawnerCount ?? 0)
        );
    return candidates[0]?.[0] ?? OPPOSITE_ZONE[excluded];
}

/**
 * Calls the LLM with aggregated zone data and returns a zone assignment
 * for each agent. Used by the coordinator zone-assignment loop.
 *
 * Zones: topLeft, topRight, bottomLeft, bottomRight.
 * Each zone includes totalReward, freeParcels, spawnerCount, and agent-specific
 * best scores computed with delivery-aware scoring.
 *
 * @param {object} zoneStats - { topLeft, topRight, bottomLeft, bottomRight }
 *   each with { totalReward, freeParcels, spawnerCount, bestScoreForSelf, bestScoreForPeer }
 * @param {string} selfId  - Actual ID of the calling agent (coordinator).
 * @param {{ x: number, y: number }} selfPos - Position of the calling agent.
 * @param {string} peerId  - Actual ID of the peer agent.
 * @param {{ x: number, y: number }} peerPos - Position of the peer agent.
 * @param {{ selfRate?: number|null, peerRate?: number|null, isImbalanced?: boolean, currentAssignment?: Record<string,string>|null }} [perf]
 *   Scoring-rate context. selfRate/peerRate are points/s over the last interval;
 *   isImbalanced flags that consecutive underperformance was detected;
 *   currentAssignment is the last assignment (change only if there is clear benefit).
 * @returns {Promise<Record<string, string> | null>}
 *   Object keyed by actual agent IDs (e.g. { "f0a53a": "bottomRight", "271c9d": "topLeft" }),
 *   or null on failure.
 */
export async function callZoneAssignment(
    zoneStats,
    selfId,
    selfPos,
    peerId,
    peerPos,
    { selfRate = null, peerRate = null, isImbalanced = false, currentAssignment = null } = {}
) {
    if (!llmClient) return null;
    if (isLlmCircuitOpen()) {
        const now = Date.now();
        if (now - _lastUnavailableLog > 10000) {
            _lastUnavailableLog = now;
            console.log(
                `[llmAgent] LLM cooldown active (${llmCooldownSeconds()}s left); ` +
                    'using heuristic zone assignment'
            );
        }
        return null;
    }

    const constraintBlock =
        llmMemory.constraints.length > 0
            ? [
                  'Constraints (NEVER violate these):',
                  ...llmMemory.constraints.map((c) => `- ${c}`),
                  '',
              ]
            : [];

    const rateBlock =
        selfRate !== null && peerRate !== null
            ? [
                  'Scoring rates over the last interval (points/s):',
                  `  ${selfId}: ${selfRate.toFixed(2)} pts/s`,
                  `  ${peerId}: ${peerRate.toFixed(2)} pts/s`,
                  '',
              ]
            : [];

    const currentBlock = currentAssignment
        ? [
              'Current zone assignment — KEEP IT unless the benefit of changing is clear (> 10 pts difference in agent-specific scores):',
              `  ${selfId}: ${currentAssignment[selfId] ?? 'unassigned'}`,
              `  ${peerId}: ${currentAssignment[peerId] ?? 'unassigned'}`,
              'Frequent zone changes waste movement: only reassign when it clearly improves total throughput.',
              '',
          ]
        : [];

    const rebalanceBlock = isImbalanced
        ? [
              'REBALANCE REQUIRED: scoring rates are significantly unequal across multiple consecutive intervals.',
              'The underperforming agent needs access to spawner-rich tiles.',
              'Consider asymmetric zone boundaries — do not default to symmetric quadrants.',
              'Assign the zone with more spawners (or higher agent-specific score) to the slower agent.',
              '',
          ]
        : [];

    // Build a concise description of where delivery tiles cluster so the LLM
    // can prefer zones with shorter return paths to delivery.
    const deliveryTiles = beliefs.deliveryTiles;
    const deliveryBlock =
        deliveryTiles.length > 0
            ? (() => {
                  const cx = Math.round(
                      deliveryTiles.reduce((s, t) => s + t.x, 0) / deliveryTiles.length
                  );
                  const cy = Math.round(
                      deliveryTiles.reduce((s, t) => s + t.y, 0) / deliveryTiles.length
                  );
                  return [
                      `DELIVERY TILES: all ${deliveryTiles.length} delivery tiles are clustered near (${cx},${cy}).`,
                      'Both agents must travel to this cluster to score. Zones closer to the delivery cluster',
                      'allow shorter return trips, which means less decay and more deliveries per minute.',
                      'Factor delivery-tile proximity into zone selection, especially for agents that are currently carrying.',
                      '',
                  ];
              })()
            : [];

    const prompt = [
        'You assign two delivery agents to map zones to maximise total delivered value.',
        '',
        ...constraintBlock,
        ...currentBlock,
        ...deliveryBlock,
        ...rateBlock,
        ...rebalanceBlock,
        'Zone scores already include parcel reward, distance to delivery, distance from the agent, and decay.',
        'Use bestScoreForSelf and bestScoreForPeer as the main decision signal.',
        'Do not assign zones using totalReward alone: totalReward is only context.',
        '',
        'Zones (totalReward / freeParcels / spawners / bestScoreForSelf / bestScoreForPeer):',
        ...Object.entries(zoneStats).map(
            ([name, s]) =>
                `  ${name}: reward=${s.totalReward} parcels=${s.freeParcels} spawners=${s.spawnerCount} scoreSelf=${(s.bestScoreForSelf ?? 0).toFixed(1)} scorePeer=${(s.bestScoreForPeer ?? 0).toFixed(1)}`
        ),
        '',
        `Agent ${selfId} is at (${selfPos.x},${selfPos.y}).`,
        `Agent ${peerId} is at (${peerPos.x},${peerPos.y}).`,
        '',
        'Reply with ONLY a JSON object, no prose, no markdown:',
        `{"${selfId}":"<zoneName>","${peerId}":"<zoneName>"}`,
        'Zone names: topLeft, topRight, bottomLeft, bottomRight.',
        `The two values for "${selfId}" and "${peerId}" MUST be two DIFFERENT zones.`,
    ].join('\n');

    try {
        const raw = await callLLM([{ role: 'user', content: prompt }]);
        const clean = raw.replace(/```[a-z]*|```/gi, '').trim();
        const parsed = JSON.parse(clean);
        const valid = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

        if (!valid.includes(parsed[selfId]) || !valid.includes(parsed[peerId])) {
            console.log('[llmAgent] Zone assignment returned invalid zone names:', parsed);
            return null;
        }

        // Enforce distinct zones: agent with higher score in the contested zone
        // keeps it; the other moves to its best remaining zone.
        if (parsed[selfId] === parsed[peerId]) {
            const contested = parsed[selfId];
            const stats = zoneStats[contested] ?? {};
            const selfKeeps = (stats.bestScoreForSelf ?? 0) >= (stats.bestScoreForPeer ?? 0);
            if (selfKeeps) {
                parsed[peerId] = pickBestRemainingZone(zoneStats, 'bestScoreForPeer', contested);
            } else {
                parsed[selfId] = pickBestRemainingZone(zoneStats, 'bestScoreForSelf', contested);
            }
            console.log(
                `[llmAgent] Same zone for both (${contested}) → corrected: ` +
                    `${selfId}→${parsed[selfId]} ${peerId}→${parsed[peerId]}`
            );
        }

        console.log(
            `[llmAgent] Zone assignment: ${selfId}→${parsed[selfId]} ${peerId}→${parsed[peerId]}`
        );
        return parsed;
    } catch (err) {
        recordLlmFailure(err, 'Zone assignment');
        return null;
    }
}
