/**
 * send-msg.mjs
 *
 * Connects to the Deliveroo server as Agent A and shouts a plain-text
 * message to all agents. Agent B receives it via onFallbackMsg → setObjective.
 *
 * Usage (server must be running, Agent B must be running):
 *   node scripts/send-msg.mjs "Focus on the top-left spawners"
 *   node scripts/send-msg.mjs "avoid cell 3,4"
 *
 * Do NOT run this while Agent A is already connected — same token.
 */

import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import 'dotenv/config';

const message = process.argv.slice(2).join(' ');

if (!message) {
    console.error('Usage: node scripts/send-msg.mjs "<message>"');
    process.exit(1);
}

if (!process.env.HOST || !process.env.TOKEN) {
    console.error('Missing HOST or TOKEN in .env');
    process.exit(1);
}

const socket = DjsConnect(process.env.HOST, process.env.TOKEN);

socket.on('connect', async () => {
    console.log(`[send-msg] Connected — shouting: "${message}"`);
    try {
        await socket.emitShout(message);
        console.log('[send-msg] Sent.');
    } catch (err) {
        console.error(`[send-msg] Failed: ${err?.message ?? err}`);
    }
    // Give server a moment to route the message before disconnecting.
    setTimeout(() => {
        socket.disconnect();
        process.exit(0);
    }, 500);
});

socket.on('connect_error', (err) => {
    console.error(`[send-msg] Connection failed: ${err?.message ?? err}`);
    process.exit(1);
});
