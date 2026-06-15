/**
 * run-map-suite.mjs
 *
 * Runs the full test suite for one map: 3 single-agent runs + 3 multi-agent runs.
 * Prints a final PASS/FAIL table across all 6 runs.
 *
 * Usage:
 *   node scripts/run-map-suite.mjs <map-name> [duration-seconds]
 *
 * Examples:
 *   node scripts/run-map-suite.mjs circuit 180
 *   node scripts/run-map-suite.mjs small_paths 120
 *
 * The server must already be running with the matching map.
 */

import { spawn }                    from 'node:child_process';
import { readdirSync, mkdirSync }   from 'node:fs';
import { fileURLToPath }            from 'node:url';
import { dirname, join }            from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const LOGS_DIR  = join(ROOT, 'logs');

const map      = process.argv[2];
const duration = process.argv[3] ?? '180';
const cleanupMs = Number(process.env.SUITE_CLEANUP_MS ?? 12000);

if (!map) {
    console.error('Usage: node scripts/run-map-suite.mjs <map-name> [duration-seconds]');
    process.exit(1);
}

function runScript(args) {
    return new Promise((resolve, reject) => {
        const child = spawn('node', args, { cwd: ROOT, stdio: 'inherit' });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.on('error', reject);
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const runs = [
    ['scripts/run-trial.mjs',            `${map}-A-run1`, duration],
    ['scripts/run-trial.mjs',            `${map}-A-run2`, duration],
    ['scripts/run-trial.mjs',            `${map}-A-run3`, duration],
    ['scripts/run-trial-two-agents.mjs', `${map}-run1`,   duration],
    ['scripts/run-trial-two-agents.mjs', `${map}-run2`,   duration],
    ['scripts/run-trial-two-agents.mjs', `${map}-run3`,   duration],
];

const etaMin = Math.ceil(((runs.length * Number(duration)) + ((runs.length - 1) * cleanupMs / 1000)) / 60);

console.log('═'.repeat(56));
console.log(`  MAP SUITE: ${map}`);
console.log(`  ${runs.length} runs × ${duration}s = ~${etaMin} min total`);
console.log(`  cleanup pause: ${cleanupMs / 1000}s between runs`);
console.log('═'.repeat(56) + '\n');

mkdirSync(LOGS_DIR, { recursive: true });

// Record which log files exist before we start, so we only analyse new ones.
const before = new Set(readdirSync(LOGS_DIR));

for (let i = 0; i < runs.length; i++) {
    const [script, ...args] = runs[i];
    const label = i < 3
        ? `single-agent run ${i + 1}/3`
        : `multi-agent  run ${i - 2}/3`;
    console.log(`\n${'─'.repeat(56)}`);
    console.log(`[suite] ${i + 1}/${runs.length}  ${label}  (${args[0]})`);
    console.log('─'.repeat(56));
    try {
        await runScript([script, ...args]);
    } catch {
        console.error('[suite] run exited with error — continuing');
    }

    if (i < runs.length - 1 && cleanupMs > 0) {
        console.log(`[suite] waiting ${cleanupMs / 1000}s for server cleanup...`);
        await sleep(cleanupMs);
    }
}

// Find log files created during this suite run.
const newLogs = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.log') && !before.has(f))
    .map((f) => join(LOGS_DIR, f));

console.log('\n' + '═'.repeat(56));
console.log('[suite] ALL RUNS COMPLETE — final analysis');
console.log('═'.repeat(56) + '\n');

if (newLogs.length === 0) {
    console.log('[suite] No new log files found.');
} else {
    await runScript(['scripts/analyze-logs.mjs', ...newLogs]);
}
