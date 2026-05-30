/**
 * types.js — Shared JSDoc type definitions for all project modules.
 */


// Movement

/** @typedef {{ x: number, y: number }} Position */

/** @typedef {'up'|'down'|'left'|'right'} Direction */

/**
 * @typedef {Object} PathResult
 * @property {Position[]} path - Array of tiles from the tile immediately after the start position up to and including the goal.
 * @property {Direction[]} moves - Sequence of moves to execute.
 */

// Tile / Map
/** @typedef {{ type: '0'|'1'|'2'|'3', delivery: boolean }} Tile */

/**
 * @typedef {Object} Parcel
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} reward - Reward value, updated locally according to decay.
 * @property {string|null} carriedBy - `null` if the parcel is free, otherwise the `agent.id` of the carrier.
 * @property {number} lastSeen - `Date.now()` timestamp of the last sensing update.
 */

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} [name]
 * @property {number} x
 * @property {number} y
 * @property {number} [score]
 * @property {number} lastSeen
 * @property {boolean} stale - `true` if no longer in the field of view.
 */

/**
 * @typedef {Object} Me
 * @property {string|null} id
 * @property {string|null} name
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} score
 * @property {string[]} carrying - Array of `parcel.id` values currently being carried.
 */

/**
 * @typedef {Object} GameConfig
 * @property {number|null} PARCEL_DECADING_INTERVAL
 * @property {number|null} OBSERVATION_DISTANCE
 */

/**
 * Internal belief store of the agent.
 *
 * @typedef {Object} BeliefStore
 * @property {Map<string, Tile>} grid - Known map tiles, keyed by `"x,y"`.
 * @property {Map<string, Parcel>} parcels - Known parcels, keyed by `parcel.id`.
 * @property {Map<string, Agent>} agents - Known agents, keyed by `agent.id`.
 * @property {Me} me - State of the agent itself.
 * @property {Position[]} deliveryTiles - Cached delivery tile positions.
 * @property {GameConfig} config - Game constants received from the server.
 */

/**
 * @typedef {Object} Intention
 * @property {'go_pick_up'|'go_deliver'|'explore'|'wait'} type
 * @property {string|null} parcelId
 * @property {Position|null} targetPos
 * @property {Direction[]} plan - Sequence of moves
 * @property {'pending'|'active'|'done'|'failed'} status
 * @property {number} createdAt - `Date.now()`.
 * @property {number} score - Utility value
 */

export {};
