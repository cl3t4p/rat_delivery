// Genera il problem.pddl dai beliefs e chiama il planner esterno

import { onlineSolver } from '@unitn-asa/pddl-client';
import { beliefs, isWalkable, canEnter } from '../bdi/beliefs.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** @typedef {import('../shared/types.js').Intention} Intention */
/** @typedef {import('../shared/types.js').Direction} Direction */

// Legge il domain.pddl
const __dirname = dirname(fileURLToPath(import.meta.url));
const domainFile = readFileSync(join(__dirname, 'domain.pddl'), 'utf8');

// Timeout di sicurezza: il solver online a volte si pianta
const PDDL_TIMEOUT_MS = 5000;

// ── API PUBBLICA ──────────────────────────────────────────────

/**
 * Pianifica con PDDL la sequenza di mosse per raggiungere il target dell'intention.
 * @param {Intention} intention
 * @returns {Promise<Direction[]>} array di mosse, [] se fallisce
 */
export async function planWithPDDL(intention) {
    const problem = buildProblem(intention);
    if (!problem) {
        console.log(`[pddl] buildProblem returned null for ${intention.type} → ${intention.parcelId ?? ''}`);
        return [];
    }

    try {
        console.log(`[pddl] calling solver for ${intention.type} → (${intention.targetPos.x},${intention.targetPos.y})`);
        const plan = await withTimeout(onlineSolver(domainFile, problem), PDDL_TIMEOUT_MS);
        if (!plan || plan.length === 0) {
            console.log('[pddl] solver returned empty plan');
            return [];
        }
        const moves = parsePlan(plan);
        if (moves.length === 0) console.log('[pddl] parsePlan returned 0 moves (no move-* actions?)');
        return moves;
    } catch (err) {
        console.log(`[pddl] planner failed: ${err.message ?? err}`);
        return [];
    }
}

// ── COSTRUZIONE DEL PROBLEM ───────────────────────────────────

/**
 * Costruisce la stringa problem.pddl. Restituisce null se non c'è abbastanza
 * info nei beliefs per pianificare (posizione sconosciuta, parcel sparito, ...).
 * @param {Intention} intention
 * @returns {string|null}
 */
function buildProblem(intention) {
    if (!intention?.targetPos) return null;

    const me = beliefs.me;
    if (me.x === null || me.y === null) return null;

    const agentName = 'me';
    const mx = Math.round(me.x);
    const my = Math.round(me.y);

    // 1. set di tile percorribili (escludiamo muri, crate, agenti vivi)
    //    inclusa SEMPRE la tile su cui sto, anche se per qualche motivo non
    //    è marcata walkable, altrimenti l'agente non esisterebbe da nessuna parte.
    const blocked = blockedTiles();
    const tiles = new Set();
    tiles.add(`${mx},${my}`);

    for (const [key] of beliefs.grid) {
        if (blocked.has(key)) continue;
        const [x, y] = key.split(',').map(Number);
        if (!isWalkable(x, y)) continue;
        tiles.add(key);
    }

    // 2. objects: agente + tile + parcels coinvolti (il parcel target di
    //    go_pick_up viene aggiunto da goalForIntention solo se è ancora valido)
    const tileNames = [...tiles].map(k => `t_${k.replace(',', '_')}`);
    const parcelNames = [];
    for (const id of me.carrying) parcelNames.push(`p_${id}`);

    // 3. init facts
    const init = [];
    init.push(`(agent ${agentName})`);
    init.push(`(me ${agentName})`);
    init.push(`(at ${agentName} t_${mx}_${my})`);

    for (const key of tiles) {
        const [x, y] = key.split(',').map(Number);
        const tName = `t_${x}_${y}`;
        init.push(`(tile ${tName})`);
        if (beliefs.grid.get(key)?.delivery) init.push(`(delivery ${tName})`);
    }

    // 4. adiacenza: solo se la destinazione è in `tiles` E canEnter la consente
    //    (così rispettiamo anche le frecce one-way)
    for (const key of tiles) {
        const [x, y] = key.split(',').map(Number);
        const from = `t_${x}_${y}`;

        addEdge(init, from, x, y, x + 1, y, 'right', tiles);
        addEdge(init, from, x, y, x - 1, y, 'left',  tiles);
        addEdge(init, from, x, y, x, y + 1, 'up',    tiles);
        addEdge(init, from, x, y, x, y - 1, 'down',  tiles);
    }

    // 5. parcels: pacchi che porto + (se go_pick_up) il pacco target
    for (const id of me.carrying) {
        init.push(`(parcel p_${id})`);
        init.push(`(carrying ${agentName} p_${id})`);
    }

    // 6. goal: prova l'intention richiesta; se il target non è valido o
    //    raggiungibile, fallback a "vai alla spawner tile più vicina"
    //    così l'agente non resta mai fermo aspettando un parcel.
    let goal = goalForIntention(intention, agentName, mx, my, tiles, init, parcelNames);
    if (!goal) {
        const fb = nearestSpawnerGoal(agentName, mx, my, tiles);
        if (!fb) return null;
        console.log(`[pddl] fallback goal: walk to nearest spawner ${fb.tag}`);
        goal = fb.goal;
    }

    const objects = [agentName, ...tileNames, ...parcelNames].join(' ');
    return `(define (problem deliveroo-problem)
    (:domain deliveroo)
    (:objects ${objects})
    (:init
        ${init.join('\n        ')}
    )
    (:goal ${goal})
)`;
}

/**
 * Calcola il goal PDDL per l'intention richiesta. Restituisce null se
 * l'intention non ha un target valido (parcel sparito, niente da consegnare,
 * tile target non raggiungibile, tipo sconosciuto). In tal caso il chiamante
 * cade sul `nearestSpawnerGoal` come fallback.
 *
 * Side effect: per `go_pick_up` aggiunge i fatti del parcel a `init` e
 * il suo nome a `parcelNames` (così l'oggetto compare nel problem).
 */
function goalForIntention(intention, agentName, mx, my, tiles, init, parcelNames) {
    if (intention.type === 'go_pick_up' && intention.parcelId) {
        const parcel = beliefs.parcels.get(intention.parcelId);
        if (!parcel) return null;
        const px = Math.round(parcel.x);
        const py = Math.round(parcel.y);
        if (!tiles.has(`${px},${py}`)) return null;
        const pName = `p_${intention.parcelId}`;
        if (!parcelNames.includes(pName)) parcelNames.push(pName);
        init.push(`(parcel ${pName})`);
        init.push(`(at ${pName} t_${px}_${py})`);
        return `(carrying ${agentName} ${pName})`;
    }
    if (intention.type === 'go_deliver') {
        if (beliefs.me.carrying.length === 0) return null;
        const drops = beliefs.me.carrying.map(id => `(not (carrying ${agentName} p_${id}))`);
        return drops.length === 1 ? drops[0] : `(and ${drops.join(' ')})`;
    }
    if (intention.type === 'explore') {
        const t = intention.targetPos;
        const tx = Math.round(t.x), ty = Math.round(t.y);
        if (!tiles.has(`${tx},${ty}`)) return null;
        return `(at ${agentName} t_${tx}_${ty})`;
    }
    return null;
}

/**
 * Goal di fallback: vai alla tile spawner (tipo '1') più vicina,
 * tra quelle attualmente walkable / non bloccate (`tiles`).
 * Restituisce { goal, tag } o null se non c'è nessuno spawner raggiungibile.
 */
function nearestSpawnerGoal(agentName, mx, my, tiles) {
    let best = null, bestDist = Infinity;
    for (const key of tiles) {
        const tile = beliefs.grid.get(key);
        if (!tile || tile.type !== '1') continue;
        const [x, y] = key.split(',').map(Number);
        if (x === mx && y === my) continue; // già qui, sarebbe goal banale
        const d = Math.abs(x - mx) + Math.abs(y - my);
        if (d < bestDist) { bestDist = d; best = { x, y }; }
    }
    if (!best) return null;
    return { goal: `(at ${agentName} t_${best.x}_${best.y})`, tag: `(${best.x},${best.y})` };
}

/**
 * Aggiunge un fatto di adiacenza al problem se la mossa è permessa.
 * Rispetta isWalkable, crate/agenti bloccanti e le frecce one-way (via canEnter).
 */
function addEdge(init, fromName, fx, fy, tx, ty, dir, tiles) {
    const toKey = `${tx},${ty}`;
    if (!tiles.has(toKey)) return;
    if (!canEnter(fx, fy, tx, ty)) return;
    init.push(`(${dir} ${fromName} t_${tx}_${ty})`);
}

/**
 * Tile che NON devono entrare nel problem perché bloccate da entità dinamiche:
 * crate veri sensed + agenti avversari non-stale.
 * @returns {Set<string>}
 */
function blockedTiles() {
    const blocked = new Set();
    for (const key of beliefs.crates.keys()) blocked.add(key);
    for (const a of beliefs.agents.values()) {
        if (a.stale) continue;
        blocked.add(`${Math.round(a.x)},${Math.round(a.y)}`);
    }
    return blocked;
}

// ── PARSING DEL PIANO ────────────────────────────────────────

/**
 * Traduce il piano PDDL in mosse per l'executor.
 * Le azioni move-* diventano direzioni; pick-up / put-down sono ignorate
 * (le esegue l'executor al raggiungimento del target).
 * @param {{action: string, args: string[]}[]} plan
 * @returns {Direction[]}
 */
function parsePlan(plan) {
    const moves = [];
    for (const step of plan) {
        const a = (step?.action ?? '').toLowerCase();
        switch (a) {
            case 'move-right': moves.push('right'); break;
            case 'move-left':  moves.push('left');  break;
            case 'move-up':    moves.push('up');    break;
            case 'move-down':  moves.push('down');  break;
            // pick-up / put-down: ignorate (gestite dall'executor)
        }
    }
    return moves;
}

// ── UTIL ─────────────────────────────────────────────────────

/**
 * Rifiuta la promise dopo `ms` millisecondi.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`pddl timeout (${ms}ms)`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
