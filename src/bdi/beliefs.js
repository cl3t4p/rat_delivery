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

import { invalidateBounds } from '../shared/zones.js';

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
    blacklist: new Set(), // cell keys "x,y" the agent must avoid (set by the policy/LLM)
    temporaryBlacklist: new Map(), // cell key "x,y" -> expiresAt timestamp
    config: {
        PARCEL_DECADING_INTERVAL: null,
        PARCEL_GENERATION_INTERVAL: null, // ms between parcel spawns (see clockEventToMs)
        OBSERVATION_DISTANCE: null,
        MAX_PARCELS: 5,
        PARCEL_FORGET_MS: 5000,
        AGENT_STALE_MS: 3000,
        CLAIMED_PARCEL_SUPPRESS_MS: 8000,
    },
};

const claimedParcelSuppressions = new Map(); // parcelId -> expiresAt
const handoffDroppedParcels = new Map(); // parcelId -> expiresAt after own handoff drop

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
        const type = String(tile.type);
        beliefs.grid.set(key, {
            type,
            delivery: type === '2',
        });
        if (type === '2') {
            beliefs.deliveryTiles.push({ x: tile.x, y: tile.y });
        }
    }

    invalidateBounds();

    console.log(
        `[beliefs] Map: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`
    );
}

/**
 * Updates the agent's own state from a sensing event.
 *
 * Also measures the real ms-per-step dynamically using a moving average,
 * so scoring functions can estimate decay accurately.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent} data
 */
export function updateMe(data) {
    const prevX = beliefs.me.x;
    const prevY = beliefs.me.y;
    const now = Date.now();

    beliefs.me.id = data.id;
    beliefs.me.name = data.name;
    beliefs.me.x = data.x;
    beliefs.me.y = data.y;
    beliefs.me.score = data.score;

    // Measure real ms per step dynamically using a moving average.
    // Only update when the agent moved exactly 1 tile.
    if (prevX !== null && prevY !== null) {
        const moved = Math.abs(data.x - prevX) + Math.abs(data.y - prevY);
        if (Math.round(moved) === 1) {
            const elapsed = now - (beliefs.config._lastMoveTime ?? now);
            if (elapsed > 0 && elapsed < 5000) {
                const prev = beliefs.config.MS_PER_STEP ?? 500;
                beliefs.config.MS_PER_STEP = prev * 0.8 + elapsed * 0.2;
            }
            beliefs.config._lastMoveTime = now;
        }
    }
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
    pruneClaimedParcelSuppressions(now);
    const seenParcelIds = new Set();

    for (const p of sensedParcels) {
        if (isHandoffDropSuppressed(p.id, now)) {
            if (p.carriedBy === beliefs.me.id) {
                handoffDroppedParcels.delete(p.id);
                claimedParcelSuppressions.delete(p.id);
            } else {
                continue;
            }
        }

        if (isParcelSuppressed(p.id, now)) {
            if (p.carriedBy !== beliefs.me.id) continue;
            claimedParcelSuppressions.delete(p.id);
        }

        if (p.carriedBy && p.carriedBy !== beliefs.me.id) {
            suppressClaimedParcel(p.id);
            continue;
        }

        seenParcelIds.add(p.id);
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
        if (p.carriedBy === beliefs.me.id) continue; // never age out parcels we are carrying
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

    const AGENT_FORGET_MS = 60_000;
    for (const [id, agent] of beliefs.agents) {
        if (!seenAgentIds.has(id) && id !== beliefs.me.id) {
            const age = Date.now() - agent.lastSeen;
            if (age > AGENT_FORGET_MS) {
                beliefs.agents.delete(id);
                console.log(`[beliefs] Agent purged: ${id}`);
            } else if (age > beliefs.config.AGENT_STALE_MS) {
                beliefs.agents.set(id, { ...agent, stale: true });
            }
        }
    }

    // 3. Update crates.
    // Crates are persisted across sensing updates so the planner keeps routing around
    // a crate even after it leaves the field of view. The server only reports crates
    // currently in range, so clearing them every tick made the agent forget any crate
    // it could not see and later walk into / wrongly push it.
    //
    // A remembered crate is dropped only when we can actually observe its tile is
    // empty: it is within observation range yet absent from the current sensing. With
    // unlimited vision every crate is observable, so an unseen crate is always gone.
    // Crates out of range are assumed to still sit where we last saw them.
    const seenCrateKeys = new Set();
    const seenCrateIds = new Set();
    for (const c of sensedCrates) {
        const key = `${Math.round(c.x)},${Math.round(c.y)}`;
        seenCrateKeys.add(key);
        if (c.id != null) seenCrateIds.add(c.id);
        beliefs.crates.set(key, { id: c.id, x: c.x, y: c.y, lastSeen: now });
    }

    const view = beliefs.config.OBSERVATION_DISTANCE;
    const unlimitedView = view == null || view <= 0;
    const meKnown = beliefs.me.x !== null && beliefs.me.y !== null;
    for (const [key, c] of beliefs.crates) {
        if (seenCrateKeys.has(key)) continue;
        // Same crate id sensed on another tile this tick → this is a stale duplicate
        // of a crate that has since moved; drop it regardless of range.
        if (c.id != null && seenCrateIds.has(c.id)) {
            beliefs.crates.delete(key);
            continue;
        }
        if (unlimitedView || (meKnown && manhattanDistance(beliefs.me, c) < view)) {
            beliefs.crates.delete(key);
        }
    }

    // The agent can never share a tile with a crate. If we are standing on a
    // remembered crate it must be stale, so drop it — this also lets the planner
    // treat our own tile as a free crate destination once we step aside.
    if (meKnown) {
        beliefs.crates.delete(`${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)}`);
    }
}

export function suppressClaimedParcel(parcelId, ttlMs = beliefs.config.CLAIMED_PARCEL_SUPPRESS_MS) {
    if (!parcelId) return;
    claimedParcelSuppressions.set(parcelId, Date.now() + ttlMs);
    beliefs.parcels.delete(parcelId);
}

/** Suppresses a parcel that this agent intentionally dropped for a handoff.
 *  Unlike suppressClaimedParcel, this suppression is NOT cleared when the
 *  sensing shows the parcel unclaimed — A must not re-pick its own drop. */
export function suppressHandoffDrop(parcelId, ttlMs = beliefs.config.CLAIMED_PARCEL_SUPPRESS_MS) {
    if (!parcelId) return;
    const expiresAt = Date.now() + ttlMs;
    handoffDroppedParcels.set(parcelId, expiresAt);
    claimedParcelSuppressions.set(parcelId, expiresAt);
    beliefs.parcels.delete(parcelId);
}

export function clearParcelSuppressions({ includeHandoffDrops = false } = {}) {
    claimedParcelSuppressions.clear();
    if (includeHandoffDrops) handoffDroppedParcels.clear();
}

function isParcelSuppressed(parcelId, now = Date.now()) {
    if (isHandoffDropSuppressed(parcelId, now)) return true;
    const expiresAt = claimedParcelSuppressions.get(parcelId);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
        claimedParcelSuppressions.delete(parcelId);
        return false;
    }
    return true;
}

function isHandoffDropSuppressed(parcelId, now = Date.now()) {
    const expiresAt = handoffDroppedParcels.get(parcelId);
    if (!expiresAt) return false;
    if (expiresAt <= now) {
        handoffDroppedParcels.delete(parcelId);
        if (claimedParcelSuppressions.get(parcelId) === expiresAt) {
            claimedParcelSuppressions.delete(parcelId);
        }
        return false;
    }
    return true;
}

function pruneClaimedParcelSuppressions(now = Date.now()) {
    for (const [id, expiresAt] of claimedParcelSuppressions) {
        if (expiresAt <= now) claimedParcelSuppressions.delete(id);
    }
    for (const [id, expiresAt] of handoffDroppedParcels) {
        if (expiresAt <= now) handoffDroppedParcels.delete(id);
    }
}

export function decayParcelsReward() {
    // Called every 1000ms. If decay interval > 1000ms, decay happens
    // less than once per call — track fractional accumulation.
    const interval = beliefs.config?.PARCEL_DECADING_INTERVAL;
    if (!interval || interval <= 0) return;

    beliefs.config._decayAccumulatedMs = (beliefs.config._decayAccumulatedMs ?? 0) + 1000;

    const steps = Math.floor(beliefs.config._decayAccumulatedMs / interval);
    if (steps === 0) return;

    beliefs.config._decayAccumulatedMs -= steps * interval;

    for (const [id, p] of beliefs.parcels) {
        if (p.carriedBy !== null) continue; // carried parcels aren't decayed locally
        const newReward = p.reward - steps;
        if (newReward <= 0) {
            beliefs.parcels.delete(id);
        } else {
            beliefs.parcels.set(id, { ...p, reward: newReward });
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
    if (typeof event === 'number') return Number.isFinite(event) ? event : null; // server sends numbers already in ms
    if (event === 'frame') return 40; // one clock tick (~25 fps)

    const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m)?\s*$/.exec(event);
    if (!match) return null;

    const value = parseFloat(match[1]);
    const unit = match[2] ?? 's'; // string without unit defaults to seconds (e.g. "5" → 5000ms)
    const factor = unit === 'ms' ? 1 : unit === 'm' ? 60_000 : 1000;
    return value * factor;
}

// Blacklisted cells
//
// The agent must treat as impassable for now. Honored by isWalkable /
// canEnter (grid.js), so A* pathfinding, go_to and the executor all route
// around them. Populated by the LLM policy (or coordination) at runtime.

/** @param {number} x
 * @param {number} y
 */
export function blacklistCell(x, y) {
    beliefs.blacklist.add(`${x},${y}`);
}

/**
 * Temporarily blacklists a cell for pathfinding.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} ttlMs
 */
export function blacklistCellTemporary(x, y, ttlMs = 5000) {
    const key = `${x},${y}`;
    beliefs.temporaryBlacklist.set(key, Date.now() + ttlMs);
}

/**
 * @param {number} x
 * @param {number} y
 */
export function unblacklistCell(x, y) {
    beliefs.blacklist.delete(`${x},${y}`);
}

/** @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isBlacklisted(x, y) {
    const key = `${x},${y}`;

    if (beliefs.blacklist.has(key)) return true;

    const expiresAt = beliefs.temporaryBlacklist.get(key);
    if (!expiresAt) return false;

    if (Date.now() > expiresAt) {
        beliefs.temporaryBlacklist.delete(key);
        return false;
    }

    return true;
}

export function clearBlacklist() {
    beliefs.blacklist.clear();
    beliefs.temporaryBlacklist.clear();
}

export { isWalkable, canEnter, canTraverse, canPush } from './grid.js';
