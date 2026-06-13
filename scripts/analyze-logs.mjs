import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);

if (files.length === 0) {
    console.error('Usage: node scripts/analyze-logs.mjs <log-file> [log-file ...]');
    process.exit(1);
}

const patterns = [
    ['deliveries', /Delivery OK/g],
    ['pickups', /Pickup OK/g],
    ['moveFailed', /Move failed/g],
    ['blacklists', /Temporary blacklist/g],
    ['rightOfWay', /Right-of-way/g],
    ['socketFailures', /Socket action failed/g],
    ['disconnects', /Disconnected from|Socket disconnected/g],
    ['llmFailures', /Zone assignment failed|LLM unavailable|LLM cooldown active/g],
    ['parcelTaken', /Parcel .* taken by/g],
    ['pickupEmpty', /Empty pickup/g],
    ['putdownEmpty', /Empty putdown/g],
    ['stackErrors', /^Error:|UnhandledPromiseRejection|TypeError:|ReferenceError:/gm],
];

for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const summary = Object.fromEntries(
        patterns.map(([name, regex]) => [name, count(text, regex)])
    );

    const finalScore =
        lastMatch(text, /Delivery OK:.*score=(\d+)/g) ??
        lastMatch(text, /\[state_[ab]\].*score=(\d+)/g);
    const firstTs = firstMatch(text, /^\[(\d\d:\d\d:\d\d\.\d\d\d)\]/m);
    const lastTs = lastMatch(text, /^\[(\d\d:\d\d:\d\d\.\d\d\d)\]/gm);

    console.log(path.basename(file));
    if (firstTs && lastTs) console.log(`  window: ${firstTs} → ${lastTs}`);
    if (finalScore) console.log(`  finalScore: ${finalScore}`);
    for (const [key, value] of Object.entries(summary)) {
        console.log(`  ${key}: ${value}`);
    }
}

function count(text, regex) {
    return [...text.matchAll(regex)].length;
}

function firstMatch(text, regex) {
    const match = regex.exec(text);
    return match?.[1] ?? null;
}

function lastMatch(text, regex) {
    let last = null;
    for (const match of text.matchAll(regex)) last = match[1];
    return last;
}
