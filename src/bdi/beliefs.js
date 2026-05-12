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

// ── COSTANTI ──────────────────────────────────────────────────

// Dopo quanti millisecondi dimenticare un parcel non più visto
export const PARCEL_FORGET_MS = 5000;

// Dopo quanti ms marcare un agente come "stale" (posizione non aggiornata)
export const AGENT_STALE_MS = 3000;

// BELIEF STORE

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

	console.log(`[beliefs] Mappa: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`);
}

// updateMe(data) -> aggiorna i miei dati (posizione, score) ad ogni sensing
export function updateMe(data) {
	beliefs.me.id = data.id;
	beliefs.me.name = data.name;
	beliefs.me.x = data.x;
	beliefs.me.y = data.y;
	beliefs.me.score = data.score;
}

// updateBeliefs(sensedParcels, sensedAgents) -> aggiorna parcels, carrying e agents ad ogni sensing event
export function updateBeliefs(sensedParcels, sensedAgents) {
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
            console.log(`[beliefs] Nuovo parcel rilevato: ${p.id} a (${p.x},${p.y}) reward=${p.reward}`);
        }
	}

	// rimuove i parcels vecchi o esauriti
	for (const [id, p] of beliefs.parcels) {
		if (seenParcelIds.has(id)) continue; // l'abbiamo appena visto

		const age = now - p.lastSeen;
		if (age > PARCEL_FORGET_MS || p.reward <= 0) {
			beliefs.parcels.delete(id);
			console.log(`[beliefs] Parcel rimosso: ${id}`);
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
			if (Date.now() - agent.lastSeen > AGENT_STALE_MS) {
				// non lo rimuove, ma segniamo che la posizione non è aggiornata
				beliefs.agents.set(id, {...agent, stale: true});
			}
		}
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

// manhattanDistance(a,b) => distanza Manhattan tra due punti
export function manhattanDistance(a, b) {
	return Math.abs(Math.round(a.x) - Math.round(b.x))
		+ Math.abs(Math.round(a.y) - Math.round(b.y));
}

// isWalkable(x,y) => controlla se una tile è calpestabile (tipo 1, 2 o 3)
export function isWalkable(x, y) {
	const tile = beliefs.grid.get(`${x},${y}`);
	return tile !== undefined && tile.type !== '0';
}