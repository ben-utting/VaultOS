'use strict';
// Skills VaultOS ships for the agents (spec §6.1), copied into their own skill folders in HOME: Claude Code
// reads ~/.claude/skills, and Cursor and most other agents read ~/.agents/skills. VaultOS keeps the hash of each
// file it wrote in ~/.vaultos/managed-skills.json. A file is written when it's missing, or when it's exactly what
// VaultOS last wrote there, so a new VaultOS updates an untouched copy and a copy the person edited is left alone.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_ROOTS = ['.claude/skills', '.agents/skills'];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function installManagedSkill({ srcDir, name, home, roots = DEFAULT_ROOTS }) {
  const stateFile = path.join(home, '.vaultos', 'managed-skills.json');
  let state = {};
  try { state = JSON.parse(await fsp.readFile(stateFile, 'utf8')); } catch { /* none yet, or unreadable: start again */ }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  const files = (await fsp.readdir(srcDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  const written = [];
  const kept = [];
  let changed = false;
  for (const root of roots) {
    for (const f of files) {
      const key = `${root}/${name}/${f}`;
      const dest = path.join(home, root, name, f);
      const src = await fsp.readFile(path.join(srcDir, f));
      const want = sha(src);
      let have = null;
      try { have = sha(await fsp.readFile(dest)); } catch { /* missing */ }
      if (have === want) {
        if (state[key] !== want) { state[key] = want; changed = true; }
        continue;
      }
      if (have !== null && state[key] !== have) { kept.push(key); continue; }   // edited by hand, or never ours
      await fsp.mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
      await fsp.writeFile(dest, src, { mode: 0o644 });
      state[key] = want;
      changed = true;
      written.push(key);
    }
  }
  if (changed) {
    await fsp.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    await fsp.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  return { written, kept };
}

module.exports = { installManagedSkill, DEFAULT_ROOTS };
