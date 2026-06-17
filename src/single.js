/**
 * Single-agent entrypoint with A* planning enabled.
 */

import 'dotenv/config';

process.env.USE_PDDL = 'false';

const { startSingleAgent } = await import('./agent/runtime.js');
startSingleAgent({ tag: 'single', token: process.env.TOKEN });
