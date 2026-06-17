/**
 * Single-agent entrypoint with PDDL planning enabled.
 */

import 'dotenv/config';

process.env.USE_PDDL = 'true';

const { startSingleAgent } = await import('./agent/runtime.js');
startSingleAgent({ tag: 'pddl', token: process.env.TOKEN });
