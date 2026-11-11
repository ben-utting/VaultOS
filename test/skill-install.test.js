'use strict';
// VaultOS-managed skills (spec §6.1): written into the agents' skill folders, kept current, hand edits left alone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installManagedSkill } = require('../lib/skill-install');

const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function shipped(t, files = { 'SKILL.md': 'v1 skill\n', 'reference.md': 'v1 ref\n' }) {
  const src = path.join(tmp(t), 'vaultos-automations');
  fs.mkdirSync(src);
  for (const [f, s] of Object.entries(files)) fs.writeFileSync(path.join(src, f), s);
  return src;
}
const read = (home, rel) => fs.readFileSync(path.join(home, rel), 'utf8');

test('writes the skill into both folders and records hashes', async (t) => {
  const src = shipped(t);
  const home = tmp(t);
  const r = await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home });
  assert.deepEqual(r.written.sort(), [
    '.agents/skills/vaultos-automations/SKILL.md', '.agents/skills/vaultos-automations/reference.md',
    '.claude/skills/vaultos-automations/SKILL.md', '.claude/skills/vaultos-automations/reference.md',
  ]);
  assert.equal(read(home, '.claude/skills/vaultos-automations/SKILL.md'), 'v1 skill\n');
  assert.equal(read(home, '.agents/skills/vaultos-automations/reference.md'), 'v1 ref\n');
  const state = JSON.parse(read(home, '.vaultos/managed-skills.json'));
  assert.equal(Object.keys(state).length, 4);
  assert.match(state['.claude/skills/vaultos-automations/SKILL.md'], /^[0-9a-f]{64}$/);
  assert.deepEqual(await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home }), { written: [], kept: [] });
});

test('rewrites an untouched copy when the shipped one changes', async (t) => {
  const src = shipped(t);
  const home = tmp(t);
  await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home });
  fs.writeFileSync(path.join(src, 'SKILL.md'), 'v2 skill\n');
  const r = await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home });
  assert.deepEqual(r.written.sort(), ['.agents/skills/vaultos-automations/SKILL.md', '.claude/skills/vaultos-automations/SKILL.md']);
  assert.equal(read(home, '.claude/skills/vaultos-automations/SKILL.md'), 'v2 skill\n');
});

test('keeps a copy edited by hand, and one VaultOS never wrote', async (t) => {
  const src = shipped(t);
  const home = tmp(t);
  await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home });
  fs.writeFileSync(path.join(home, '.claude/skills/vaultos-automations/SKILL.md'), 'my own version\n');
  fs.writeFileSync(path.join(src, 'SKILL.md'), 'v2 skill\n');
  const r = await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home });
  assert.deepEqual(r.kept, ['.claude/skills/vaultos-automations/SKILL.md']);
  assert.equal(read(home, '.claude/skills/vaultos-automations/SKILL.md'), 'my own version\n');
  assert.equal(read(home, '.agents/skills/vaultos-automations/SKILL.md'), 'v2 skill\n');
  // A file the person had before VaultOS ever wrote one is theirs too.
  const home2 = tmp(t);
  fs.mkdirSync(path.join(home2, '.claude/skills/vaultos-automations'), { recursive: true });
  fs.writeFileSync(path.join(home2, '.claude/skills/vaultos-automations/SKILL.md'), 'theirs\n');
  const r2 = await installManagedSkill({ srcDir: src, name: 'vaultos-automations', home: home2 });
  assert.ok(r2.kept.includes('.claude/skills/vaultos-automations/SKILL.md'));
  assert.equal(read(home2, '.claude/skills/vaultos-automations/SKILL.md'), 'theirs\n');
});

test('the shipped skill names every command', () => {
  const dir = path.join(__dirname, '..', 'skills', 'vaultos-automations');
  const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const ref = fs.readFileSync(path.join(dir, 'reference.md'), 'utf8');
  assert.match(skill, /^---\nname: vaultos-automations\ndescription: .+\n---\n/);
  for (const cmd of ['options', 'list', 'show', 'match', 'runs', 'run', 'create', 'edit', 'off', 'try', 'delete']) {
    assert.ok(ref.includes(`vaultos-automations ${cmd}`), cmd);
  }
  assert.ok(!/—/.test(skill + ref), 'no em dashes');
});
