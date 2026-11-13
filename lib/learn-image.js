'use strict';
// Studio's "Make an image": one explainer picture of what a notebook holds, made through OpenRouter so Ben never
// picks a model. Preferred: one Responses API call with the auto router and OpenRouter's image tool (no image model
// named, so the tool uses its default). Fallback (fallbackModel set): the auto router writes the image prompt, then
// a small fixed model calls the image tool. Every OpenRouter failure reaches the browser as 502 (504 for a timeout),
// never as OpenRouter's own 401, which would read as VaultOS's signed-out answer.
const { LearnError } = require('./learn-names');

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const TOOL = { type: 'openrouter:image_generation' };
const TITLE_ASK = 'Then reply with a short title for the image, at most six words, and nothing else.';
const STYLE = 'as a labelled diagram or infographic: a few short labels, arrows or groupings where they help, a flat clean style on a plain background, no decorative text and no logos.';
const REFUSED = 'The image model refused this. Try different wording in "What should it show?".';

const subject = (focus) => (typeof focus === 'string' && focus.trim() ? focus.trim() : 'its main idea');
const material = (text) => `Material:\n<<<\n${text}\n>>>`;

function IMAGE_PROMPT(text, focus) {
  return `Make one clear explainer image for someone studying the material below. Show ${subject(focus)} ${STYLE} ${TITLE_ASK}\n\n${material(text)}`;
}

function PROMPT_WRITER(text, focus) {
  return `Write a prompt for an image model: one clear explainer picture for someone studying the material below, showing ${subject(focus)} ${STYLE} Reply with the prompt only.\n\n${material(text)}`;
}

function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 3) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const messageText = (json) => (Array.isArray(json && json.output) ? json.output : [])
  .filter((o) => o && o.type === 'message' && Array.isArray(o.content))
  .flatMap((o) => o.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')))
  .join('\n');

function cleanTitle(raw) {
  const line = String(raw || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  let t = line.replace(/^title\s*:\s*/i, '').replace(/[*_#`"'“”‘’]/g, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/[.!?,;:]+$/, '').trim();
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '').trim() || t.slice(0, 60);
  return t || 'image';
}

const costOf = (json) => (json && json.usage && typeof json.usage.cost === 'number' ? json.usage.cost : null);

function parseImageResponse(json) {
  const items = Array.isArray(json && json.output) ? json.output : [];
  const img = items.find((o) => o && (typeof o.result === 'string' || typeof o.imageUrl === 'string') && o.status !== 'error');
  if (!img) {
    const refused = items.find((o) => o && o.status === 'error' && /moderat|safety|policy|refus|blocked|flagged/i.test(JSON.stringify(o.error || '')));
    throw new LearnError(502, refused ? REFUSED : 'OpenRouter answered without an image.');
  }
  const src = typeof img.result === 'string' ? img.result : img.imageUrl;
  const b64 = src.startsWith('data:') ? src.slice(src.indexOf(',') + 1) : src;
  return { b64, title: cleanTitle(messageText(json)), model: typeof json.model === 'string' ? json.model : null, cost: costOf(json) };
}

function statusError(status) {
  if (status === 401) return new LearnError(502, 'OpenRouter rejected the key. Check it in Settings → Learn.');
  if (status === 402) return new LearnError(502, 'Your OpenRouter account is out of credit.');
  if (status === 403) return new LearnError(502, REFUSED);
  if (status === 429) return new LearnError(502, 'OpenRouter is busy. Try again in a minute.');
  return new LearnError(502, `OpenRouter couldn't make the image (error ${status}).`);
}

function createImageMaker({ fetch, baseUrl = DEFAULT_BASE, timeoutMs = 120000, fallbackModel = null }) {
  async function request(pathname, { key, body, signal }) {
    let res;
    try {
      res = await fetch(`${baseUrl}${pathname}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new LearnError(504, 'OpenRouter took too long (2 minutes).');
      throw new LearnError(502, 'Couldn\'t reach OpenRouter.');
    }
    if (!res.ok) throw statusError(res.status);
    try { return await res.json(); } catch { throw new LearnError(502, 'OpenRouter answered without an image.'); }
  }

  async function withDeadline(fn) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fn(ctl.signal); } finally { clearTimeout(timer); }
  }

  async function make({ key, text, focus }) {
    return withDeadline(async (signal) => {
      let json;
      let extraCost = null;
      if (fallbackModel) {
        const first = await request('/responses', { key, signal, body: { model: 'openrouter/auto', input: PROMPT_WRITER(text, focus) } });
        const prompt = messageText(first).trim();
        if (!prompt) throw new LearnError(502, 'OpenRouter answered without an image.');
        extraCost = costOf(first);
        json = await request('/responses', { key, signal, body: { model: fallbackModel, input: `${prompt}\n\n${TITLE_ASK}`, tools: [TOOL] } });
      } else {
        json = await request('/responses', { key, signal, body: { model: 'openrouter/auto', input: IMAGE_PROMPT(text, focus), tools: [TOOL] } });
      }
      const r = parseImageResponse(json);
      const bytes = Buffer.from(r.b64, 'base64');
      const ext = sniffImage(bytes);
      if (!ext) throw new LearnError(502, 'OpenRouter sent something that isn\'t an image.');
      const cost = r.cost === null && extraCost === null ? null : (r.cost || 0) + (extraCost || 0);
      return { bytes, ext, title: r.title, model: r.model, cost };
    });
  }

  async function testKey(key) {
    return withDeadline(async (signal) => {
      const json = await request('/key', { key, signal });
      const left = json && json.data ? json.data.limit_remaining : null;
      return { ok: true, credit: typeof left === 'number' ? left : null };
    });
  }

  return { make, testKey };
}

module.exports = { IMAGE_PROMPT, PROMPT_WRITER, sniffImage, parseImageResponse, createImageMaker };
