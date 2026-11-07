'use strict';
// ZenQuotes client for Today mode. fetch and clock are injected so tests never touch the network.

const BASE = 'https://zenquotes.io/api';
const BACKOFF_MS = 10 * 60e3;
const SHUFFLE_GAP_MS = 6000; // free tier: 5 requests per 30 s

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max).trim();

// ZenQuotes answers a rate limit with HTTP 200 and a fake quote, so it has to be spotted here.
function normalizeQuote(json) {
  if (!Array.isArray(json) || !json[0] || typeof json[0] !== 'object') return null;
  const text = clean(json[0].q, 400);
  const by = clean(json[0].a, 100);
  if (!text || by === 'zenquotes.io' || text.startsWith('Too many requests')) return null;
  return { text, by };
}

const fail = (status, message) => Object.assign(new Error(message), { status });

function createQuotes({ fetch, now = Date.now, timeoutMs = 4000 }) {
  let todayRetryAt = 0;
  let lastRandom = null;

  async function get(path) {
    const res = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res || !res.ok) throw fail(502, 'ZenQuotes request failed');
    const quote = normalizeQuote(await res.json());
    if (!quote) throw fail(502, 'ZenQuotes returned no usable quote');
    return quote;
  }

  async function today() {
    if (now() < todayRetryAt) return null;
    try {
      return await get('today');
    } catch {
      todayRetryAt = now() + BACKOFF_MS;
      return null;
    }
  }

  async function random() {
    if (lastRandom !== null && now() - lastRandom < SHUFFLE_GAP_MS) throw fail(429, 'Shuffling too fast');
    lastRandom = now();
    try {
      return await get('random');
    } catch (e) {
      throw e.status ? e : fail(502, 'ZenQuotes request failed');
    }
  }

  return { today, random };
}

module.exports = { normalizeQuote, createQuotes };
