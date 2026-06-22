/**
 * agent/common.js
 *
 * Shared bootstrap utilities.
 */

import { beliefs, decayParcelsReward, clockEventToMs } from '../bdi/beliefs.js';
import { getCurrentIntention } from '../bdi/intentionRevision.js';

export const REVISE_HEARTBEAT_MS = Number(process.env.REVISE_HEARTBEAT_MS) || 200;

const BLACKLIST_LOG = (process.env.BLACKLIST_LOG ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** True when a log line should be muted. */
function isLogBlacklisted(...args) {
    const first = args[0];
    if (typeof first !== 'string') return false;
    return BLACKLIST_LOG.some((prefix) => first.startsWith(prefix));
}

/** Adds HH:MM:SS.mmm to console output. */
export function installTimestampedConsole() {
    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);
    const ts = () => `[${new Date().toISOString().slice(11, 23)}]`;
    console.log = (...a) => {
        if (isLogBlacklisted(...a)) return;
        _log(ts(), ...a);
    };
    console.warn = (...a) => _warn(ts(), ...a);
    console.error = (...a) => _error(ts(), ...a);
}

/**
 * Applies the server config to beliefs.config.
 * @param {string} tag - Log tag identifying the agent.
 * @param {import('@unitn-asa/deliveroo-js-sdk/client').IOConfig} config
 * @throws {Error} 
 */
export function applyConfig(tag, config) {
    const game = config?.GAME;
    if (!game?.player) throw new Error(`[${tag}] Missing config.GAME.player`);
    if (!game?.parcels) throw new Error(`[${tag}] Missing config.GAME.parcels`);

    beliefs.config.PARCEL_DECADING_INTERVAL = clockEventToMs(game.parcels.decaying_event);
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(game.parcels.generation_event);
    beliefs.config.OBSERVATION_DISTANCE = game.player.observation_distance;
    beliefs.config.MAX_PARCELS = game.player.capacity;
    beliefs.config.MS_PER_STEP = game.player.movement_duration;

    console.log(`[${tag}] Config:`, beliefs.config);
}

/** Starts local parcel reward decay. 
 * @param {number} decay
*/
export function startDecayLoop(decay) {
    setInterval(() => decayParcelsReward(), decay);
}

/** Logs the known grid as an ASCII map. */
export function logMapGrid(tiles) {
    const maxX = tiles.reduce((m, t) => (t.x > m ? t.x : m), 0);
    const maxY = tiles.reduce((m, t) => (t.y > m ? t.y : m), 0);

    for (let y = maxY; y >= 0; y--) {
        let row = '';
        for (let x = 0; x <= maxX; x++) {
            const t = beliefs.grid.get(`${x},${y}`);
            row += (t ? t.type : '.') + ' ';
        }
        console.log(`y=${y}: ${row}`);
    }
}

/**
 * Creates a state logger with local change detection.
 *
 * @param {string} label
 * @returns {() => void}
 */
export function makeLogState(label) {
    const last = { x: null, y: null, score: -1, carrying: -1, type: null, parcelId: null };

    return function logState() {
        const intention = getCurrentIntention();
        const x = beliefs.me.x !== null ? Math.round(beliefs.me.x) : null;
        const y = beliefs.me.y !== null ? Math.round(beliefs.me.y) : null;
        const score = beliefs.me.score ?? 0;
        const carrying = beliefs.me.carrying.length;
        const type = intention?.type ?? 'none';
        const parcelId = intention?.parcelId ?? null;

        if (
            x === last.x &&
            y === last.y &&
            score === last.score &&
            carrying === last.carrying &&
            type === last.type &&
            parcelId === last.parcelId
        )
            return;

        last.x = x;
        last.y = y;
        last.score = score;
        last.carrying = carrying;
        last.type = type;
        last.parcelId = parcelId;

        console.log(
            `[${label}] pos=(${beliefs.me.x?.toFixed(1)},${beliefs.me.y?.toFixed(1)})`,
            `score=${score}`,
            `carrying=${carrying}`,
            `parcels=${beliefs.parcels.size}`,
            `intention=${type}`,
            parcelId ? `-> ${parcelId}` : ''
        );
    };
}
