'use strict';
// Learn's OpenRouter key: ~/.vaultos/learn.json (0600, folder 0700), like connectors.json. The key never leaves the
// server: status() gives only whether there is one, where it came from and its last four characters. With no saved
// key, OPENROUTER_API_KEY from the environment is used (for self-hosters). A damaged file is moved aside.
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');
const { LearnError } = require('./learn-names');

const STORE_REL = '.vaultos/learn.json';
const KEY_RE = /^sk-or-[A-Za-z0-9_-]{8,}$/;
const KEY_MAX = 200;

// Trim, then drop one pair of matching quotes around it, then trim again.
function cleanKey(raw) {
  let k = String(raw).trim();
  const q = k[0];
  if ((q === '"' || q === "'") && k.length > 1 && k[k.length - 1] === q) k = k.slice(1, -1).trim();
  return k;
}
const isKey = (k) => typeof k === 'string' && k.length <= KEY_MAX && KEY_RE.test(k);

function createLearnStore({ home, env = process.env, now = Date.now }) {
  const file = path.join(home, STORE_REL);
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function readSaved() {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* damaged */ }
    if (parsed && parsed.version === 1 && isKey(parsed.openrouterKey)) return parsed.openrouterKey;
    await fsp.rename(file, `${file}.bad-${now()}`);
    return null;
  }

  async function current() {
    const saved = await readSaved();
    if (saved) return { key: saved, source: 'saved' };
    const fromEnv = env.OPENROUTER_API_KEY ? cleanKey(env.OPENROUTER_API_KEY) : '';
    return isKey(fromEnv) ? { key: fromEnv, source: 'env' } : { key: null, source: null };
  }

  return {
    status: () => serial(async () => {
      const { key, source } = await current();
      return { set: !!key, source, last4: key ? key.slice(-4) : null };
    }),
    key: () => serial(async () => (await current()).key),
    save: (raw) => serial(async () => {
      const key = typeof raw === 'string' ? cleanKey(raw) : '';
      if (!isKey(key)) throw new LearnError(400, 'That doesn\'t look like an OpenRouter key. It starts with sk-or-.');
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fsp.chmod(path.dirname(file), 0o700);
      await atomicWrite(file, `${JSON.stringify({ version: 1, openrouterKey: key }, null, 2)}\n`);
      await fsp.chmod(file, 0o600);
    }),
    remove: () => serial(async () => {
      try { await fsp.unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }),
  };
}

module.exports = { STORE_REL, createLearnStore, cleanKey };
