/**
 * run-trial-two-agents.mjs
 *
 * Runs index_a.js and index_b.js in parallel for a fixed duration,
 * saves separate logs for each, and prints a combined summary.
 *
 * Usage:
 *   node scripts/run-trial-two-agents.mjs [map-name] [duration-seconds]
 *
 * Examples:
 *   node scripts/run-trial-two-agents.mjs circuit 180
 *   node scripts/run-trial-two-agents.mjs small_paths 120
 *   node scripts/run-trial-two-agents.mjs          # "run" and 90s defaults
 *
 * Output:
 *   logs/<map>-A-<ts>.log   — Agent A stdout+stderr
 *   logs/<map>-B-<ts>.log   — Agent B stdout+stderr
 */

import { spawn }            from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath }    from 'node:url';
import { dirname, join }    from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const LOGS_DIR  = join(ROOT, 'logs');

const mapName  = process.argv[2] ?? 'run';
const duration = Number(process.argv[3] ?? 90) * 1000;

mkdirSync(LOGS_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── Agent launcher ────────────────────────────────────────────────────────────

function launchAgent(label, script, extraEnv = {}) {
    const logFile   = join(LOGS_DIR, `${mapName}-${label}-${ts}.log`);
    const logStream = createWriteStream(logFile);

    const child = spawn('node', [script], {
        cwd: ROOT,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = {
        label,
        logFile,
        connected:   false,
        deliveries:  0,
        pickups:     0,
        stuckEvents: 0,
        moveFailed:  0,
        stackErrors: 0,
        disconnects: 0,
        socketFails: 0,
        finalScore:  0,
    };

    function onChunk(chunk) {
        const text = chunk.toString();
        logStream.write(text);

        if (!state.connected && /\[beliefs\] Map:|Connected/.test(text)) {
            state.connected = true;
        }

        state.deliveries  += (text.match(/Delivery OK/g)              ?? []).length;
        state.pickups     += (text.match(/Pickup OK/g)                ?? []).length;
        state.stuckEvents += (text.match(/Stuck:/g)                   ?? []).length;
        state.moveFailed  += (text.match(/Move failed/g)              ?? []).length;
        state.stackErrors += (text.match(/UnhandledPromiseRejection|TypeError:|ReferenceError:/g) ?? []).length;
        state.disconnects += (text.match(/Socket disconnected/g) ?? []).length;
        state.socketFails += (text.match(/Socket action failed/g)     ?? []).length;

        const scoreMatch = text.match(/score=(\d+)/g);
        if (scoreMatch) {
            const last = scoreMatch[scoreMatch.length - 1].match(/\d+/);
            if (last) state.finalScore = Number(last[0]);
        }
    }

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    const logDone = new Promise((resolve) => {
        logStream.on('finish', resolve);
    });

    child.on('exit', () => logStream.end());

    return { child, state, logDone };
}

// ── Launch both agents ────────────────────────────────────────────────────────

console.log(`[trial-2] map=${mapName}  duration=${duration / 1000}s`);
console.log(`[trial-2] logs → ${LOGS_DIR}/${mapName}-{A,B}-${ts}.log\n`);

const agentA = launchAgent('A', 'src/index_a.js');
const agentB = launchAgent('B', 'src/index_b.js');

// ── Shutdown after duration ───────────────────────────────────────────────────

function killBoth() {
    agentA.child.kill('SIGTERM');
    agentB.child.kill('SIGTERM');
}

const timer = setTimeout(killBoth, duration);

// If either agent crashes early, kill the other and report immediately.
let exited = 0;
function onExit(label) {
    exited++;
    if (exited === 1) {
        // First exit — give the other agent 2 s to flush its log.
        setTimeout(() => {
            clearTimeout(timer);
            killBoth();
        }, 2000);
    }
    if (exited === 2) {
        printSummary().catch((err) => {
            console.error(`[trial-2] summary failed: ${err?.message ?? err}`);
            process.exit(1);
        });
    }
}

agentA.child.on('exit', () => onExit('A'));
agentB.child.on('exit', () => onExit('B'));

// ── Summary ───────────────────────────────────────────────────────────────────

function verdict(state, durationSec) {
    const mfPerMin = (state.moveFailed / (durationSec / 60));
    const fails = [];
    const warnings = [];

    if (!state.connected)          fails.push('never connected');
    if (state.stackErrors > 0)     fails.push(`stackErrors=${state.stackErrors}`);
    if (state.disconnects > 0)     fails.push(`disconnects=${state.disconnects}`);
    if (state.socketFails > 0)     fails.push(`socketFailures=${state.socketFails}`);
    if (mfPerMin > 300)            fails.push(`moveFailed=${mfPerMin.toFixed(0)}/min`);

    if (state.deliveries === 0) {
        if (durationSec >= 90) fails.push('deliveries=0');
        else warnings.push('deliveries=0 on short smoke run');
    }
    if (state.finalScore === 0) {
        if (durationSec >= 90) fails.push('score=0');
        else warnings.push('score=0 on short smoke run');
    }

    if (fails.length > 0) return `FAIL (${fails.join(', ')})`;
    if (warnings.length > 0) return `WARN (${warnings.join(', ')})`;
    return 'PASS';
}

async function printSummary() {
    await Promise.all([agentA.logDone, agentB.logDone]);

    const durationSec = duration / 1000;
    const line = '─'.repeat(56);

    refreshStateFromLog(agentA.state);
    refreshStateFromLog(agentB.state);

    console.log(`\n${line}`);
    console.log(`[trial-2] SUMMARY  map=${mapName}  duration=${durationSec}s`);
    console.log(line);

    for (const { state } of [agentA, agentB]) {
        const mfPerMin = (state.moveFailed / (durationSec / 60)).toFixed(0);
        const delivRate = (state.deliveries / (durationSec / 60)).toFixed(2);
        console.log(`\n  Agent ${state.label}:`);
        console.log(`    connected:    ${state.connected ? 'yes' : 'NO — check HOST/TOKEN'}`);
        console.log(`    score:        ${state.finalScore}`);
        console.log(`    deliveries:   ${state.deliveries}  (${delivRate}/min)`);
        console.log(`    pickups:      ${state.pickups}`);
        console.log(`    stuck events: ${state.stuckEvents}`);
        console.log(`    moveFailed:   ${state.moveFailed}  (${mfPerMin}/min)`);
        console.log(`    stackErrors:  ${state.stackErrors}`);
        console.log(`    disconnects:  ${state.disconnects}`);
        console.log(`    socketFails:  ${state.socketFails}`);
        console.log(`    log:          ${state.logFile}`);
        console.log(`    verdict:      ${verdict(state, durationSec)}`);
    }

    console.log(`\n${line}`);

    // Detailed per-file analysis via analyze-logs.mjs
    console.log('\n[trial-2] detailed analysis:\n');
    const analyzer = spawn(
        'node',
        ['scripts/analyze-logs.mjs', agentA.state.logFile, agentB.state.logFile],
        { cwd: ROOT, stdio: 'inherit' }
    );
    analyzer.on('exit', (code) => process.exit(code ?? 0));
}

function refreshStateFromLog(state) {
    const text = readFileSync(state.logFile, 'utf8');
    state.deliveries = count(text, /Delivery OK/g);
    state.pickups = count(text, /Pickup OK/g);
    state.stuckEvents = count(text, /Stuck:/g);
    state.moveFailed = count(text, /Move failed/g);
    state.stackErrors = count(text, /UnhandledPromiseRejection|TypeError:|ReferenceError:/g);
    state.disconnects = count(text, /Socket disconnected/g);
    state.socketFails = count(text, /Socket action failed/g);

    const finalScore =
        lastMatch(text, /Delivery OK:.*score=(\d+)/g) ??
        lastMatch(text, /\[state_[ab]\].*score=(\d+)/g);
    if (finalScore !== null) state.finalScore = Number(finalScore);
}

function count(text, regex) {
    return [...text.matchAll(regex)].length;
}

function lastMatch(text, regex) {
    let last = null;
    for (const match of text.matchAll(regex)) last = match[1];
    return last;
}
