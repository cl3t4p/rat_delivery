/**
 * Simple LLM planner that returns natural-language steps.
 */

import { callLLM } from './llmAgent.js';

/**
 * System prompt for the planner.
 */

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
 * Creates a natural-language plan for an objective.
 *
 * @param {string} objective - Natural-language objective.
 * @param {object} environmentSnapshot - Current belief snapshot.
 * @returns {Promise<string[]>} Plan steps.
 */

export async function createPlan(objective, environmentSnapshot) {
    const messages = [
        { role: 'system', content: PLANNER_PROMPT },
        {
            role: 'user',
            content:
                `Objective: ${objective}\n\n` +
                `Current environment: \n${JSON.stringify(environmentSnapshot, null, 2)}`,
        },
    ];

    console.log('[planner] Calling LLM for plan...');
    const raw = await callLLM(messages, { temperature: 0 });
    console.log('[planner] Raw output:\n', raw, '\n');

    const plan = parsePlan(raw);

    if (!plan || plan.length === 0) {
        console.log('[planner] Invalid plan, using fallback.');
        return [`Achieve the objective: ${objective}`];
    }

    return plan;
}

/**
 * Extracts JSON plan steps from model output.
 *
 * @param {string} text - Raw model output.
 * @returns {string[]|null} Parsed steps or null.
 */

function parsePlan(text) {
    // Find the JSON block in the model output.
    const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
    if (!jsonMatch) return null;

    // Remove optional markdown fences.
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
