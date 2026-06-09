/**
 * This module must:
 *   1. Connect to the LLM server.
 *   2. Store the LLM memory, including the goal and environment state.
 *   3. Receive the goal from the Deliveroo chat.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { beliefs } from '../bdi/beliefs.js';
import { revise } from '../bdi/intentionRevision.js';

// Config

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

if (!apiKey) {
    console.error('[llmAgent] LITELLM_API_KEY mancante nel .env');
    process.exit(1);
}

export const llmClient = new OpenAI({ baseURL, apiKey });

// LLM memory

/**
 * Memory used by the LLM agent.
 *
 * Contains the information needed before planning:
 *   - objective: task received in natural language
 *   - environmentSnapshot: current game state
 */
export const llmMemory = {
    objective: null, // es. "Pick up the nearest parcel and deliver it"
    environmentSnapshot: null, // posizione, parcels visibili, delivery tiles
};

// Context update

/**
 * Updates the environment snapshot in the LLM memory.
 *
 * Called by index.js on each sensing event, so the LLM always has
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
 * Called by index.js when a message arrives through socket.onMsg.
 *
 * @param {string} objectiveText - Example: "Pick up the nearest parcel and deliver it".
 */
export async function setObjective(objectiveText) {
    console.log(`[llmAgent] New objective: "${objectiveText}"`);

    // Save the objective in memory so the intention agent can read it.
    llmMemory.objective = objectiveText;

    // Update the environment snapshot
    updateContext();

    console.log('[llmAgent] Updated memory:', JSON.stringify(llmMemory, null, 2));

    // Force a re-deliberation so the new objective is taken into account.
    await revise(true);
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
