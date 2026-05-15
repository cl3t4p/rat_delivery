// Genera il problem.pddl dai beliefs e chiama il planner esterno

import { onlineSolver } from '@unitn-asa/pddl-client';
import { beliefs } from './beliefs.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Legge il domain.pddl dalla stessa cartella di questo file
const __dirname = dirname(fileURLToPath(import.meta.url));
const domainFile = readFileSync(join(__dirname, 'domain.pddl'), 'utf8');

// ── FUNZIONI ──────────────────────────────────────────────────

/**
 * Genera un piano PDDL per raggiungere l'obiettivo dell'intention.
 * 
 * @param {import('../shared/types.js').Intention} intention
 * @returns {Promise<string[]>} array di mosse ('up'|'down'|'left'|'right') o [] se fallisce
 */
export async function planWithPDDL(intention) {
    // 1. costruisci il problem.pddl dai beliefs correnti
    const problem = buildProblem(intention);
    if (!problem) return [];

    // 2. chiama il solver online
    const plan = await onlineSolver(domainFile, problem);
    if (!plan) return [];

    // 3. traduci il piano in mosse
    return parsePlan(plan);
}

/** 
* buildProblem deve generare il problem.pddl. Un problem.pddl ha questa struttura:
* (define (problem nome)
*	(:domain deliveroo)
*   (:objects ...)   ; tutti gli oggetti coinvolti
*   (:init ...)      ; stato iniziale (cosa è vero adesso)
*   (:goal ...)      ; cosa vogliamo ottenere
* )
*/

function buildProblem(intention) {
	if (!intention.targetPos) return null;

	const me = beliefs.me;
	if (me.x === null || me.y === null) return null;

	// ── OBJECTS ─────────────────────────────────────────────
	// Raccogliamo tutti gli oggetti coinvolti:
	//		- l'agente stesso (me)
	// 		- tutte le tile walkable della mappa
	// 		- i parcels liberi visibili

	const agentName = 'me'; // l'agente si chiama semplicemente me

	// una tile per ogni casella walkable: nome formato "t_X_Y"
	// ogni tile walkable della mappa diventa un oggetto PDDL con nome tipo t_3_4
	const tileNames = [];
	for (const [key] of beliefs.grid) {
		const [x, y] = key.split(',').map(Number);
		tileNames.push(`t_${x}_${y}`);
	}

	// i parcels che stiamo portando + il parce target se è go_pick_up
	// ogni parcel (quelli che portiamo + il target) diventa un oggetto tipo p_abc12
	const parcelNames = [];
	for (const id of me.carrying) {
		parcelNames.push(`p_${id}`);
	}
	if (intention.type === 'go_pick_up' && intention.parcelId) {
		const pid = `p_${intention.parcelId}`;
		if (!parcelNames.includes(pid)) parcelNames.push(pid);
	}

	// ── INIT ────────────────────────────────────────────────
	// Elenchiamo tutti i fatti veri adesso
	const init = [];

	// l'agente esiste ed è il nostro
	init.push(`(agent ${agentName})`);
	init.push(`(me ${agentName})`);

	// posizione attuale dell'agente
	const myTile = `t_${Math.round(me.x)}_${Math.round(me.y)}`;
	init.push(`(at ${agentName} ${myTile})`);

	// tutte le tile walkable + quali sono delivery
	for (const [key, tile] of beliefs.grid) {
		const [x, y] = key.split(',').map(Number);
		const tName = `t_${x}_${y}`;
		init.push(`(tile ${tName})`);
		if (tile.delivery) init.push(`(delivery ${tName})`);
	}

	// adiacenza tra tile (right/left/up/down)
	for (const [key] of beliefs.grid) {
		const [x, y] = key.split(',').map(Number);
		const from = `t_${x}_${y}`;

		if (beliefs.grid.has(`${x+1},${y}`)) init.push(`(right ${from} t_${x+1}_${y})`);
        if (beliefs.grid.has(`${x-1},${y}`)) init.push(`(left  ${from} t_${x-1}_${y})`);
        if (beliefs.grid.has(`${x},${y+1}`)) init.push(`(up    ${from} t_${x}_${y+1})`);
        if (beliefs.grid.has(`${x},${y-1}`)) init.push(`(down  ${from} t_${x}_${y-1})`);
	}

	// parcels: esistenza, posizione, carrying
	for (const id of me.carrying) {
        const pName = `p_${id}`;
        init.push(`(parcel ${pName})`);
        init.push(`(carrying ${agentName} ${pName})`);
    }
    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const parcel = beliefs.parcels.get(intention.parcelId);
        if (!parcel) return null; // sparito nel frattempo
        const pName = `p_${intention.parcelId}`;
        init.push(`(parcel ${pName})`);
        init.push(`(at ${pName} t_${Math.round(parcel.x)}_${Math.round(parcel.y)})`);
    }

	// ── GOAL ────────────────────────────────────────────────
	// Il goal cambia in base a cosa vuole fare l'agente
	let goal = '';

	if (intention.type === 'go_pick_up') {
		// vogliamo che l'agente stia portando il parcel target
		const pName = `p_${intention.parcelId}`;
		goal = `(carrying ${agentName} ${pName})`;
	} else if (intention.type === 'go_deliver'){
		// vogliamo che l'agente abbia consegnato tutti i parcels che porta
		const goals = me.carrying.map(id => `(not (carrying ${agentName} p_${id}))`);
		goal = `(and ${goals.join(' ')})`;
	} else if (intention.type === 'explore') {
		// vogliamo che l'agente raggiunga la tile target
		const t = intention.targetPos;
		goal = `(at ${agentName} t_${t.x}_${t.y})`;
	}

	if (!goal) return null;

	// ── ASSEMBLA IL PROBLEM ──────────────────────────────────
	// unisce objects, init e goal in una stringa PDDL completa
	const objects = [agentName, ...tileNames, ...parcelNames].join(' ');
	const initFacts = init.join('\n        ');

	const problem = `
	(define (problem deliveroo-problem)
		(:domain deliveroo)
		(:objects ${objects})
		(:init
			${initFacts}
		)
		(:goal ${goal})
	)`;
	
	return problem;
}

/**
 * Traduce il piano PDDL in array di mosse per l'executor.
 * Il planner restituisce azioni tipo: "move-right me t_3_4 t_4_4"
 * Noi vogliamo solo: "right"
 * 
 * @param {import('@unitn-asa/pddl-client').PddlAction[]} plan
 * @returns {string[]}
 */
function parsePlan(plan) {
	const moves = [];

	for (const action of plan) {
		switch (action.action) {
			case 'move-right': moves.push('right'); break;
			case 'move-left':  moves.push('left');  break;
            case 'move-up':    moves.push('up');    break;
            case 'move-down':  moves.push('down');  break;
            // pick-up e put-down li ignoriamo qui
            // li gestisce già l'executor quando arriva al target
		}
	}

	return moves;
}