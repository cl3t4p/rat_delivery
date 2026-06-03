/**
 * beliefs.js
 *
 * Updated by socket sensing events.
 * Read by deliberation.js, pathfinding.js, and executor.js.
 *
 * Structure:
 *   grid          - Static map received upon connection.
 *   parcels       - Visible parcels, with rewards decremented locally.
 *   agents        - Other players, marked as stale when they leave the field of view.
 *   me            - The agent's own state.
 *   deliveryTiles - Cached delivery tiles.
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
        PARCEL_GENERATION_INTERVAL: null, // ms between parcel spawns (see clockEventToMs)
        OBSERVATION_DISTANCE: null,
        MAX_PARCELS: 5,
        PARCEL_FORGET_MS: 5000,
        AGENT_STALE_MS: 3000,
    },
};

// Functions
/**
 * Updates the known map tiles.
 *
 * Clears the old map, stores the new tiles, and saves all delivery tiles.
 *
 * @param {{ x: number, y: number, type: string }[]} tiles - Tiles received from the server.
 */
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

    console.log(
        `[beliefs] Map: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`
    );
}

/**
 * Updates the agent state.
 *
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
 * Updates the belief store with the latest sensed objects.
 *
 * Updates parcels, agents, carried parcels, and crates.
 * Old parcels are removed, while agents not seen for a while are marked as stale.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOParcel[]} sensedParcels - Parcels currently visible.
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent[]} sensedAgents - Agents currently visible.
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOCrate[]} [sensedCrates=[]] - Crates currently visible.
 */
export function updateBeliefs(sensedParcels, sensedAgents, sensedCrates = []) {
    const now = Date.now();

    // 1. Update parcels
    const seenParcelIds = new Set(sensedParcels.map((p) => p.id));

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
            console.log(
                `[beliefs] New parcel detected: ${p.id} at (${p.x},${p.y}) reward=${p.reward}`
            );
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
            .filter((p) => p.carriedBy === beliefs.me.id)
            .map((p) => p.id);
    }

    // 2. Update agents
    const seenAgentIds = new Set(sensedAgents.map((a) => a.id));

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
    return (
        Math.abs(Math.round(a.x) - Math.round(b.x)) + Math.abs(Math.round(a.y) - Math.round(b.y))
    );
}

/**
 * Converts a Deliveroo clock-event value into milliseconds.
 *
 * The server expresses parcel generation/decay rates either as a number (ms)
 * or as a duration string with a unit: "<n>ms" | "<n>s" | "<n>m" (e.g. "2s",
 * "500ms", "1m"). The special event "frame" means one clock tick (~40ms). A
 * larger value means the event fires less often — a higher generation interval
 * means parcels spawn more rarely, so camping a spawner pays off less.
 *
 * @param {string|number|null|undefined} event
 * @returns {number|null} interval in ms, or null if it is not a parseable duration.
 */
export function clockEventToMs(event) {
    if (event == null) return null;
    if (typeof event === 'number') return Number.isFinite(event) ? event : null;
    if (event === 'frame') return 40; // one clock tick (~25 fps)

    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/.exec(event);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[2] ?? 's'; // bare number defaults to seconds
    const factor = unit === 'ms' ? 1 : unit === 'm' ? 60_000 : 1000;
    return value * factor;
}

export { isWalkable, canEnter } from './grid.js';
