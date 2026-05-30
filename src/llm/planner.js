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
 * Creates a natural-language plan to achieve the objective.
 *
 * @param {string} objective - Natural-language objective.
 * @param {object} environmentSnapshot - Current beliefs snapshot.
 * @returns {Promise<string[]>} Array of plan steps.
 */
export async function createPlan(objective, environmentSnapshot) {
	const messages = [
		{ role: 'system', content: PLANNER_PROMPT },
		{ role: 'user', content:
			`Objective: ${objective}\n\n` +
			`Current environment: \n${JSON.stringify(environmentSnapshot, null, 2)}`
		},
	];

	console.log('[planner] Chiamata all\'LLM per il piano...');
	const raw = await callLLM(messages, { temperature: 0 });
	console.log('[planner] Output grezzo:\n', raw, '\n');

	const plan = parsePlan(raw);

	if (!plan || plan.length === 0) {
		console.log('[planner] Piano non valido, uso fallback.');
		return [`Achieve the objective: ${objective}`];
	}

	return plan;
}

// Plan parsing.

/**
 * Extracts the JSON plan from the model output.
 * The model may include extra text before the JSON, so this function
 * searches for the JSON block inside the response.
 *
 * @param {string} text - Raw model output.
 * @returns {string[]|null} Array of steps, or null if parsing fails.
 */
function parsePlan(text) {
	// find json
	const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
	if (!jsonMatch) return null;

	// clean markdown syntax like ```json
	const cleaned = jsonMatch[0]
		.replace(/```json/gi, '')
		.replace(/```/g, '')
		.trim();

	try {
		const parsed = JSON.parse(cleaned);
		if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
			return parsed.steps;
		}
		return null;
	} catch {
		return null;
	}
}