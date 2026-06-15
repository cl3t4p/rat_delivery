/**
 * multiagent_a.js — Agent A entrypoint.
 *
 * Plain BDI agent: senses, revises beliefs/intentions, executes, communicates with
 * Agent B and may accept zone assignments from it. No LLM. All wiring is shared in
 * agent/multi.js; this file only selects the role.
 */

import 'dotenv/config';
import { startMultiAgent } from './agent/multi.js';

startMultiAgent({ role: 'a', token: process.env.TOKEN_A });
