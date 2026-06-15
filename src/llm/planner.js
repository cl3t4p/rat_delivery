/**
 * Il planner deve:
 * 		1. ricevere l'obiettivo + stato ambiente
 * 		2. ragionare con Chain-of-Tought
 * 		3. restituire un piano JSON con una lista di step
 */

import { callLLM } from './llmAgent.js';

// ── PROMPT DEL PLANNER ───────────────────────────────────────────────────
/**
 * Il prompt definisce il comportamento del planner.
 * Tecnica: Chain-of-Tought -> il modello ragiona prima di produrre il piano.
 * Il piano deve essere JSON puro così il programm può parsarlo facilmente.
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

// ── FUNZIONE PRINCIPALE ───────────────────────────────────────────────────
/**
 * Crea un piano in linguaggio naturale per raggiungere l'obiettivo.
 * 
 * @param {string} objective				obiettivo in linguaggio naturale
 * @param {object} environmentSnapshot		snapshot corrente dei beliefs
 * @returns {Promise<string[]>}				array di step del piano
 */

export async function createPlan(objective, environmentSnapshot) {
	const messages = [
		{ role: 'system', content: PLANNER_PROMPT },
		{ role: 'user', content:
			`Objective: ${objective}\n\n` +
			`Current environment: \n${JSON.stringify(environmentSnapshot, null, 2)}`
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

// ── PARSING DEL PIANO ────────────────────────────────────────────────────
/**
 * Estrae il piano JSON dall'output del modello.
 * Il modello può includere testo di Chain-of-Thought prima del JSON.
 * quindi cerchiamo il blocco JSON dentro la risposta.
 * 
 * @param {string} text 			output grezzo del modello
 * @returns {string[]|null} 		array di step o null se non parsabile
 */

function parsePlan(text) {
	// cerca il blocco JSON nell'output (dopo il CoT)
	const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
	if (!jsonMatch) return null;

	// rimuove eventuali backtick markdown tipo ```json
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