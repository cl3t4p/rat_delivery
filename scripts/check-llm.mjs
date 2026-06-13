import 'dotenv/config';
import OpenAI from 'openai';

const baseURL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const apiKey = process.env.LITELLM_API_KEY;
const model = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';
const timeout = Number(process.env.LLM_TIMEOUT_MS) || 5000;
const maxRetries = Number(process.env.LLM_MAX_RETRIES) || 0;

if (!apiKey) {
    console.error('[llm:check] LITELLM_API_KEY missing');
    process.exit(1);
}

console.log(`[llm:check] baseURL=${baseURL}`);
console.log(`[llm:check] model=${model}`);
console.log(`[llm:check] timeout=${timeout}ms retries=${maxRetries}`);

const client = new OpenAI({
    baseURL,
    apiKey,
    timeout,
    maxRetries,
});

try {
    const started = Date.now();
    const response = await client.chat.completions.create({
        model,
        messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
        ],
        temperature: 0,
        max_tokens: 5,
    });
    const elapsed = Date.now() - started;
    const text = response.choices?.[0]?.message?.content?.trim() ?? '';
    console.log(`[llm:check] ok in ${elapsed}ms response="${text}"`);
} catch (err) {
    console.error(`[llm:check] failed: ${classifyError(err)}`);
    console.error(`[llm:check] message: ${err?.message ?? err}`);
    if (err?.status) console.error(`[llm:check] status: ${err.status}`);
    process.exit(1);
}

function classifyError(err) {
    const msg = String(err?.message ?? err).toLowerCase();
    if (err?.status === 401 || err?.status === 403) return 'auth/api-key problem';
    if (err?.status === 404) return 'bad endpoint or model name';
    if (err?.status === 429) return 'rate limit or quota';
    if (msg.includes('timeout')) return 'timeout/network or overloaded server';
    if (msg.includes('connection') || msg.includes('fetch failed') || msg.includes('enotfound')) {
        return 'network/connectivity problem';
    }
    return 'unknown';
}
