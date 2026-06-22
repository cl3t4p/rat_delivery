/**
 * beliefs.js
 *
 * Shared belief store updated from sensing events.
 */

import { manhattanDistance } from './helper.js';

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
        handoffReceivedParcels: new Set(), // Parcels received via handoff.
        handoffBonusActive: false, // Server announced handoff bonus rule.
    },
    deliveryTiles: [],
    crates: new Map(),
    blacklist: new Set(), // Permanent "x,y" blocked cells.
    temporaryBlacklist: new Map(), // "x,y" -> expiresAt.
    config: {
        PARCEL_DECADING_INTERVAL: 1000,
        PARCEL_GENERATION_INTERVAL: null,
        OBSERVATION_DISTANCE: 5,
        MS_PER_STEP: 500,
        MAX_PARCELS: 1,
        PARCEL_FORGET_MS: 5000,
        AGENT_STALE_MS: 3000,
        CLAIMED_PARCEL_SUPPRESS_MS: 8000,
    },
};

const claimedParcelSuppressions = new Map(); // parcelId -> expiresAt.
const handoffDroppedParcels = new Map(); // Own handoff drops, parcelId -> expiresAt.

/**
 * Sets the known map tiles.
 *
 * @param {{ x: number, y: number, type: string }[]} tiles - Tiles received from the server.
 */
export function updateMap(tiles) {
    if (beliefs.grid.size > 0) return;

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

    console.log(
        `[beliefs] Map: ${beliefs.grid.size} tiles, ${beliefs.deliveryTiles.length} delivery`
    );
}

/**
 * Updates this agent's state.
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
 * Updates dynamic beliefs from sensing.
 *
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOParcel[]} sensedParcels - Parcels currently visible.
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOAgent[]} sensedAgents - Agents currently visible.
 * @param {import('@unitn-asa/deliveroo-js-sdk').IOCrate[]} [sensedCrates=[]] - Crates currently visible.
 */
export function updateBeliefs(sensedParcels, sensedAgents, sensedCrates = []) {
    const now = Date.now();

    // Parcels.
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

    // Agents.
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

    // Crates persist until their tile is observed empty.
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
        // Same crate id on another tile means this record is stale.
        if (c.id != null && seenCrateIds.has(c.id)) {
            beliefs.crates.delete(key);
            continue;
        }
        if (unlimitedView || (meKnown && manhattanDistance(beliefs.me, c) < view)) {
            beliefs.crates.delete(key);
        }
    }

    // A remembered crate on our own tile is stale.
    if (meKnown) {
        beliefs.crates.delete(`${Math.round(beliefs.me.x)},${Math.round(beliefs.me.y)}`);
    }
}

/**
 * Suppresses a parcel claimed by another agent so we stop chasing it.
 * @param {string} parcelId id of the parcel to suppress
 * @param {number} [ttlMs] how long the suppression lasts, in ms
 */
export function suppressClaimedParcel(parcelId, ttlMs = beliefs.config.CLAIMED_PARCEL_SUPPRESS_MS) {
    if (!parcelId) return;
    claimedParcelSuppressions.set(parcelId, Date.now() + ttlMs);
    beliefs.parcels.delete(parcelId);
}

/** Suppresses a parcel that this agent intentionally dropped for a handoff.
 *  Unlike suppressClaimedParcel, this suppression is NOT cleared when the
 *  sensing shows the parcel unclaimed. A must not re-pick its own drop. */
export function suppressHandoffDrop(parcelId, ttlMs = beliefs.config.CLAIMED_PARCEL_SUPPRESS_MS) {
    if (!parcelId) return;
    const expiresAt = Date.now() + ttlMs;
    handoffDroppedParcels.set(parcelId, expiresAt);
    claimedParcelSuppressions.set(parcelId, expiresAt);
    beliefs.parcels.delete(parcelId);
}

/**
 * Clears active parcel suppressions so parcels can be considered again.
 * @param {{ includeHandoffDrops?: boolean }} [options] whether to also clear our own handoff drops
 */
export function clearParcelSuppressions({ includeHandoffDrops = false } = {}) {
    claimedParcelSuppressions.clear();
    // Optionally also drop our own handoff drops.
    if (includeHandoffDrops) handoffDroppedParcels.clear();
}

/**
 * Tells whether a parcel is currently suppressed and should be ignored.
 * @param {string} parcelId id of the parcel to check
 * @param {number} [now] reference timestamp in ms
 * @returns {boolean} true while the suppression is still active
 */
function isParcelSuppressed(parcelId, now = Date.now()) {
    if (isHandoffDropSuppressed(parcelId, now)) return true;
    const expiresAt = claimedParcelSuppressions.get(parcelId);
    if (!expiresAt) return false;
    // Expired suppression: drop it and treat the parcel as available again.
    if (expiresAt <= now) {
        claimedParcelSuppressions.delete(parcelId);
        return false;
    }
    return true;
}

/**
 * Tells whether a parcel is suppressed because we dropped it for a handoff.
 * @param {string} parcelId id of the parcel to check
 * @param {number} [now] reference timestamp in ms
 * @returns {boolean} true while the handoff-drop suppression is still active
 */
function isHandoffDropSuppressed(parcelId, now = Date.now()) {
    const expiresAt = handoffDroppedParcels.get(parcelId);
    if (!expiresAt) return false;
    // Expired: clear it and the matching claimed-suppression entry.
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

/**
 * Decays each free parcel by one reward point, removing those that hit zero.
 */
export function decayParcelsReward() {
    for (const [id, p] of beliefs.parcels) {
        if (p.carriedBy !== null) continue; // carried parcels aren't decayed locally
        const newReward = p.reward - 1;
        if (newReward <= 0) {
            beliefs.parcels.delete(id);
        } else {
            beliefs.parcels.set(id, { ...p, reward: newReward });
        }
    }
}

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
 * Removes a cell from the permanent blacklist.
 * @param {number} x
 * @param {number} y
 */
export function unblacklistCell(x, y) {
    beliefs.blacklist.delete(`${x},${y}`);
}

/**
 * Tells whether a cell is blacklisted, permanently or temporarily.
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isBlacklisted(x, y) {
    const key = `${x},${y}`;

    if (beliefs.blacklist.has(key)) return true;

    const expiresAt = beliefs.temporaryBlacklist.get(key);
    if (!expiresAt) return false;

    // Expired temporary entry: drop it and treat the cell as free.
    if (Date.now() > expiresAt) {
        beliefs.temporaryBlacklist.delete(key);
        return false;
    }

    return true;
}

/**
 * Clears all blacklisted cells, both permanent and temporary.
 */
export function clearBlacklist() {
    beliefs.blacklist.clear();
    beliefs.temporaryBlacklist.clear();
}

export { isWalkable, canEnter, canTraverse, canPush } from './grid.js';
// Re-exported for the many call sites that historically imported it from here.
export { manhattanDistance };
