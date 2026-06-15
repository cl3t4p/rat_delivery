/**
 * Level 7 — Integrazione live
 *
 * Spawns index_a.js as a child process and verifies it connects and emits
 * expected log lines within a timeout. Skipped when HOST or TOKEN is not set.
 *
 * Run with:
 *   node --test test/07-integration.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const HAS_HOST  = !!process.env.HOST || !!process.env.DELIVEROO_HOST;
const HAS_TOKEN = !!process.env.TOKEN;
const CAN_RUN   = HAS_HOST && HAS_TOKEN;

function skipIf(condition, message) {
    if (condition) { console.log(`  [SKIP] ${message}`); return true; }
    return false;
}

// ── agent startup ─────────────────────────────────────────────────────────────

test('integration – agent-a starts, connects, and processes at least one sensing event', { timeout: 20000 }, async () => {
    if (skipIf(!CAN_RUN, 'HOST or TOKEN not set in .env')) return;

    await new Promise((resolve, reject) => {
        const child = spawn('node', ['src/index_a.js'], {
            cwd: ROOT,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        let resolved = false;

        function done(err) {
            if (resolved) return;
            resolved = true;
            child.kill('SIGTERM');
            if (err) reject(err);
            else resolve();
        }

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            output += text;
            // A successful connection always logs one of these lines
            if (
                output.includes('[beliefs] Map:') ||
                output.includes('[intentionRevision] New:') ||
                output.includes('[deliberation]')
            ) {
                done(null);
            }
        });

        child.stderr.on('data', (chunk) => {
            output += chunk.toString();
        });

        child.on('exit', (code) => {
            if (!resolved) {
                done(new Error(`Agent exited early with code ${code}.\nOutput:\n${output}`));
            }
        });

        // Hard timeout
        setTimeout(() => {
            if (!resolved) {
                done(new Error(`Agent did not produce expected log within timeout.\nOutput:\n${output.slice(-500)}`));
            }
        }, 15000);
    });
});

// ── no crash on bad token ─────────────────────────────────────────────────────

test('integration – agent-a exits cleanly when given an invalid token', { timeout: 8000 }, async () => {
    if (skipIf(!HAS_HOST, 'HOST / DELIVEROO_HOST not set')) return;

    await new Promise((resolve) => {
        const child = spawn('node', ['src/index_a.js'], {
            cwd: ROOT,
            env: { ...process.env, TOKEN: 'invalid-token-xyz' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let output = '';
        child.stdout.on('data', (c) => { output += c.toString(); });
        child.stderr.on('data', (c) => { output += c.toString(); });

        // Just give it a few seconds then kill — we're verifying it doesn't throw
        // an unhandled exception that prints an ugly stack (no crash = pass)
        setTimeout(() => {
            child.kill('SIGTERM');
            // Check no unhandled rejection / error
            const hasUncaught = output.includes('UnhandledPromiseRejection') ||
                                  output.includes('UnhandledRejection');
            assert.ok(!hasUncaught, `Unhandled rejection detected:\n${output.slice(-300)}`);
            resolve();
        }, 4000);
    });
});
