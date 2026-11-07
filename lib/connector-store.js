'use strict';
// Connector sign-ins and state: one JSON file, ~/.vaultos/connectors.json (0600, folder 0700).
// A damaged file is moved aside, never overwritten.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite } = require('./atomic-write');

const STORE_REL = '.vaultos/connectors.json';

const newKey = () => crypto.randomBytes(32).toString('base64url');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fresh = () => ({ version: 1, relayKey: newKey(), connectors: {}, written: {} });
const valid = (s) => isObj(s) && s.version === 1 && typeof s.relayKey === 'string' && s.relayKey
  && isObj(s.connectors) && isObj(s.written);

function createStore({ home, now = Date.now }) {
  const file = path.join(home, STORE_REL);
  let state = null;
  let reset = false;
  let queue = Promise.resolve();

  async function save(next) {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fsp.chmod(path.dirname(file), 0o700);
    await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
    await fsp.chmod(file, 0o600);
  }

  async function load() {
    let text = null;
    try { text = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (text !== null) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* damaged */ }
      if (valid(parsed)) { state = parsed; return structuredClone(state); }
      await fsp.rename(file, `${file}.bad-${now()}`);
      reset = true;
    }
    state = fresh();
    await save(state);
    return structuredClone(state);
  }

  const get = () => structuredClone(state);

  function update(fn) {
    const run = queue.then(async () => {
      const draft = structuredClone(state);
      fn(draft);
      await save(draft);
      state = draft;
      return structuredClone(state);
    });
    queue = run.catch(() => {});
    return run;
  }

  return { load, get, update, wasReset: () => reset };
}

module.exports = { STORE_REL, createStore };
