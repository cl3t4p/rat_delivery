/**
 * Agent A entrypoint.
 */

import 'dotenv/config';
import { startMultiAgent } from './agent/multi.js';

startMultiAgent({ role: 'a', token: process.env.TOKEN_A });
