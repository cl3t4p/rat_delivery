// Ad-hoc harness for the codegen policy: the LLM writes chooseIntention() once,
// we run the cached compiled policy on a few seeded scenarios.
// Run with: node scripts/test-llm-policy.mjs
import 'dotenv/config';
import { beliefs } from '../src/bdi/beliefs.js';
import { generateBestIntentionFromPolicy } from '../src/llm/policyAgent.js';

// Build a 5x5 map: floor everywhere, a wall, a spawner, two delivery tiles.
const tiles = [];
for (let x = 0; x < 5; x++) {
    for (let y = 0; y < 5; y++) {
        let type = '3'; // floor
        if (x === 2 && y === 2) type = '0'; // wall in the middle
        if (x === 0 && y === 0) type = '2'; // delivery
        if (x === 4 && y === 4) type = '2'; // delivery
        if (x === 4 && y === 0) type = '1'; // spawner
        tiles.push({ x, y, type });
    }
}
beliefs.grid.clear();
beliefs.deliveryTiles = [];
for (const t of tiles) {
    beliefs.grid.set(`${t.x},${t.y}`, { type: t.type, delivery: t.type === '2' });
    if (t.type === '2') beliefs.deliveryTiles.push({ x: t.x, y: t.y });
}

beliefs.me.id = 'tester';
beliefs.me.x = 1;
beliefs.me.y = 1;
beliefs.me.carrying = [];
beliefs.config.PARCEL_GENERATION_INTERVAL = 2000;

const scenarios = [
    {
        name: 'two free parcels, not carrying (near=5 vs rich=40)',
        fn: () => {
            beliefs.parcels.clear();
            beliefs.me.carrying = [];
            beliefs.parcels.set('p_near', {
                id: 'p_near',
                x: 1,
                y: 2,
                reward: 5,
                carriedBy: null,
                lastSeen: Date.now(),
            });
            beliefs.parcels.set('p_rich', {
                id: 'p_rich',
                x: 3,
                y: 3,
                reward: 40,
                carriedBy: null,
                lastSeen: Date.now(),
            });
        },
    },
    {
        name: 'carrying a parcel, none on the floor',
        fn: () => {
            beliefs.parcels.clear();
            beliefs.parcels.set('p_held', {
                id: 'p_held',
                x: 1,
                y: 1,
                reward: 20,
                carriedBy: 'tester',
                lastSeen: Date.now(),
            });
            beliefs.me.carrying = ['p_held'];
        },
    },
    {
        name: 'nothing around, slow generation (10s)',
        fn: () => {
            beliefs.parcels.clear();
            beliefs.me.carrying = [];
            beliefs.config.PARCEL_GENERATION_INTERVAL = 10000;
        },
    },
];

for (const s of scenarios) {
    s.fn();
    const start = Date.now();
    const intention = await generateBestIntentionFromPolicy();
    const ms = Date.now() - start;
    console.log(
        `\n=== ${s.name} ===\n` +
            `→ ${intention.type}` +
            (intention.parcelId ? ` parcel=${intention.parcelId}` : '') +
            (intention.targetPos ? ` target=(${intention.targetPos.x},${intention.targetPos.y})` : '') +
            ` score=${intention.score} (${ms}ms)`
    );
}
