/**
 * types.js  —  Definizioni JSDoc condivise tra tutti i moduli.
 *
*/

// ── GEOMETRIA E MOVIMENTO ──────────────────────────────────────

/** @typedef {{ x: number, y: number }} Position */

/** @typedef {'up'|'down'|'left'|'right'} Direction */

/**
 * @typedef {Object} PathResult
 * @property {Position[]}  path   array di tile dal successivo a start fino al goal (incluso)
 * @property {Direction[]} moves  sequenza di mosse da eseguire
 */

// ── TILE / MAPPA ──────────────────────────────────────────────

/** @typedef {{ type: '0'|'1'|'2'|'3', delivery: boolean }} Tile */

// ── PARCEL ────────────────────────────────────────────────────

/**
 * @typedef {Object} Parcel
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} reward          aggiornato localmente con decay
 * @property {string|null} carriedBy  null se libero, altrimenti agent.id
 * @property {number} lastSeen        Date.now() dell'ultimo sensing
 */

// ── AGENTE AVVERSARIO ─────────────────────────────────────────

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} [name]
 * @property {number} x
 * @property {number} y
 * @property {number} [score]
 * @property {number} lastSeen
 * @property {boolean} stale          true se non più nel campo visivo
 */

// ── SE STESSO ─────────────────────────────────────────────────

/**
 * @typedef {Object} Me
 * @property {string|null} id
 * @property {string|null} name
 * @property {number|null} x
 * @property {number|null} y
 * @property {number} score
 * @property {string[]} carrying      array di parcel.id che sto trasportando
 */

// ── BELIEF STORE ──────────────────────────────────────────────

/**
 * @typedef {Object} GameConfig
 * @property {number|null} PARCEL_DECADING_INTERVAL
 * @property {number|null} OBSERVATION_DISTANCE
 */

/**
 * @typedef {Object} BeliefStore
 * @property {Map<string, Tile>}   grid           key = "x,y"
 * @property {Map<string, Parcel>} parcels        key = parcel.id
 * @property {Map<string, Agent>}  agents         key = agent.id
 * @property {Me}                  me             stato dell'agente stesso
 * @property {Position[]}          deliveryTiles  cache tile di consegna
 * @property {GameConfig}          config         costanti del gioco dal server
 */

// ── INTENTION ─────────────────────────────────────────────────

/**
 * @typedef {Object} Intention
 * @property {'go_pick_up'|'go_deliver'|'explore'|'wait'} type
 * @property {string|null}    parcelId
 * @property {Position|null}  targetPos
 * @property {Direction[]}    plan        sequenza di mosse riempita da Persona B
 * @property {'pending'|'active'|'done'|'failed'} status
 * @property {number}         createdAt   Date.now()
 * @property {number}         score       utilità calcolata da Persona A
 */

export {};
