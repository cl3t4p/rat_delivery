import 'dotenv/config';
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";

const socket = DjsConnect();



/**
 * Belief revision: me, map, parcels
 */

/** @type { {id:string, name:string, x:number, y:number, score:number} } */
const me = { id: '', name: '', x: -1, y: -1, score: 0 };

socket.onYou( ({ id, name, x, y, score }) => {
    me.id = id;
    me.name = name;
    me.x = x;
    me.y = y;
    me.score = score;
} );


/** Tile types from IOTile.js: '0' wall, '1' spawner, '2' delivery, '3' walkable, '4' base, '5'/'5!' crates, arrows. */
/** @type { Map<string, {x:number, y:number, type:string}> } */
const tiles = new Map();
/** @type { {x:number, y:number}[] } */
const deliveryTiles = [];
let mapWidth = 0;
let mapHeight = 0;

function tileKey(x, y) { return `${x}_${y}`; }

function isWalkable(type) {
    if (!type) return false;
    // Walls and crates are blocked.
    if (type === '0' || type === '5' || type === '5!') return false;
    return true;
}

// Arrow tiles are one-way: entry is forbidden when moving opposite to the arrow.
// '↑' (dy=+1): cannot be entered from above (dy=-1).
const arrowVec = { '↑': [0, 1], '→': [1, 0], '↓': [0, -1], '←': [-1, 0] };
function canEnter(fromX, fromY, tile) {
    const v = arrowVec[tile.type];
    if (!v) return true;
    const dx = tile.x - fromX;
    const dy = tile.y - fromY;
    return !(dx === -v[0] && dy === -v[1]);
}

function recordTile(t) {
    tiles.set( tileKey(t.x, t.y), t );
    if ( t.type === '2' ) {
        if ( !deliveryTiles.find( d => d.x === t.x && d.y === t.y ) )
            deliveryTiles.push( { x: t.x, y: t.y } );
    }
}

socket.onMap( (width, height, tilesArray) => {
    mapWidth = width;
    mapHeight = height;
    for (const t of tilesArray) recordTile(t);
    console.log(`map ${width}x${height} with ${tilesArray.length} tiles, ${deliveryTiles.length} delivery tiles`);
} );

socket.onTile( (t) => {
    recordTile(t);
} );


/** @type { Map<string, {id:string, x:number, y:number, carriedBy?:string, reward:number}> } */
const parcels = new Map();
/** Parcels we believe we are currently carrying (kept across sensing gaps). */
const carrying = new Set();

socket.onSensing( (sensing) => {
    const seen = new Set();
    for (const p of sensing.parcels) {
        parcels.set(p.id, p);
        seen.add(p.id);
    }
    // Drop parcels we no longer sense, but keep ones we believe we carry —
    // the simulator stops reporting them once on the agent.
    for (const id of [...parcels.keys()]) {
        if (!seen.has(id) && !carrying.has(id)) parcels.delete(id);
    }
} );



/**
 * A* on the tile grid.
 * Returns an array of {x,y} from start (excluded) to goal (included), or null if unreachable.
 */
function astar(start, goal) {
    const sx = Math.round(start.x), sy = Math.round(start.y);
    const gx = Math.round(goal.x), gy = Math.round(goal.y);
    if (sx === gx && sy === gy) return [];
    if (!isWalkable(tiles.get(tileKey(gx, gy))?.type)) return null;

    const h = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    /** @type { Map<string, {x:number, y:number, g:number, f:number, parent:string|null}> } */
    const nodes = new Map();
    const open = new Set();
    const closed = new Set();

    const startKey = tileKey(sx, sy);
    nodes.set(startKey, { x: sx, y: sy, g: 0, f: h({x:sx,y:sy}, {x:gx,y:gy}), parent: null });
    open.add(startKey);

    while (open.size > 0) {
        // Pick node in open with smallest f.
        let currentKey = null;
        let bestF = Infinity;
        for (const k of open) {
            const n = nodes.get(k);
            if (n.f < bestF) { bestF = n.f; currentKey = k; }
        }
        const current = nodes.get(currentKey);

        if (current.x === gx && current.y === gy) {
            // Reconstruct path.
            const path = [];
            let k = currentKey;
            while (k !== startKey) {
                const n = nodes.get(k);
                path.unshift({ x: n.x, y: n.y });
                k = n.parent;
            }
            return path;
        }

        open.delete(currentKey);
        closed.add(currentKey);

        const neighbors = [
            { x: current.x + 1, y: current.y },
            { x: current.x - 1, y: current.y },
            { x: current.x, y: current.y + 1 },
            { x: current.x, y: current.y - 1 },
        ];

        for (const n of neighbors) {
            const nk = tileKey(n.x, n.y);
            if (closed.has(nk)) continue;
            const tile = tiles.get(nk);
            if (!tile || !isWalkable(tile.type)) continue;
            if (!canEnter(current.x, current.y, tile)) continue;

            const tentativeG = current.g + 1;
            const existing = nodes.get(nk);
            if (!existing || tentativeG < existing.g) {
                nodes.set(nk, { x: n.x, y: n.y, g: tentativeG, f: tentativeG + h(n, {x:gx,y:gy}), parent: currentKey });
                open.add(nk);
            }
        }
    }

    return null;
}

function nearestDelivery(from) {
    let best = null;
    let bestLen = Infinity;
    for (const d of deliveryTiles) {
        const path = astar(from, d);
        if (path && path.length < bestLen) { best = d; bestLen = path.length; }
    }
    return best;
}



/**
 * Options generation: pick the most promising parcel-or-delivery target.
 */
function carriedCount() {
    return carrying.size;
}

function optionsGeneration() {
    if (me.x < 0 || me.y < 0 || tiles.size === 0) return;

    // If carrying parcels, deliver to nearest delivery tile.
    if (carriedCount() > 0) {
        const d = nearestDelivery(me);
        if (d) { myAgent.push(['go_put_down', d.x, d.y]); return; }
    }

    // Otherwise, find the nearest free parcel reachable via A*.
    let bestOption = null;
    let bestLen = Infinity;
    for (const p of parcels.values()) {
        if (p.carriedBy) continue;
        const path = astar(me, { x: p.x, y: p.y });
        if (path && path.length < bestLen) {
            bestLen = path.length;
            bestOption = ['go_pick_up', p.x, p.y, p.id];
        }
    }
    if (bestOption) myAgent.push(bestOption);
}

socket.onSensing( optionsGeneration );
socket.onYou( optionsGeneration );



/**
 * Intention revision (replace) — same shape as lab4 example.
 */
class IntentionRevision {
    /** @type { IntentionDeliberation[] } */
    #queue = [];
    get intention_queue() { return this.#queue; }

    async loop() {
        while (true) {
            if (this.#queue.length > 0) {
                const intention = this.#queue[0];

                // Drop intentions whose target parcel was already picked up by someone else.
                const [verb, , , id] = intention.predicate;
                if (verb === 'go_pick_up') {
                    const p = parcels.get(id);
                    if (!p || p.carriedBy) {
                        this.#queue.shift();
                        continue;
                    }
                }

                await intention.achieve().catch( () => {} );
                this.#queue.shift();
            }
            await new Promise( res => setImmediate(res) );
        }
    }

    log(...args) { console.log(...args); }

    /** @param { [string, ...any] } predicate */
    push(predicate) {
        const last = this.#queue.at(-1);
        if (last && last.predicate.join(' ') === predicate.join(' ')) return;

        if (last) {
            const [oldVerb] = last.predicate;
            const [newVerb] = predicate;
            // Don't preempt a same-verb in-progress intention. Parcels decay every 1s,
            // so target IDs/coords flip constantly — preempting starves every move.
            // Worst case: we walk to a tile whose parcel vanished, emitPickup is a no-op,
            // and options pushes the next target naturally.
            if (oldVerb === newVerb) return;
        }

        const intention = new IntentionDeliberation(this, predicate);
        this.#queue.push(intention);
        console.log('[push]', predicate.join(' '));
        if (last) last.stop();
    }
}

const myAgent = new IntentionRevision();
myAgent.loop();



class IntentionDeliberation {
    /** @type { Plan | undefined } */
    #current_plan;
    #stopped = false;
    #started = false;
    #parent;
    #predicate;

    constructor(parent, predicate) {
        this.#parent = parent;
        this.#predicate = predicate;
    }

    get stopped() { return this.#stopped; }
    get predicate() { return this.#predicate; }

    stop() {
        this.#stopped = true;
        if (this.#current_plan) this.#current_plan.stop();
    }

    log(...args) {
        if (this.#parent && this.#parent.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }

    async achieve() {
        if (this.#started) return false;
        this.#started = true;

        for (const planClass of planLibrary) {
            if (this.stopped) throw ['stopped intention', ...this.predicate];
            if (planClass.isApplicableTo(...this.predicate)) {
                this.#current_plan = new planClass(this);
                try {
                    return await this.#current_plan.execute(...this.predicate);
                } catch (err) {
                    this.log('plan', planClass.name, 'failed:', err);
                }
            }
        }
        if (this.stopped) throw ['stopped intention', ...this.predicate];
        throw ['no applicable plan', ...this.predicate];
    }
}



/** @type { any[] } */
const planLibrary = [];

class PlanBase {
    #stopped = false;
    #parent;
    /** @type { IntentionDeliberation[] } */
    #subs = [];

    constructor(parent) { this.#parent = parent; }

    get stopped() { return this.#stopped; }
    stop() {
        this.#stopped = true;
        for (const s of this.#subs) s.stop();
    }
    log(...args) {
        if (this.#parent && this.#parent.log) this.#parent.log('\t', ...args);
        else console.log(...args);
    }
    async subIntention(predicate) {
        const sub = new IntentionDeliberation(this, predicate);
        this.#subs.push(sub);
        return sub.achieve();
    }
}


class GoPickUp extends PlanBase {
    static isApplicableTo(verb) { return verb === 'go_pick_up'; }
    async execute(_, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];
        const picked = await socket.emitPickup();
        for (const p of picked || []) carrying.add(p.id);
        return true;
    }
}


class GoPutDown extends PlanBase {
    static isApplicableTo(verb) { return verb === 'go_put_down'; }
    async execute(_, x, y) {
        if (this.stopped) throw ['stopped'];
        await this.subIntention(['go_to', x, y]);
        if (this.stopped) throw ['stopped'];
        const dropped = await socket.emitPutdown();
        for (const p of dropped || []) {
            carrying.delete(p.id);
            parcels.delete(p.id);
        }
        return true;
    }
}


class AStarMove extends PlanBase {
    static isApplicableTo(verb) { return verb === 'go_to'; }

    async execute(_, x, y) {
        while (Math.round(me.x) !== x || Math.round(me.y) !== y) {
            if (this.stopped) throw ['stopped'];

            const path = astar({ x: me.x, y: me.y }, { x, y });
            if (!path) throw 'no path';
            if (path.length === 0) return true;

            const next = path[0];
            const cx = Math.round(me.x), cy = Math.round(me.y);
            const dir = next.x > cx ? 'right'
                      : next.x < cx ? 'left'
                      : next.y > cy ? 'up'
                      : 'down';

            const moved = await socket.emitMove(dir);
            console.log('[move]', dir, '->', moved && moved.x, moved && moved.y, 'goal', x, y);
            if (!moved) {
                // Path blocked — give belief revision a chance and replan next loop.
                await new Promise( res => setTimeout(res, 100) );
                continue;
            }
            me.x = moved.x;
            me.y = moved.y;
        }
        return true;
    }
}


planLibrary.push(GoPickUp);
planLibrary.push(GoPutDown);
planLibrary.push(AStarMove);
