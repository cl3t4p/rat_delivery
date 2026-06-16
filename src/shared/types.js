/**
 * types.js — Shared JSDoc type definitions for all project modules.
 */

// Single Objects

/** @typedef {{ x: number, y: number }} Position */

/** @typedef {'up'|'down'|'left'|'right'} Direction */

/** @typedef {'go_pick_up'|'go_deliver'|'go_putdown'|'explore'|'go_to'|'wait'|'go_handoff'|'go_handoff_receive'} IntentionType */

/** @typedef {{ type: '0'|'1'|'2'|'3', delivery: boolean }} Tile */

/**
 * @typedef {Object} PathResult
 * @property {Position[]} path - Array of tiles from the tile immediately after the start position up to and including the goal.
 * @property {Direction[]} moves - Sequence of moves to execute.
 */

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
 * @property {IntentionType} type
 * @property {string|null} parcelId
 * @property {Position|null} targetPos
 * @property {Direction[]} plan - Sequence of moves
 * @property {'pending'|'active'|'done'|'failed'} status
 * @property {number} createdAt - `Date.now()`.
 * @property {number} score - Utility value
 */

// Multi-agent message protocol

/** @typedef {'belief_update'|'intention_update'|'request'|'response'|'zone_assign'|'handoff_request'|'handoff_response'|'blocked_at'|'parcel_claimed'} MsgType */

/** @typedef {'take_parcel'|'avoid_tile'|'status_check'} RequestAction */

/**
 * Common message envelope used for every BDI ↔ LLM message.
 *
 * @template {object} [P=object]
 * @typedef {Object} Envelope
 * @property {string|null} from - Sender id (`beliefs.me.id`), or `null` if unknown at send time.
 * @property {string|'broadcast'} to - Recipient id, or the literal `'broadcast'` for shouts.
 * @property {MsgType} type
 * @property {number} ts - `Date.now()` — also used as the message id for request/response correlation.
 * @property {P} payload
 */

/**
 * Slim parcel snapshot sent inside a `belief_update` payload.
 *
 * @typedef {Object} ParcelDelta
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} reward
 * @property {string|null} carriedBy
 */

/**
 * Slim agent snapshot sent inside a `belief_update` payload.
 *
 * @typedef {Object} AgentDelta
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {boolean} stale
 */

/**
 * Slim self snapshot sent inside a `belief_update` payload.
 *
 * @typedef {Object} MeDelta
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} carrying - Number of parcels being carried.
 * @property {number} score - Current total score.
 */

/**
 * @typedef {Object} BeliefUpdatePayload
 * @property {ParcelDelta[]} parcels - Only newly seen / changed parcels.
 * @property {AgentDelta[]} agents - Only changed agents (new, moved, stale flip).
 * @property {MeDelta} me - Own current position and carrying count.
 */

/**
 * @typedef {Object} IntentionUpdatePayload
 * @property {Object} intention
 * @property {IntentionType} intention.type
 * @property {string|null} intention.parcelId
 * @property {Position|null} intention.targetPos
 * @property {'pending'|'active'|'done'|'failed'} intention.status
 */

/**
 * @typedef {Object} RequestPayload
 * @property {RequestAction} action
 * @property {string} [parcelId] - Required for `take_parcel`.
 * @property {Position} [tile] - Required for `avoid_tile`.
 */

/**
 * @typedef {Object} ResponsePayload
 * @property {number} requestId - `ts` of the request being answered.
 * @property {boolean} accepted
 * @property {'ok'|'already_carrying'|'out_of_range'|'unknown'} reason
 */

export {};
