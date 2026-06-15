/**
 * run-trial.mjs
 *
 * Runs index_a.js for a fixed duration, saves the log, and prints a summary.
 *
 * Usage:
 *   node scripts/run-trial.mjs [map-name] [duration-seconds]
 *
 * Examples:
 *   node scripts/run-trial.mjs map1 90
 *   node scripts/run-trial.mjs diamond
 *   node scripts/run-trial.mjs          # uses "run" and 90s defaults
 */

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const LOGS_DIR  = join(ROOT, 'logs');

const mapName  = process.argv[2] ?? 'run';
const duration = Number(process.argv[3] ?? 90) * 1000;

mkdirSync(LOGS_DIR, { recursive: true });

const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = join(LOGS_DIR, `${mapName}-${ts}.log`);
const logStream = createWriteStream(logFile);

console.log(`[trial] map=${mapName} duration=${duration / 1000}s`);
console.log(`[trial] log → ${logFile}`);
console.log('[trial] starting agent...\n');

const child = spawn('node', ['src/index_a.js'], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
});

let connected = false;
let deliveries = 0;
let stuckEvents = 0;
let pickups = 0;

child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    process.stdout.write(text);

    if (!connected && (text.includes('[beliefs] Map:') || text.includes('[deliberation]'))) {
        connected = true;
        console.error('\n[trial] ✓ connected\n');
    }

    const delivMatches = text.match(/Delivery OK/g);
    if (delivMatches) deliveries += delivMatches.length;

    const pickupMatches = text.match(/Pickup OK/g);
    if (pickupMatches) pickups += pickupMatches.length;

    const stuckMatches = text.match(/Stuck:/g);
    if (stuckMatches) stuckEvents += stuckMatches.length;
});

child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    process.stderr.write(text);
});

// Kill after duration
setTimeout(() => {
    child.kill('SIGTERM');
}, duration);

child.on('exit', () => {
    logStream.end();

    const durationSec = duration / 1000;
    const rate = (deliveries / (durationSec / 60)).toFixed(2);

    console.log('\n' + '─'.repeat(50));
    console.log(`[trial] SUMMARY  map=${mapName}  duration=${durationSec}s`);
    console.log(`  connected:  ${connected ? 'yes' : 'NO — check HOST/TOKEN'}`);
    console.log(`  deliveries: ${deliveries}  (${rate}/min)`);
    console.log(`  pickups:    ${pickups}`);
    console.log(`  stuck:      ${stuckEvents}`);
    console.log(`  log:        ${logFile}`);
    console.log('─'.repeat(50));

    // Detailed analysis via analyze-logs.mjs
    console.log('\n[trial] detailed analysis:\n');
    const analyzer = spawn('node', ['scripts/analyze-logs.mjs', logFile], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    analyzer.on('exit', (code) => process.exit(code ?? 0));
});
