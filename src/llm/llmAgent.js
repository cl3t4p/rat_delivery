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

let llmClient = null;
let _onObjectiveChange = null;

/**
 * Initialises the LLM agent.
 *
 * Must be called once from index_b.js before any LLM function is used.
 * Agent A must NOT call this — it keeps the LLM modules unloaded entirely.
 *
 * @param {() => Promise<void>} onObjectiveChange - Called after a new objective
 *   or constraint is received, so the BDI loop can re-deliberate immediately.
 */
export function initLlmAgent(onObjectiveChange) {
    if (!apiKey) {
        console.error('[llmAgent] LITELLM_API_KEY missing in .env');
        process.exit(1);
    }
    llmClient = new OpenAI({ baseURL, apiKey });
    _onObjectiveChange = onObjectiveChange;
    console.log('[llmAgent] init ok');
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
    const matches = [...text.matchAll(/(\d+)[,\s]+(\d+)/g)];
    return matches.map((m) => ({ x: parseInt(m[1]), y: parseInt(m[2]) }));
}

// Context update

/**
 * Updates the environment snapshot in the LLM memory.
 *
 * Called by index_b.js on each sensing event, so the LLM always has
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
 * Called by index_b.js when a message arrives via onFallbackMsg.
 *
 * @param {string} objectiveText - Example: "Pick up the nearest parcel and deliver it".
 */
export async function setObjective(objectiveText) {
    console.log(`[llmAgent] Message received: "${objectiveText}"`);

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
    const response = await llmClient.chat.completions.create({
        model: MODEL,
        messages,
        temperature,
    });
    return response.choices?.[0]?.message?.content ?? '';
}

/**
 * Calls the LLM with aggregated zone data and returns a zone assignment
 * for each agent. Used by the coordinator zone-assignment loop.
 *
 * Zones: topLeft, topRight, bottomLeft, bottomRight.
 * Each zone includes totalReward, freeParcels, spawnerCount, and agent-specific best scores computed with delivery-aware scoring.
 *
 * @param {object} zoneStats - { topLeft, topRight, bottomLeft, bottomRight }
 *   each with { totalReward: number, freeParcels: number, spawnerCount: number }
 * @param {{ x: number, y: number }} posA - Current position of agent A.
 * @param {{ x: number, y: number }} posB - Current position of agent B.
 * @returns {Promise<{ assignA: string, assignB: string } | null>}
 *   Zone names for each agent, or null on failure.
 */
export async function callZoneAssignment(zoneStats, posA, posB) {
    const constraintBlock = llmMemory.constraints.length > 0
        ? [
            'Constraints (NEVER violate these):',
            ...llmMemory.constraints.map((c) => `- ${c}`),
            '',
        ]
    : [];

    const prompt = [
        'You assign two delivery agents to map zones to maximise total delivered value.',
        '',
        ...constraintBlock,
        'Zone scores already include parcel reward, distance to delivery, distance from the agent, and decay.',
        'Use bestScoreForA and bestScoreForB as the main decision signal.',
        'Do not assign zones using totalReward alone: totalReward is only context.',
        '',
        'Zones (totalReward / freeParcels / spawners / bestScoreForA / bestScoreForB):',
        ...Object.entries(zoneStats).map(
            ([name, s]) => `  ${name}: reward=${s.totalReward} parcels=${s.freeParcels} spawners=${s.spawnerCount} scoreA=${(s.bestScoreForA ?? 0).toFixed(1)} scoreB=${(s.bestScoreForB ?? 0).toFixed(1)}`
        ),
        '',
        `Agent A is at (${posA.x},${posA.y}).`,
        `Agent B is at (${posB.x},${posB.y}).`,
        '',
        'Reply with ONLY a JSON object, no prose, no markdown:',
        '{"assignA":"<zoneName>","assignB":"<zoneName>"}',
        'Zone names: topLeft, topRight, bottomLeft, bottomRight.',
    ].join('\n');

    try {
        const raw = await callLLM([{ role: 'user', content: prompt }]);
        const clean = raw.replace(/```[a-z]*|```/gi, '').trim();
        const parsed = JSON.parse(clean);
        const valid = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
        if (!valid.includes(parsed.assignA) || !valid.includes(parsed.assignB)) {
            console.log('[llmAgent] Zone assignment returned invalid zone names:', parsed);
            return null;
        }
        console.log(`[llmAgent] Zone assignment: A→${parsed.assignA} B→${parsed.assignB}`);
        return parsed;
    } catch (err) {
        console.log(`[llmAgent] Zone assignment failed (${err.message})`);
        return null;
    }
}

