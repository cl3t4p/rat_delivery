/**
 * beliefs.js
 *
 * Il "taccuino" dell'agente: tutto ciò che sa sull'ambiente.
 * Viene aggiornato dai sensing events del socket.
 * Viene LETTO da deliberation.js (Persona A) e da pathfinding/executor (Persona B).
 *
 * Struttura:
 *   grid           → mappa fissa ricevuta alla connessione
 *   parcels        → pacchi visibili, con reward decrementato localmente
 *   agents         → altri giocatori, marcati "stale" se escono dal campo visivo
 *   me             → lo stato dell'agente stesso
 *   deliveryTiles  → cache delle caselle di consegna (tipo '2')
*/

/** @typedef {import('../shared/types.js').Tile}        Tile */
/** @typedef {import('../shared/types.js').Parcel}      Parcel */
/** @typedef {import('../shared/types.js').Agent}       Agent */
/** @typedef {import('../shared/types.js').Me}          Me */
/** @typedef {import('../shared/types.js').BeliefStore} BeliefStore */
/** @typedef {import('../shared/types.js').Position}    Position */

/** @type {BeliefStore} */

export const beliefs = {
    grid: new Map(), // la mappa
    parcels: new Map(),	// i pacchi
	agents: new Map(), // gli avversari
	me: {
		id: null, 
		name: null,
		x: null,
		y: null,
		score: 0,
		carrying: [],
	},
	deliveryTiles: [], // cache zone consegna
	crates: new Map(), // crate veri visti adesso: key = "x,y" -> { id, x, y, lastSeen }
	config: {
		PARCEL_DECADING_INTERVAL: null,
		OBSERVATION_DISTANCE: null,
		MAX_PARCELS: 5,        // capacity (sovrascritto da onConfig)
		//Non piu const solo per facilitare le modiche
		PARCEL_FORGET_MS: 5000, // dimentica un parcel non più visto dopo X ms
		AGENT_STALE_MS: 3000,   // marca un agente come stale dopo X ms
	},
};

// ── FUNZIONI ──────────────────────────────────────────────────

// updateMap(tiles) -> chiamata una volta sola quando ti connetti al server
export function updateMap(tiles) {
	// svuotare la mappa
	beliefs.grid.clear();
	beliefs.deliveryTiles = [];

	// inserire ogni tile nella Map con chiave "x,y"
	for (const tile of tiles) {
		const key = `${tile.x},${tile.y}`;

		beliefs.grid.set(key, {
			type: tile.type,
			delivery: tile.type === '2', // salvare separatamente le tile di tipo '2' (zone consegna)
		});

		// cache delle zone consegna
		if (tile.type === '2') {
			beliefs.deliveryTiles.push({x: tile.x, y: tile.y});
		}
	}

	console.log(`[beliefs] Map: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`);
}

/**
* aggiorna i miei dati (posizione, score) ad ogni sensing
* @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent} data 
* @returns {void}
*/
export function updateMe(data) {
	beliefs.me.id = data.id;
	beliefs.me.name = data.name;
	beliefs.me.x = data.x;
	beliefs.me.y = data.y;
	beliefs.me.score = data.score;
}



/**
 * Aggiorna parcels, carrying, agents e crates ad ogni sensing event.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOParcel[]} sensedParcels   pacchi visibili nel raggio attuale
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent[]}  sensedAgents    agenti visibili nel raggio attuale (incluso me, filtrato dentro)
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOCrate[]}  [sensedCrates=[]] crate visibili nel raggio attuale
 * @returns {void}
 */
export function updateBeliefs(sensedParcels, sensedAgents, sensedCrates = []) {
	// aggiorna i parcels visti adesso
	const now = Date.now();

	// ── 1. AGGIORNA PARCELS ──────────────────────────────────────────────────

	// costruiamo un Set degli id visti in questo sensing
	const seenParcelIds = new Set(sensedParcels.map(p => p.id));

	// aggiorna o inserisci i parcels visti adesso
	for (const p of sensedParcels) {
		const existing = beliefs.parcels.get(p.id);

		beliefs.parcels.set(p.id, {
			id: p.id,
			x: p.x,
			y: p.y,
			reward: p.reward, // il server ci manda il reward aggiornato
			carriedBy: p.carriedBy ?? null,
			lastSeen: now,
		});

		// nuovo parcel apparso: logga per debug
        if (!existing) {
            console.log(`[beliefs] New parcel detected: ${p.id} at (${p.x},${p.y}) reward=${p.reward}`);
        }
	}

	// rimuove i parcels vecchi o esauriti
	for (const [id, p] of beliefs.parcels) {
		if (seenParcelIds.has(id)) continue; // l'abbiamo appena visto

		const age = now - p.lastSeen;
		if (age > beliefs.config.PARCEL_FORGET_MS || p.reward <= 0) {
			beliefs.parcels.delete(id);
			console.log(`[beliefs] Parcel removed: ${id}`);
		}
	}

	// aggiorna carrying: quali pacchi sta portando "me"?
	if (beliefs.me.id) {
		beliefs.me.carrying = [...beliefs.parcels.values()]
		.filter(p => p.carriedBy === beliefs.me.id)
		.map(p => p.id);
	}

	// ── 2. AGGIORNA AGENTI ───────────────────────────────────────────────────

	// agenti avversari
	const seenAgentIds = new Set(sensedAgents.map(a => a.id));

	// aggiorna agenti visti adesso
	for(const a of sensedAgents) {
		if (a.id === beliefs.me.id) continue; // non tracciare me stesso
		beliefs.agents.set(a.id, {...a, lastSeen: now, stale: false}); // stale: false -> appena visto
	}

	// marca come stale gli agenti che non vediamo più
	for (const [id, agent] of beliefs.agents) {
		if (!seenAgentIds.has(id) && id !== beliefs.me.id) {
			if (Date.now() - agent.lastSeen > beliefs.config.AGENT_STALE_MS) {
				// non lo rimuove, ma segniamo che la posizione non è aggiornata
				beliefs.agents.set(id, {...agent, stale: true});
			}
		}
	}

	// ── 3. AGGIORNA CRATES ───────────────────────────────────────────────────
	// I crate spawnano/scompaiono dinamicamente sulle tile '5'/'5!'.
	// Sovrascriviamo l'intero Map: vediamo solo quelli nel raggio attuale,
	// quelli fuori non sappiamo se ci sono ancora -> approccio ottimistico (libera la tile).
	beliefs.crates.clear();
	for (const c of sensedCrates) {
		const key = `${Math.round(c.x)},${Math.round(c.y)}`;
		beliefs.crates.set(key, { id: c.id, x: c.x, y: c.y, lastSeen: now });
	}
}

// ── FUNZIONI DI SUPPORTO ──────────────────────────────────────────────────

// decayParcelsReward() => decrementa il reward ad ogni ciclo
export function decayParcelsReward() {
	for (const [id, p] of beliefs.parcels) {
		// decrementa di 1 (simula il comportamento del server)
		if (p.reward - 1 <= 0) {
			beliefs.parcels.delete(id);
		} else {
			beliefs.parcels.set(id, {...p, reward: p.reward - 1});
		}
	}
}

/**
 * Distanza Manhattan tra due punti
 * @param {Position} a
 * @param {Position} b
 * @returns {number}
 */
export function manhattanDistance(a, b) {
	return Math.abs(Math.round(a.x) - Math.round(b.x))
		+ Math.abs(Math.round(a.y) - Math.round(b.y));
}

// Solo i muri ('0') sono bloccanti per tipo di tile.
const BLOCKING_TYPES = new Set(['0']);

// Frecce one-way: NON puoi entrare da direzione opposta alla freccia.
// '↑' (dy=+1) -> vietato entrare da sopra (dy=-1)
// '→' (dx=+1) -> vietato entrare da destra (dx=-1)
// '↓' (dy=-1) -> vietato entrare da sotto (dy=+1)
// '←' (dx=-1) -> vietato entrare da sinistra (dx=+1)
const ARROW_VEC = { '↑': [0, 1], '→': [1, 0], '↓': [0, -1], '←': [-1, 0] };

// isWalkable(x,y) => tile esiste ed è transitabile (no muri, no crate)
export function isWalkable(x, y) {
	const tile = beliefs.grid.get(`${x},${y}`);
	if (!tile) return false;
	return !BLOCKING_TYPES.has(tile.type);
}

// canEnter(fromX, fromY, toX, toY) => puoi entrare in (toX,toY) venendo da (fromX,fromY)?
// Combina isWalkable + crate veri sensed + check direzione per le frecce.
export function canEnter(fromX, fromY, toX, toY) {
	const key = `${toX},${toY}`;
	const tile = beliefs.grid.get(key);
	if (!tile) return false;
	if (BLOCKING_TYPES.has(tile.type)) return false;

	// crate vero presente sulla tile -> bloccante (anche se la tile sotto è '5' o '3')
	if (beliefs.crates.has(key)) return false;

	const v = ARROW_VEC[tile.type];
	if (!v) return true; // tile normale, nessun vincolo direzionale

	const dx = toX - fromX;
	const dy = toY - fromY;
	// vietato entrare se la direzione di ingresso è opposta alla freccia
	return !(dx === -v[0] && dy === -v[1]);
}