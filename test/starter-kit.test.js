'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KIT_DIR, boardsBlock, writeRootKit, writeBoardKit, updateAgentsBlock } = require('../lib/starter-kit');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vaultos-kit-'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const WORK = { key: 'work', dir: 'Work', label: 'Work', hidden: false };
const ALPHA = { key: 'alpha', dir: 'alpha', label: 'Alpha team', hidden: false };
const TODAY = '2026-10-13';
const GUIDES = ['done', 'new-subtask', 'new-task'];

// Third-party skills shipped as they are (each with its own LICENSE), as kit paths. starter-kit/skills/<name>/ is
// written to both .agents/skills/ and .claude/skills/; the optional one sits switched off under .vaultos/.
const SKILLS = ['diagram-design', 'stop-slop'];
const SKILL_DIRS = [...SKILLS.map((n) => `skills/${n}`), 'root/.vaultos/optional-skills/i-have-adhd'];
const VENDORED = (f) => SKILL_DIRS.some((d) => f.startsWith(`${d}/`));
const skillFiles = (n) => walk(path.join(KIT_DIR, 'skills', n));
const ROOT_FILES_OWN = [
  '.claude/commands/done.md',
  '.claude/commands/new-subtask.md',
  '.claude/commands/new-task.md',
  '.claude/hooks/check-progress.sh',
  '.claude/hooks/inject-plan.sh',
  '.claude/settings.json',
  '.vaultos/guides/done.md',
  '.vaultos/guides/new-subtask.md',
  '.vaultos/guides/new-task.md',
  'AGENTS.md',
  'CLAUDE.md',
];
const ROOT_FILES = [
  ...ROOT_FILES_OWN,
  ...walk(path.join(KIT_DIR, 'root')).filter((f) => f.startsWith('.vaultos/optional-skills/')),
  ...SKILLS.flatMap((n) => skillFiles(n).flatMap((f) => [`.agents/skills/${n}/${f}`, `.claude/skills/${n}/${f}`])),
].sort();

// What server.js regenerateBoard() writes for a board with no tasks: the 7 columns
// in STATUSES order, **Complete** under Done, then the kanban settings block.
const EMPTY_BOARD = [
  '---', '', 'kanban-plugin: board', '', '---', '',
  '## Backlog', '', '',
  '## In Progress', '', '',
  '## Blocked', '', '',
  '## Needs Decision', '', '',
  '## Review', '', '',
  '## Scheduled', '', '',
  '## Done', '', '**Complete**', '',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board","list-collapse":[false,false,false,false,false,false,false],"show-checkboxes":false}',
  '```',
  '%%',
  '',
].join('\n');

// Every file under dir, as POSIX paths relative to it, dot-folders included.
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

test('boardsBlock: one line per board, in order', () => {
  assert.equal(boardsBlock([WORK, ALPHA]), '- **Work** → `Work/`\n- **Alpha team** → `alpha/`');
  assert.equal(boardsBlock([]), '');
  // A label is free text: it must not break the one-line-per-board block.
  assert.equal(boardsBlock([{ dir: 'x', label: 'two\nlines' }]), '- **two lines** → `x/`');
});

test('writeRootKit into an empty vault writes the expected list', async () => {
  const v = tmp();
  const written = await writeRootKit(v, [WORK]);
  assert.deepEqual([...written].sort(), ROOT_FILES);
  assert.deepEqual(walk(v).sort(), ROOT_FILES); // nothing else, no temp files left behind

  const agents = read(v, 'AGENTS.md');
  assert.ok(agents.includes('<!-- vaultos:boards -->\n- **Work** → `Work/`\n<!-- /vaultos:boards -->'));
  assert.equal(read(v, 'CLAUDE.md'), '@AGENTS.md\n');
  for (const n of GUIDES) {
    const cmd = read(v, '.claude', 'commands', `${n}.md`);
    assert.match(cmd, /^---\n(?:.*\n)*?description: \S.*\n(?:.*\n)*?---\n/);
    assert.ok(cmd.endsWith(`\nFollow .vaultos/guides/${n}.md for: $ARGUMENTS\n`), n);
  }
  assert.equal(fs.existsSync(path.join(v, '.cursor')), false);
});

test('second writeRootKit writes nothing and an edited AGENTS.md stays byte-identical', async () => {
  const v = tmp();
  await writeRootKit(v, [WORK]);
  const edited = read(v, 'AGENTS.md') + '\nMy own notes.\n';
  fs.writeFileSync(path.join(v, 'AGENTS.md'), edited);
  assert.deepEqual(await writeRootKit(v, [WORK, ALPHA]), []);
  assert.equal(read(v, 'AGENTS.md'), edited);
});

test('own AGENTS.md without markers is never touched', async () => {
  const v = tmp();
  fs.writeFileSync(path.join(v, 'AGENTS.md'), '# mine\n');
  fs.writeFileSync(path.join(v, 'CLAUDE.md'), '# mine\n');
  const written = await writeRootKit(v, [WORK]);
  assert.equal(written.includes('AGENTS.md'), false);
  assert.equal(written.includes('CLAUDE.md'), false);
  assert.equal(read(v, 'AGENTS.md'), '# mine\n');
  assert.equal(read(v, 'CLAUDE.md'), '# mine\n');

  assert.equal(await updateAgentsBlock(v, [WORK]), false);
  assert.equal(read(v, 'AGENTS.md'), '# mine\n');
  assert.equal(read(v, 'CLAUDE.md'), '# mine\n');
});

test('updateAgentsBlock returns false with no file or only one marker', async () => {
  const v = tmp();
  assert.equal(await updateAgentsBlock(v, [WORK]), false);
  assert.equal(fs.existsSync(path.join(v, 'AGENTS.md')), false);

  for (const text of ['x\n<!-- vaultos:boards -->\nold\n', 'x\n<!-- /vaultos:boards -->\n<!-- vaultos:boards -->\n']) {
    fs.writeFileSync(path.join(v, 'AGENTS.md'), text);
    assert.equal(await updateAgentsBlock(v, [WORK]), false);
    assert.equal(read(v, 'AGENTS.md'), text);
  }
});

test('updateAgentsBlock replaces only between markers', async () => {
  const v = tmp();
  const before = '# Team notes\n\nIntro <!-- an ordinary comment -->\n\n';
  const after = '\n\n## More\nTrailing text, no newline';
  fs.writeFileSync(path.join(v, 'AGENTS.md'),
    `${before}<!-- vaultos:boards -->\n- **Old** → \`Old/\`\n<!-- /vaultos:boards -->${after}`);

  assert.equal(await updateAgentsBlock(v, [WORK, ALPHA]), true);
  assert.equal(read(v, 'AGENTS.md'),
    `${before}<!-- vaultos:boards -->\n- **Work** → \`Work/\`\n- **Alpha team** → \`alpha/\`\n<!-- /vaultos:boards -->${after}`);
  assert.equal(await updateAgentsBlock(v, [WORK, ALPHA]), false); // nothing changed

  // The kit's own AGENTS.md: everything outside the block survives an update.
  const k = tmp();
  await writeRootKit(k, [WORK]);
  const split = (t) => /^([\s\S]*<!-- vaultos:boards -->)[\s\S]*?(<!-- \/vaultos:boards -->[\s\S]*)$/.exec(t).slice(1);
  const old = read(k, 'AGENTS.md');
  assert.equal(await updateAgentsBlock(k, [WORK, ALPHA]), true);
  assert.deepEqual(split(read(k, 'AGENTS.md')), split(old));
  assert.ok(read(k, 'AGENTS.md').includes('- **Alpha team** → `alpha/`'));
});

test('writeBoardKit with welcome', async () => {
  const v = tmp();
  const written = await writeBoardKit(v, WORK, { welcome: true, today: TODAY });
  assert.deepEqual([...written].sort(), [
    'Work/1. getting-started/01-welcome-to-vaultos/task.md',
    'Work/_tasks/Board.md',
    'Work/_tasks/_Templates/article.md',
    'Work/_tasks/_Templates/task.md',
  ]);

  const board = read(v, 'Work', '_tasks', 'Board.md');
  assert.ok(board.includes('kanban-plugin: board'));
  for (const t of ['Backlog', 'Scheduled', 'In Progress', 'Blocked', 'Needs Decision', 'Review', 'Done']) {
    assert.ok(board.includes(`\n## ${t}\n`), t);
  }
  assert.equal(board, EMPTY_BOARD);

  const welcome = read(v, 'Work', '1. getting-started', '01-welcome-to-vaultos', 'task.md');
  assert.match(welcome, /^status: backlog$/m);
  assert.match(welcome, /^created: 2026-10-13$/m);
  assert.match(welcome, /^updated: 2026-10-13$/m);
  assert.ok(welcome.includes('- 2026-10-13 — created by setup.'));
  assert.equal(welcome.includes('{{'), false);
});

test('writeBoardKit: today defaults to the local date; no welcome without the flag', async () => {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const v = tmp();
  await writeBoardKit(v, WORK, { welcome: true });
  assert.match(read(v, 'Work', '1. getting-started', '01-welcome-to-vaultos', 'task.md'), new RegExp(`^created: ${iso}$`, 'm'));

  const written = await writeBoardKit(v, ALPHA, {});
  assert.deepEqual([...written].sort(), ['alpha/_tasks/Board.md', 'alpha/_tasks/_Templates/article.md', 'alpha/_tasks/_Templates/task.md']);
  assert.equal(fs.existsSync(path.join(v, 'alpha', '1. getting-started')), false);
});

test('writeBoardKit refuses a folder outside the vault', async () => {
  const v = tmp();
  for (const dir of ['', '..', '.', 'a/b', '../x', 'a\\b']) {
    await assert.rejects(writeBoardKit(v, { dir, label: 'x' }, { today: TODAY }), /board folder/);
  }
});

test('writeBoardKit never overwrites a template', async () => {
  const v = tmp();
  const tpl = path.join(v, 'Work', '_tasks', '_Templates', 'task.md');
  fs.mkdirSync(path.dirname(tpl), { recursive: true });
  fs.writeFileSync(tpl, 'my template\n');

  const written = await writeBoardKit(v, WORK, { welcome: true, today: TODAY });
  assert.equal(written.includes('Work/_tasks/_Templates/task.md'), false);
  assert.ok(written.includes('Work/_tasks/_Templates/article.md'));
  assert.equal(read(tpl), 'my template\n');

  // A second run writes nothing, and an edited welcome card stays as it is.
  const card = path.join(v, 'Work', '1. getting-started', '01-welcome-to-vaultos', 'task.md');
  fs.writeFileSync(card, 'moved on\n');
  assert.deepEqual(await writeBoardKit(v, WORK, { welcome: true, today: '2027-01-01' }), []);
  assert.equal(read(card), 'moved on\n');
});

test('.cursor/commands only with cursor:true', async () => {
  const a = tmp();
  const plain = await writeRootKit(a, [WORK]);
  assert.equal(plain.some((p) => p.startsWith('.cursor/')), false);
  assert.equal(fs.existsSync(path.join(a, '.cursor')), false);

  const b = tmp();
  const withCursor = await writeRootKit(b, [WORK], { cursor: true });
  const cursorFiles = GUIDES.map((n) => `.cursor/commands/${n}.md`);
  assert.deepEqual(withCursor.filter((p) => p.startsWith('.cursor/')).sort(), cursorFiles);
  assert.deepEqual([...withCursor].sort(), [...ROOT_FILES, ...cursorFiles].sort());
  for (const n of GUIDES) {
    assert.ok(read(b, '.cursor', 'commands', `${n}.md`).includes(`Follow .vaultos/guides/${n}.md`), n);
  }
});

test('kit has nothing personal', () => {
  const files = walk(KIT_DIR);
  assert.ok(files.length >= 14, `kit has ${files.length} files`);
  // Generic board names a personal vault tends to use, plus scripts/private-words.txt when it exists
  // (the homelab copy only; that file is never published, so the words in it appear nowhere else).
  const generic = /\b(Personal|Business|Health|CAB)\b/;   // not applied to the vendored skills' own prose
  const words = ['192\\.168\\.'];
  const list = path.join(__dirname, '..', 'scripts', 'private-words.txt');
  if (fs.existsSync(list)) {
    words.push(...fs.readFileSync(list, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')));
  }
  const personal = new RegExp(words.join('|'));
  for (const f of files) {
    assert.doesNotMatch(f, personal, f);
    assert.doesNotMatch(read(KIT_DIR, f), personal, f);
    if (!VENDORED(f)) assert.doesNotMatch(read(KIT_DIR, f), generic, f);
  }
});

test('each shipped skill has its SKILL.md and its LICENSE', () => {
  for (const d of SKILL_DIRS) {
    assert.ok(fs.existsSync(path.join(KIT_DIR, d, 'SKILL.md')), d);
    assert.match(fs.readFileSync(path.join(KIT_DIR, d, 'LICENSE'), 'utf8'), /MIT License/, d);
  }
});

// The task-board hooks: Claude Code runs them from the vault's .claude/settings.json.
const { spawnSync } = require('node:child_process');
const hook = (v, name, input) => spawnSync('bash', [path.join(v, '.claude', 'hooks', name)], {
  input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: v },
});
const localToday = () => spawnSync('date', ['+%F'], { encoding: 'utf8' }).stdout.trim();
function kitWithTask(fields) {
  const v = tmp();
  const job = path.join(v, 'Work', '1. p', '01-job');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'task.md'), `---\n${fields}\n---\n\n# Job\n\n## Plan\n- [ ] step one\n`);
  return { v, job };
}

test('kit settings.json registers both task-board hooks', async () => {
  const v = tmp();
  await writeRootKit(v, [WORK]);
  const hooks = JSON.parse(read(v, '.claude', 'settings.json')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'UserPromptSubmit']);
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/inject-plan\.sh/);
  assert.match(hooks.Stop[0].hooks[0].command, /\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/check-progress\.sh/);
});

test('inject-plan prints the nearest task.md inside a job and nothing outside one', async () => {
  const { v, job } = kitWithTask('status: in-progress');
  await writeRootKit(v, [WORK]);
  const inJob = hook(v, 'inject-plan.sh', { cwd: path.join(job, 'data') });
  assert.equal(inJob.status, 0);
  assert.match(inJob.stdout, /Active task context/);
  assert.match(inJob.stdout, /- \[ \] step one/);
  const outside = hook(v, 'inject-plan.sh', { cwd: v });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, '');
});

test('check-progress blocks once on a stale active task, and never otherwise', async () => {
  const stale = kitWithTask('status: in-progress\nupdated: 2000-01-01');
  await writeRootKit(stale.v, [WORK]);
  const r = hook(stale.v, 'check-progress.sh', { cwd: stale.job });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /updated: 2000-01-01/);
  assert.equal(hook(stale.v, 'check-progress.sh', { cwd: stale.job, stop_hook_active: true }).status, 0);

  const fresh = kitWithTask(`status: in-progress\nupdated: ${localToday()}`);
  await writeRootKit(fresh.v, [WORK]);
  assert.equal(hook(fresh.v, 'check-progress.sh', { cwd: fresh.job }).status, 0);

  const backlog = kitWithTask('status: backlog\nupdated: 2000-01-01');
  await writeRootKit(backlog.v, [WORK]);
  assert.equal(hook(backlog.v, 'check-progress.sh', { cwd: backlog.job }).status, 0);
  assert.equal(hook(backlog.v, 'check-progress.sh', { cwd: backlog.v }).status, 0);
});

test('an edited .claude skill stays; the .agents copy is still written', async () => {
  const v = tmp();
  fs.mkdirSync(path.join(v, '.claude/skills/stop-slop'), { recursive: true });
  fs.writeFileSync(path.join(v, '.claude/skills/stop-slop/SKILL.md'), 'mine\n');
  await writeRootKit(v, [WORK]);
  assert.equal(read(v, '.claude', 'skills', 'stop-slop', 'SKILL.md'), 'mine\n');
  assert.match(read(v, '.agents', 'skills', 'stop-slop', 'SKILL.md'), /^---/);
});
