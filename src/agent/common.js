/**
 * agent/common.js
 *
 * Helpers shared by the single- and multi-agent bootstraps (agent/runtime.js,
 * agent/multi.js): console timestamping, config ingestion, the parcel-decay loop,
 * the map ASCII dump, and per-agent state logging. Factored out so the bootstraps
 * don't duplicate this boilerplate.
 */

import { beliefs, decayParcelsReward, clockEventToMs } from '../bdi/beliefs.js';
import { getCurrentIntention } from '../bdi/intentionRevision.js';

/** Prepend HH:MM:SS.mmm to every console line so logs can be correlated by time. */
export function installTimestampedConsole() {
    const _log = console.log.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);
    const ts = () => `[${new Date().toISOString().slice(11, 23)}]`;
    console.log = (...a) => _log(ts(), ...a);
    console.warn = (...a) => _warn(ts(), ...a);
    console.error = (...a) => _error(ts(), ...a);
}

/** Reads the game config event into beliefs.config and logs it under `tag`. */
export function applyConfig(tag, config) {
    beliefs.config.PARCEL_DECADING_INTERVAL =
        clockEventToMs(config?.GAME?.parcels?.decaying_event) ?? null;
    beliefs.config.PARCEL_GENERATION_INTERVAL = clockEventToMs(
        config?.GAME?.parcels?.generation_event
    );
    beliefs.config.OBSERVATION_DISTANCE = config?.GAME?.player?.observation_distance ?? null;
    beliefs.config.MAX_PARCELS = config?.GAME?.player?.capacity ?? 1;

    console.log(`[${tag}] Config:`, beliefs.config);
    console.log(`[${tag}] Decay interval: ${beliefs.config.PARCEL_DECADING_INTERVAL}ms`);
}

/** Starts the 1 sec local parcel-reward decay loop. */
export function startDecayLoop() {
    setInterval(() => decayParcelsReward(), 1000);
}

/** Dumps the known grid as an ASCII map (top row first). */
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
 * Builds a state logger that only emits when something meaningful changes,
 * tagged with `label` (e.g. 'state', 'state_a', 'state_b'). Each call returns an
 * independent logger with its own change-detection memory.
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
