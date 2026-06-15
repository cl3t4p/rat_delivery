/**
 * single.js — single A* / LLM agent entrypoint
 *
 * A standalone single agent (no multi-agent layer) that plans movement with A*.
 * Set USE_LLM=true to let the LLM choose intentions instead of the deterministic
 * heuristic (`USE_LLM=true node src/single.js`); planning stays on A* either way.
 *
 * PDDL is explicitly off here (see src/pddl.js for the PDDL variant). The runtime
 * is imported dynamically so the env var below is set before the BDI modules,
 * which read the planning/deliberation mode at load time, are evaluated.
 */

import 'dotenv/config';

// This entrypoint never uses the PDDL solver.
process.env.USE_PDDL = 'false';

const { startSingleAgent } = await import('./agent/runtime.js');
startSingleAgent({ tag: 'single', token: process.env.TOKEN });
