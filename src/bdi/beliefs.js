/**
 * beliefs.js
 *
 * It is updated by socket sensing events.
 * It is READ by deliberation.js and by pathfinding/executor.
 *
 * Structure:
 *   grid           → static map received upon connection
 *   parcels        → visible parcels, with rewards decremented locally
 *   agents         → other players, marked as "stale" when they leave the field of view
 *   me             → the agent's own state
 *   deliveryTiles  → cache of delivery tiles (type '2')
 */

/** @typedef {import('../shared/types.js').Tile}        Tile */
/** @typedef {import('../shared/types.js').Parcel}      Parcel */
/** @typedef {import('../shared/types.js').Agent}       Agent */
/** @typedef {import('../shared/types.js').Me}          Me */
/** @typedef {import('../shared/types.js').BeliefStore} BeliefStore */
/** @typedef {import('../shared/types.js').Position}    Position */

/** @type {BeliefStore} */

export const beliefs = {
	grid: new Map(),
	parcels: new Map(),
	agents: new Map(),
	me: {
		id: null,
		name: null,
		x: null,
		y: null,
		score: 0,
		carrying: [],
	},
	deliveryTiles: [],
	crates: new Map(),
	config: {
		PARCEL_DECADING_INTERVAL: null,
		OBSERVATION_DISTANCE: null,
		MAX_PARCELS: 5,
		PARCEL_FORGET_MS: 5000,
		AGENT_STALE_MS: 3000,
	},
};


// Functions

export function updateMap(tiles) {
	beliefs.grid.clear();
	beliefs.deliveryTiles = [];

	for (const tile of tiles) {
		const key = `${tile.x},${tile.y}`;
		beliefs.grid.set(key, {
			type: tile.type,
			delivery: tile.type === '2',
		});
		if (tile.type === '2') {
			beliefs.deliveryTiles.push({ x: tile.x, y: tile.y });
		}
	}

	console.log(`[beliefs] Map: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`);
}

/**
* @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent} data 
*/
export function updateMe(data) {
	beliefs.me.id = data.id;
	beliefs.me.name = data.name;
	beliefs.me.x = data.x;
	beliefs.me.y = data.y;
	beliefs.me.score = data.score;
}

/**
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOParcel[]} sensedParcels
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent[]}  sensedAgents
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOCrate[]}  [sensedCrates=[]]
 */
export function updateBeliefs(sensedParcels, sensedAgents, sensedCrates = []) {
	const now = Date.now();

	// 1. Update parcels
	const seenParcelIds = new Set(sensedParcels.map(p => p.id));

	for (const p of sensedParcels) {
		const existing = beliefs.parcels.get(p.id);
		beliefs.parcels.set(p.id, {
			id: p.id,
			x: p.x,
			y: p.y,
			reward: p.reward,
			carriedBy: p.carriedBy ?? null,
			lastSeen: now,
		});
		if (!existing) {
			console.log(`[beliefs] New parcel detected: ${p.id} at (${p.x},${p.y}) reward=${p.reward}`);
		}
	}

	for (const [id, p] of beliefs.parcels) {
		if (seenParcelIds.has(id)) continue;
		const age = now - p.lastSeen;
		if (age > beliefs.config.PARCEL_FORGET_MS || p.reward <= 0) {
			beliefs.parcels.delete(id);
			console.log(`[beliefs] Parcel removed: ${id}`);
		}
	}

	if (beliefs.me.id) {
		beliefs.me.carrying = [...beliefs.parcels.values()]
			.filter(p => p.carriedBy === beliefs.me.id)
			.map(p => p.id);
	}

	// 2. Update agents
	const seenAgentIds = new Set(sensedAgents.map(a => a.id));

	for (const a of sensedAgents) {
		if (a.id === beliefs.me.id) continue;
		beliefs.agents.set(a.id, { ...a, lastSeen: now, stale: false });
	}

	for (const [id, agent] of beliefs.agents) {
		if (!seenAgentIds.has(id) && id !== beliefs.me.id) {
			if (Date.now() - agent.lastSeen > beliefs.config.AGENT_STALE_MS) {
				beliefs.agents.set(id, { ...agent, stale: true });
			}
		}
	}

	// 3. Update Crates
	beliefs.crates.clear();
	for (const c of sensedCrates) {
		const key = `${Math.round(c.x)},${Math.round(c.y)}`;
		beliefs.crates.set(key, { id: c.id, x: c.x, y: c.y, lastSeen: now });
	}
}


export function decayParcelsReward() {
	for (const [id, p] of beliefs.parcels) {
		if (p.reward - 1 <= 0) {
			beliefs.parcels.delete(id);
		} else {
			beliefs.parcels.set(id, { ...p, reward: p.reward - 1 });
		}
	}
}

/**
 * @param {Position} a
 * @param {Position} b
 * @returns {number}
 */
export function manhattanDistance(a, b) {
	return Math.abs(Math.round(a.x) - Math.round(b.x))
		+ Math.abs(Math.round(a.y) - Math.round(b.y));
}


export { isWalkable, canEnter } from './grid.js';