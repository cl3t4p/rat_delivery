/**
 * Agent B entrypoint.
 */

import 'dotenv/config';
import { startMultiAgent } from './agent/multi.js';

startMultiAgent({ role: 'b', token: process.env.TOKEN_B });
