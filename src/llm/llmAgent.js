/**
 * Deve:
 *    1. Connettersi al server LLM
 *    2. Mantenere la LLM memory (obiettivo + stato dell'ambiente)
 *    3. Ricevere l'obiettivo dalla chat di Deliveroo
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { beliefs } from '../bdi/beliefs.js';
import { createPlan } from './planner.js';

// ── CONFIGURAZIONE LLM ──────────────────────────────────────────────────
// server unitn + OpenAI-compatible client

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const MODEL = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

if (!apiKey) {
    console.error('[llmAgent] LITELLM_API_KEY mancante nel .env');
    process.exit(1);
}

export const llmClient = new OpenAI({ baseURL, apiKey });

// ── LLM MEMORY ───────────────────────────────────────────────────────────
/**
 * 'Taccuino' dell'agente LLM 
 * Contiene tutto quello che l'LLM deve sapere prima di pianificare:
 *      - objective: cosa gli è stato chiesto in linguaggio naturale
 *      - environmentSnapshot: lo stato del gioco al momento attuale
 */ 

export const llmMemory = {
    objective: null,            // es. "Pick up the nearest parcel and deliver it"
    environmentSnapshot: null,  // posizione, parcels visibili, delivery tiles
}

// ── AGGIORNAMENTO CONTESTO ───────────────────────────────────────────────
/**
 * Aggiorna lo snapshot dell'ambiente nella LLM memory.
 * Chiamata ad ogni sensing da index.js, così l'LLM ha sempre informazioni
 * aggiornate sull'ambiente prima di pianificare
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
            .filter(p => !p.carriedBy)
            .map(p => ({ id: p.id, x: p.x, y: p.y, reward: p.reward })),
        deliveryTiles: beliefs.deliveryTiles,
    };
}

// ── NUOVO OBIETTIVO ──────────────────────────────────────────────────────
/**
 * Riceve un nuovo obiettivo in linguaggio naturale dalla chat di Deliveroo
 * e lo salva nella LLM memory.
 * Chiamata da index.js quando arriva un messaggio via socket.onMsg
 * 
 * @param {string} objectiveText    es. "Pick up the nearest parcel and deliver it"
 */

export async function setObjective(objectiveText) {
    console.log(`[llmAgent] Nuovo obiettivo: "${objectiveText}"`);

    // salva l'obiettivo in memoria
    llmMemory.objective = objectiveText;

    // aggiorna subito lo snapshot dell'ambiente
    updateContext();

    console.log('[llmAgent] Memory aggiornata:', JSON.stringify(llmMemory, null, 2));

    // chiama il planner
    const plan = await createPlan(llmMemory.objective, llmMemory.environmentSnapshot);
    console.log('[llmAgent] Piano generato:', plan);
}

// ── CHIAMATA AL MODELLO ────────────────────────────────────────────────────
/**
 * Funzione riusabile per chiamare il modello LLM.
 * Usata da planner.js, replanner.js e dal loop di esecuzione.
 * 
 * @param {object[]} messages       array di messaggi nel formato OpenAI
 * @param {number} temperature      0 = deterministico, >0 = più creativo
 * @returns {Promise<string>}       risposta del modello come stringa
 */

export async function callLLM(messages, { temperature = 0 } = {}) {
    const response = await llmClient.chat.completions.create({
        model: MODEL,
        messages,
        temperature,
    });
    return response.choices?.[0]?.message?.content ?? '';
}