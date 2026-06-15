/**
 * multiagent_b.js — Agent B entrypoint.
 *
 * BDI + LLM coordinator: runs the same BDI loop as Agent A, plus maintains LLM
 * context, receives natural-language objectives, and owns the zone-assignment
 * loop. Connects with TOKEN_B. All wiring is shared in agent/multi.js; this file
 * only selects the role.
 */

import 'dotenv/config';
import { startMultiAgent } from './agent/multi.js';

startMultiAgent({ role: 'b', token: process.env.TOKEN_B });
