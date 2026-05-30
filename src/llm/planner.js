/**
 * The planner must:
 *   1. Receive the goal and environment state.
 *   2. Reason internally.
 *   3. Return a JSON plan containing a list of steps.
 */

import { callLLM } from './llmAgent.js';

const PLANNER_PROMPT = `
You are a planning module inside a Deliveroo.js AI agent.

The agent plays a parcel delivery game on a grid:
- The agent can move up, down, left, right (one step at a time)
- The agent can pick up parcels on its current tile
- The agent delivers parcels by moving to a delivery tile and calling putdown
- Parcels have a reward that decreases over time: act fast!

Your job:
1. Think step by step about what the agent needs to do (Chain-of-Thought)
2. Produce a short and concrete plan

Return ONLY this JSON, no markdown, no extra text:
{
  "steps": [
    "step 1",
    "step 2"
  ]
}`.trim();



/**
 * Creates a natural-language plan for the given objective.
 *
 * Sends the objective and the current environment snapshot to the LLM.
 * If the model output is not valid, a simple fallback plan is returned.
 *
 * @param {string} objective - Objective written in natural language.
 * @param {object} environmentSnapshot - Current environment state.
 * @returns {Promise<string[]>} List of plan steps.
 */
export async function createPlan(objective, environmentSnapshot) {
	const messages = [
		{ role: 'system', content: PLANNER_PROMPT },
		{ role: 'user', content:
			`Objective: ${objective}\n\n` +
			`Current environment: \n${JSON.stringify(environmentSnapshot, null, 2)}`
		},
	];

	console.log('[planner] Calling the LLM to create a plan...');
	const raw = await callLLM(messages, { temperature: 0 });
	console.log('[planner] Raw output:\n', raw, '\n');

	const plan = parsePlan(raw);

	if (!plan || plan.length === 0) {
		console.log('[planner] Invalid plan, using fallback.');
		return [`Achieve the objective: ${objective}`];
	}

	return plan;
}

// Plan parsing

/**
 * Extracts the JSON plan from the model output.
 *
 * Searches for a JSON object containing the steps field.
 *
 * @param {string} text - Raw model output.
 * @returns {string[]|null} List of steps, or null if parsing fails.
 */
function parsePlan(text) {
    // Find JSON
    const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
    if (!jsonMatch) return null;

    // Remove markdown syntax like ```json
    const cleaned = jsonMatch[0]
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    try {
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
            return parsed.steps;
        }
        return null;
    } catch {
        return null;
    }
}