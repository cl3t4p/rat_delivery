/**
 * pddl.js — single PDDL agent entrypoint
 *
 * A standalone single agent (no multi-agent layer) that plans every movement with
 * the external PDDL solver instead of A*.
 *
 * USE_PDDL is forced on HERE, before the BDI modules are imported. Those modules
 * read process.env.USE_PDDL at load time, so the agent runtime is imported
 * dynamically (after the env var is set) — a static import would be hoisted and
 * evaluated first, leaving the BDI core in A* mode.
 */

import 'dotenv/config';

// This entrypoint is PDDL by definition.
process.env.USE_PDDL = 'true';

const { startSingleAgent } = await import('./agent/runtime.js');
startSingleAgent({ tag: 'pddl' });
