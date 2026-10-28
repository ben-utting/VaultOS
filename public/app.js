'use strict';

const $ = (id) => document.getElementById(id);

// Column visibility is remembered per workspace (one board's chosen columns
// shouldn't hide/show columns on another, and vice versa). One-time
// migration below carries an existing global preference into whichever
// workspace was last active, then drops the old key.
function hiddenColsKey(wsKey) { return 'vaultboard.hiddenColumns.' + wsKey; }
function loadHiddenColumns(wsKey) {
  const raw = localStorage.getItem(hiddenColsKey(wsKey));
  try { return new Set(raw != null ? JSON.parse(raw) : ['done']); }
  catch { return new Set(['done']); }
}
// Subtask visibility is remembered the same way, per workspace: a board whose work
// is fanned out into batches wants them collapsed; one with none doesn't
// care. Off by default, so nobody's board changes shape without them asking.
function hideSubtasksKey(wsKey) { return 'vaultboard.hideSubtasks.' + wsKey; }
function loadHideSubtasks(wsKey) { return localStorage.getItem(hideSubtasksKey(wsKey)) === '1'; }

(function migrateHiddenColumns() {
  const legacy = localStorage.getItem('vaultboard.hiddenColumns');
  if (legacy == null) return;
  const wsKey = localStorage.getItem('vaultboard.workspace') || '';
  if (localStorage.getItem(hiddenColsKey(wsKey)) == null) localStorage.setItem(hiddenColsKey(wsKey), legacy);
  localStorage.removeItem('vaultboard.hiddenColumns');
})();

let STATE = {
  tasks: [], projects: [], statuses: [], projectFilter: new Set(), query: '', loaded: false,
  batchFilter: '',   // '' = whole board. Set by clicking a card's batch chip; cleared from the bar.
  mode: 'board',   // until startup picks homeMode() (Today when it's on); a Refresh restores whichever mode was showing
  workspace: localStorage.getItem('vaultboard.workspace') || '',   // loadWorkspaces() falls back to the first visible board
  kb: { collections: [], articles: [], collectionFilter: new Set(), query: '', article: null, loaded: false,
    sidebarOpen: localStorage.getItem('vaultboard.kbSidebarOpen') === '1' },
};
STATE.hiddenColumns = loadHiddenColumns(STATE.workspace);
STATE.hideSubtasks = loadHideSubtasks(STATE.workspace);
let FILTER_SEARCH = ''; // typed into the folder-filter popover, board/kb-scoped by whichever is open
let DRAG = null;
let OPEN = null; // { path, mtime } of the task shown in the drawer

// ---------- Scroll preservation ----------
// Every "refresh" in this app repaints by replacing innerHTML wholesale, which
// collapses the scroller's content for an instant — the browser clamps the
// offset and you land back at the top of a long task, article or board instead
// of where you were reading. Capture the offsets before the repaint, put them
// back after, and call the returned function again once late-arriving content
// (diagrams) has changed the height. The guard makes the late re-pin a no-op
// if anything moved the scroll in the meantime, so a reader who scrolls during
// the fetch isn't yanked back.
function holdScroll(...els) {
  const saved = els.filter(Boolean).map((el) => ({ el, top: el.scrollTop, left: el.scrollLeft }));
  const page = { top: window.scrollY, left: window.scrollX };
  let applied = null;   // what the offsets actually were after the last apply
  return function restore() {
    if (applied && !(applied.page === window.scrollY
        && applied.els.every((v, i) => v === saved[i].el.scrollTop))) return;
    for (const s of saved) { s.el.scrollTop = s.top; s.el.scrollLeft = s.left; }
    window.scrollTo(page.left, page.top);
    applied = { els: saved.map((s) => s.el.scrollTop), page: window.scrollY };
  };
}

// ---------- Refresh feedback ----------
// Rescanning the vault usually takes well under 100ms, so tying the spin purely
// to the request would flash for two frames and read as a dead button. Hold the
// busy state for at least one full revolution however fast the fetch was, then
// settle with the gold pulse — see "Refresh feedback" in styles.css.
const SPIN_MS = 620;   // mirrors --dur-spin

async function withRefreshFeedback(btn, work) {
  if (!btn || btn.dataset.busy) return;   // a second click mid-spin is a no-op, not a second rescan
  btn.classList.remove('refresh-done');
  btn.dataset.busy = '1';
  btn.setAttribute('aria-busy', 'true');   // the spin is the sighted half of this
  const started = Date.now();
  let ok = true;
  try { await work(); }
  catch (err) { ok = false; toast(err.message); }
  const left = SPIN_MS - (Date.now() - started);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
  delete btn.dataset.busy;
  btn.removeAttribute('aria-busy');
  if (!ok) return;   // the toast is the answer; a success pulse would contradict it
  void btn.offsetWidth;   // restart the animation even on back-to-back refreshes
  btn.classList.add('refresh-done');
  setTimeout(() => btn.classList.remove('refresh-done'), 400);
}

// ---------- API ----------
let WRITES = 0;   // bumped by every write, so a board poll in flight can tell its answer is stale
async function api(url, opts) {
  if (opts && opts.method && opts.method !== 'GET') WRITES++;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) { showLogin(); throw new Error('Not authenticated'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Every task/KB/diagram request is scoped to the active workspace.
function ws(url) {
  return url + (url.includes('?') ? '&' : '?') + 'ws=' + encodeURIComponent(STATE.workspace);
}

// ---------- What this VaultOS has on ----------
// /api/me. Signed in (or a same-box read): { authed, localRead?, features: { today, terminal },
// agent: null | { profile, label, startCommand } }, where agent is null whenever the terminal is off.
// Signed out: { authed: false, setup } (setup: the server wants the setup page). The UI offers only
// what is on: no Today without Today, and no terminal or Start agent without the terminal.
let ME = { authed: false, features: { today: false, terminal: false }, agent: null };
const todayOn = () => !!ME.features.today;
const termOn = () => !!ME.features.terminal;
const homeMode = () => (todayOn() ? 'today' : 'board');   // the mode VaultOS opens on
const agentLabel = () => (ME.agent ? ME.agent.label : null);   // null: no agent, or the terminal is off
async function fetchMe() {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ authed: false }));
  return { ...me, features: me.features || { today: false, terminal: false }, agent: me.agent || null };
}
function applyMe() {
  const today = todayOn();
  const term = termOn();
  for (const el of [$('mode-today'), document.querySelector('#mobile-nav [data-for="mode-today"]'), $('today-sound-row')]) {
    el.classList.toggle('hidden', !today);
  }
  for (const el of [$('termbtn'), $('mnav-term'), $('term-where-row'), $('term-sound-row')]) el.classList.toggle('hidden', !term);
  $('d-agent').classList.toggle('hidden', !ME.agent);
  // The agent's name on the card pills and in Start agent's tooltip (renderDrawerAgent is workbench.js's).
  paintCardAgents();
  renderDrawerAgent();
}
// After Settings → Agent saves: Start agent and the pills use the new agent at once.
async function refreshMe() {
  const me = await fetchMe();
  if (me.authed) { ME = me; applyMe(); }
}

// ---------- Login ----------
function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) });
    $('password').value = '';
    $('login').classList.add('hidden');
    ME = await fetchMe();
    await start();   // startup skips this when it lands on the login screen
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

async function signOut() {
  closeSheet();
  await fetch('/api/logout', { method: 'POST' });
  showLogin();
}
$('logout').addEventListener('click', signOut);
$('logout-sheet').addEventListener('click', signOut);

// ---------- Helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// One icon voice (Lucide-style strokes) instead of OS-dependent emoji.
const svg = (paths) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  book: svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  ban: svg('<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  file: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/>'),
  arrowLeft: svg('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  layers: svg('<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  subtask: svg('<path d="M4 4v10a4 4 0 0 0 4 4h12"/><path d="m16 14 4 4-4 4"/>'),
  chevron: svg('<polyline points="6 9 12 15 18 9"/>'),
  eyeOff: svg('<path d="M10.7 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a15.6 15.6 0 0 1-3.2 4.1"/><path d="M6.6 6.6A15.6 15.6 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 4.4-1"/><path d="m2 2 20 20"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
};

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- Reading settings (theme, font, size — persisted) ----------
const FS_MIN = 0.85, FS_MAX = 1.8, FS_STEP = 0.1;
const PREF = {
  theme: localStorage.getItem('vaultboard.theme') || 'dark',      // dark | light (sepia)
  font: localStorage.getItem('vaultboard.font') || 'dyslexic',    // dyslexic | system
  scale: parseFloat(localStorage.getItem('vaultboard.fs')) || 1,
};
function segSet(id, val) {
  for (const b of document.querySelectorAll('#' + id + ' button')) b.classList.toggle('on', b.dataset.v === val);
}
function applyPrefs() {
  const r = document.documentElement;
  PREF.scale = Math.min(FS_MAX, Math.max(FS_MIN, Math.round(PREF.scale * 100) / 100));
  r.setAttribute('data-theme', PREF.theme);
  // Keep the PWA chrome colour in step with the theme.
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', PREF.theme === 'light' ? '#f4ecd9' : '#0b0d12');
  r.setAttribute('data-font', PREF.font);
  r.style.setProperty('--fs', PREF.scale);
  $('fsVal').textContent = Math.round(PREF.scale * 100) + '%';
  segSet('segTheme', PREF.theme);
  segSet('segFont', PREF.font);
  localStorage.setItem('vaultboard.theme', PREF.theme);
  localStorage.setItem('vaultboard.font', PREF.font);
  localStorage.setItem('vaultboard.fs', PREF.scale);
}
applyPrefs();
for (const b of document.querySelectorAll('#segTheme button')) b.addEventListener('click', () => { PREF.theme = b.dataset.v; applyPrefs(); });
for (const b of document.querySelectorAll('#segFont button')) b.addEventListener('click', () => { PREF.font = b.dataset.v; applyPrefs(); });
$('fsUp').addEventListener('click', () => { PREF.scale += FS_STEP; applyPrefs(); });
$('fsDown').addEventListener('click', () => { PREF.scale -= FS_STEP; applyPrefs(); });

// ---------- Header ----------
// The header wraps to a second row on narrow screens and grows with the A−/A+
// text scale, so the KB layout's height and the popovers' top edge read the
// measured height rather than a magic number.
const HEADER_EL = document.querySelector('header');
new ResizeObserver(() => {
  const h = HEADER_EL.offsetHeight;
  if (h) document.documentElement.style.setProperty('--header-h', h + 'px'); // 0 while #app is hidden
}).observe(HEADER_EL);

// ---------- Settings sheet ----------
// Workspace, folder filter, columns and appearance used to be four header
// popovers that could open on top of each other. Now one modal sheet with a
// section per popover; only one section is ever showing.
let SHEET_SEC = 'ws';
const sheetOpen = () => !$('setsheet').classList.contains('hidden');
const secOpen = (sec) => sheetOpen() && SHEET_SEC === sec;
// Folders mean nothing in Files mode or on Today, columns only exist on the Board. The agent runs in the
// terminal. Changing settings needs a real session, which a same-box read doesn't have.
const secAvailable = (sec) => {
  if (sec === 'folders') return STATE.mode === 'board' || STATE.mode === 'kb';
  if (sec === 'cols') return STATE.mode === 'board';
  if (sec === 'agent') return termOn() && !ME.localRead;
  if (sec === 'features' || sec === 'password') return !ME.localRead;
  return true;
};
function showSection(sec) {
  if (!secAvailable(sec)) sec = 'ws';
  SHEET_SEC = sec;
  for (const b of $('ss-nav').querySelectorAll('button')) b.classList.toggle('active', b.dataset.sec === sec);
  for (const p of document.querySelectorAll('.ss-pane')) p.classList.toggle('active', p.dataset.sec === sec);
  if (sec === 'ws') { renderWsList(); loadBoardSettings(); }
  else if (sec === 'folders') { FILTER_SEARCH = ''; $('filter-search').value = ''; renderFilterList(); }
  else if (sec === 'cols') { renderColsList(); renderSubtaskToggle(); }
  else if (sec === 'features') loadFeatures();
  else if (sec === 'agent') loadAgent();
  else if (sec === 'skills') loadSkills();
  else if (sec === 'password') resetPassword();
}

// ---------- Skills ----------
// A reminder of what's on hand when Claude runs in a VaultOS terminal. The
// first four groups are read from disk by /api/skills, so a new skill appears
// on its own. Claude Code's built-ins aren't files, so they're listed here by
// hand: update this list if a Claude Code release adds or drops one.
const BUILTIN_SKILLS = [
  { name: 'init', description: 'Write a CLAUDE.md for the current folder: how the code is laid out and how to work in it.' },
  { name: 'code-review', description: 'Review the current changes (or a PR) for bugs. Add --fix to apply what it finds.' },
  { name: 'security-review', description: 'Security review of the pending changes on the current branch.' },
  { name: 'simplify', description: 'Tidy the changed code: reuse, simplification, efficiency. Doesn\'t hunt for bugs.' },
  { name: 'loop', description: 'Run a prompt or command again and again on an interval, e.g. /loop 5m check the deploy.' },
  { name: 'schedule', description: 'Scheduled cloud agents (routines) that run on a cron, or once at a set time.' },
  { name: 'update-config', description: 'Change Claude Code settings: permissions, env vars, hooks ("whenever X, do Y").' },
  { name: 'fewer-permission-prompts', description: 'Scan past sessions and allow-list the safe commands you keep approving.' },
  { name: 'keybindings-help', description: 'Rebind Claude Code\'s keyboard shortcuts.' },
  { name: 'claude-api', description: 'Reference for building on the Claude API / Anthropic SDK: models, pricing, tools, caching.' },
  { name: 'run', description: 'Launch the project\'s app and drive it to see a change actually working.' },
];
const SKILL_GROUPS = [
  { key: 'vault', title: 'VaultOS workflow', hint: 'The commands that run the Board. Type them in a VaultOS terminal running claude.' },
  { key: 'mine', title: 'Your skills', hint: 'Installed in ~/.claude/skills. Claude picks these up when a task fits, or call one by name.' },
  { key: 'synced', title: 'Synced from claude.ai', hint: 'Your claude.ai skills, synced down to this box.' },
  { key: 'plugin', title: 'Plugins', hint: 'From installed Claude Code plugins.' },
  { key: 'builtin', title: 'Built into Claude Code', hint: 'Ship with Claude Code itself; the exact set changes between versions.' },
];
let SKILLS = null;
let SKILLS_SEARCH = '';
function loadSkills() {
  if (SKILLS) return renderSkills();
  $('skills-list').innerHTML = '<p class="pop-hint">Loading…</p>';
  fetch('/api/skills').then((r) => (r.ok ? r.json() : Promise.reject(r.status))).then((d) => {
    SKILLS = [...d.skills, ...BUILTIN_SKILLS.map((x) => ({ ...x, source: 'builtin' }))];
    renderSkills();
  }).catch(() => { $('skills-list').innerHTML = '<p class="pop-hint">Couldn\'t load the skills list.</p>'; });
}
function renderSkills() {
  const q = SKILLS_SEARCH.trim().toLowerCase();
  const hit = (x) => !q || `${x.name} ${x.description} ${x.plugin || ''}`.toLowerCase().includes(q);
  const html = SKILL_GROUPS.map((g) => {
    const items = SKILLS.filter((x) => x.source === g.key && hit(x)).sort((a, b) => a.name.localeCompare(b.name));
    if (!items.length) return '';
    return `<div class="sk-group"><div class="filter-actions"><span class="lbl">${esc(g.title)}</span><span class="n">${items.length}</span></div>`
      + (q ? '' : `<p class="pop-hint">${esc(g.hint)}</p>`)
      + items.map((x) => `<div class="sk-item">`
        + `<button type="button" class="sk-name" data-copy="/${esc(x.name)}" title="Copy /${esc(x.name)}">/${esc(x.name)}</button>`
        + (x.hint ? `<span class="sk-hint">${esc(x.hint)}</span>` : '')
        + (x.plugin ? `<span class="sk-hint">${esc(x.plugin)}</span>` : '')
        + (x.description ? `<p class="sk-desc" title="Click to expand">${esc(x.description)}</p>` : '')
        + '</div>').join('')
      + '</div>';
  }).join('');
  $('skills-list').innerHTML = html || '<p class="pop-hint">No skills match.</p>';
}
$('skills-search').addEventListener('input', (e) => { SKILLS_SEARCH = e.target.value; renderSkills(); });
$('skills-list').addEventListener('click', (e) => {
  const name = e.target.closest('.sk-name');
  if (name) { copyText(name.dataset.copy).then((ok) => toast(ok ? `Copied ${name.dataset.copy}` : 'Couldn\'t copy')); return; }
  const d = e.target.closest('.sk-desc');
  if (d) d.classList.toggle('open');
});
function openSheet(sec = SHEET_SEC) {
  for (const b of $('ss-nav').querySelectorAll('button[data-sec]')) b.classList.toggle('hidden', !secAvailable(b.dataset.sec));
  $('setsheet').classList.remove('hidden');
  $('ss-scrim').classList.remove('hidden');
  showSection(sec);
  $('ss-close').focus();
}
function closeSheet() {
  if (!sheetOpen()) return;
  $('setsheet').classList.add('hidden');
  $('ss-scrim').classList.add('hidden');
  $('setbtn').focus();
}
$('setbtn').addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));
$('ss-close').addEventListener('click', closeSheet);
$('ss-scrim').addEventListener('click', closeSheet);
$('ss-nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-sec]'); if (b) showSection(b.dataset.sec); });
// Window capture runs before the drawer/viewer listeners on document, so one
// Escape closes the sheet and nothing behind it.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetOpen()) { e.stopPropagation(); closeSheet(); }
}, true);
// The gear gets a dot while the sheet is hiding cards (folder filter / columns).
function updateSetDot() {
  $('set-dot').classList.toggle('hidden', $('filter-badge').classList.contains('hidden') && $('cols-badge').classList.contains('hidden'));
}

// ---------- Folder filter popover (Board: projects · KB: collections) ----------
// Occasional-use filtering, so it lives behind a button next to Settings instead of
// a permanently-visible chip bar/sidebar — same tick-to-filter idea either mode, just
// pointed at whichever folder list the active mode has.
function activeFolders() {
  return STATE.mode === 'kb'
    ? { items: STATE.kb.collections.map((c) => ({ key: c.key, name: c.name, count: c.count })), filter: STATE.kb.collectionFilter }
    : { items: STATE.projects.map((p) => ({ key: p.name, name: p.name, count: p.count })), filter: STATE.projectFilter };
}
function updateFilterBadge() {
  const { filter } = activeFolders();
  const badge = $('filter-badge');
  badge.textContent = filter.size;
  badge.classList.toggle('hidden', filter.size === 0);
  updateSetDot();
}
function renderFilterList() {
  const { items, filter } = activeFolders();
  const q = FILTER_SEARCH.trim().toLowerCase();
  const shown = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
  $('filter-list').innerHTML = shown.length ? shown.map((it) => `
    <label class="filter-item">
      <input type="checkbox" data-k="${esc(it.key)}" ${filter.has(it.key) ? 'checked' : ''}>
      <span>${esc(it.name)}</span>
      <span class="n">${it.count}</span>
    </label>`).join('') : `<div class="empty">No folders match.</div>`;
  for (const el of $('filter-list').querySelectorAll('input[type=checkbox]')) {
    el.addEventListener('change', () => {
      if (el.checked) filter.add(el.dataset.k); else filter.delete(el.dataset.k);
      updateFilterBadge();
      if (STATE.mode === 'kb') renderKB(); else render();
    });
  }
}
$('filter-search').addEventListener('input', (e) => { FILTER_SEARCH = e.target.value; renderFilterList(); });
$('filter-all').addEventListener('click', () => {
  const { items, filter } = activeFolders();
  filter.clear();
  for (const it of items) filter.add(it.key);
  updateFilterBadge(); renderFilterList();
  if (STATE.mode === 'kb') renderKB(); else render();
});
$('filter-none').addEventListener('click', () => {
  activeFolders().filter.clear();
  updateFilterBadge(); renderFilterList();
  if (STATE.mode === 'kb') renderKB(); else render();
});

// ---------- Column visibility popover (Board only) ----------
// Separate from the folder filter above: this hides whole status columns rather
// than filtering cards within them (e.g. Done, once a task has its write-up and
// no longer needs a board slot). Persisted so the choice survives a reload.
const STATUS_LABELS = {
  backlog: 'Backlog', scheduled: 'Scheduled', 'in-progress': 'In Progress',
  blocked: 'Blocked', 'needs-decision': 'Needs Decision', review: 'Review', done: 'Done',
};
function saveHiddenColumns() {
  localStorage.setItem(hiddenColsKey(STATE.workspace), JSON.stringify([...STATE.hiddenColumns]));
}
// The badge counts everything this popover is keeping off the board — hidden columns plus
// the subtask toggle — so a collapsed board never looks like a board that's simply empty.
function updateColsBadge() {
  const badge = $('cols-badge');
  const n = STATE.hiddenColumns.size + (STATE.hideSubtasks ? 1 : 0);
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  updateSetDot();
}
function setHideSubtasks(on) {
  STATE.hideSubtasks = on;
  localStorage.setItem(hideSubtasksKey(STATE.workspace), on ? '1' : '0');
  updateColsBadge();
  renderSubtaskToggle();
  render();
}
// The count is of collapsible children, not of cards currently hidden: it stays truthful
// while a search or a batch filter is temporarily showing them again.
// Checked means "on the board", same as every column box below it in the popover — so the
// row is labelled Subtasks and unticking is what hides them, rather than a lone box whose
// tick means the opposite of its neighbours'.
function renderSubtaskToggle() {
  const n = collapsibleCount();
  $('show-subtasks').checked = !STATE.hideSubtasks;
  const count = $('subtasks-count');
  count.textContent = n;
  count.classList.toggle('hidden', n === 0);
  $('subtasks-row').classList.toggle('muted-row', n === 0);
  $('subtasks-row').title = n
    ? `${n} subtask card${n === 1 ? '' : 's'} on this board can fold into ${n === 1 ? 'its parent' : 'their parents'}`
    : 'No subtasks on this board yet';
}
$('show-subtasks').addEventListener('change', (e) => setHideSubtasks(!e.target.checked));
function renderColsList() {
  $('cols-list').innerHTML = STATE.statuses.map((s) => `
    <label class="filter-item">
      <input type="checkbox" data-s="${esc(s)}" ${STATE.hiddenColumns.has(s) ? '' : 'checked'}>
      <span>${esc(STATUS_LABELS[s] || s)}</span>
    </label>`).join('');
  for (const el of $('cols-list').querySelectorAll('input[type=checkbox]')) {
    el.addEventListener('change', () => {
      if (el.checked) STATE.hiddenColumns.delete(el.dataset.s); else STATE.hiddenColumns.add(el.dataset.s);
      saveHiddenColumns();
      updateColsBadge();
      render();
    });
  }
}
$('cols-all').addEventListener('click', () => {
  STATE.hiddenColumns.clear();
  saveHiddenColumns();
  STATE.hideSubtasks = false;        // "Show all" means all — it clears the badge it reads from
  localStorage.setItem(hideSubtasksKey(STATE.workspace), '0');
  updateColsBadge();
  renderColsList();
  renderSubtaskToggle();
  render();
});

// ========================================================================
// Board view
// ========================================================================
// ---------- Batches on the board ----------
// Mirrors batchKeyOf() in server.js: a parent answers to its own id, or its folder name
// when it has no id. Children name that value in `batch:`. Keep the two in step.
function batchKeyOf(t) { return t.id || t.name || ''; }

// batch value -> { total, done, blocked, parent }. Rebuilt at the top of every render()
// from STATE.tasks, so it can never disagree with the cards drawn from the same array.
let BATCH_INDEX = new Map();
function indexBatches() {
  const idx = new Map();
  for (const t of STATE.tasks) {
    if (!t.batch) continue;
    if (!idx.has(t.batch)) idx.set(t.batch, { total: 0, done: 0, blocked: 0, parent: null });
    const b = idx.get(t.batch);
    b.total++;
    if (t.status === 'done') b.done++;
    if (t.status === 'blocked') b.blocked++;
  }
  // Attach the parent card, if the batch has one. Most don't.
  for (const t of STATE.tasks) {
    const b = idx.get(batchKeyOf(t));
    if (b && !t.batch) b.parent = t;
  }
  BATCH_INDEX = idx;
}

// ---------- Collapsing subtasks into their parent ----------
// A batch fan-out puts 8-9 cards on the board for one piece of work, which buries the
// standalone tasks around them. With "Hide subtasks" on, those children come off the
// board and the parent's chip carries them instead ("8 subtasks · 3/8 done", now with a
// hidden marker) — so which cards have work behind them stays readable at a glance.
//
// Only children that HAVE a parent card collapse. A parentless batch (ceph, bonus-drills
// — see parentOfBatch() in server.js) has no other representation on the board, so hiding
// those would delete real work from view rather than fold it away.
function isCollapsibleChild(t) {
  if (!t.batch) return false;
  const b = BATCH_INDEX.get(t.batch);
  return !!(b && b.parent);
}

// The toggle yields to both of the ways you ask for a subtask by name: clicking a parent's
// chip (batch filter) and typing in the search box. Either one is an explicit "show me
// these", and a search that returned an empty board because the only matches were hidden
// would read as the app being broken.
function subtasksCollapsed() {
  return STATE.hideSubtasks && !STATE.batchFilter && !STATE.query.trim();
}

// How many cards the toggle is actually keeping off the board (parentless batches excluded,
// as above) — shown beside it so "Hide subtasks" isn't a switch with no visible effect on a
// board that has none.
function collapsibleCount() {
  return STATE.tasks.filter(isCollapsibleChild).length;
}

function visibleTasks() {
  const q = STATE.query.trim().toLowerCase();
  const collapse = subtasksCollapsed();
  return STATE.tasks.filter((t) => {
    if (collapse && isCollapsibleChild(t)) return false;
    // A batch filter narrows to that batch's children plus its parent card. Still separate
    // cards in their normal columns — this hides other work, never the batch's own.
    if (STATE.batchFilter && t.batch !== STATE.batchFilter && batchKeyOf(t) !== STATE.batchFilter) return false;
    if (STATE.projectFilter.size && !STATE.projectFilter.has(t.project)) return false;
    if (!q) return true;
    return [t.title, t.id, t.area, t.folder, t.owner, t.batch, t.host].join(' ').toLowerCase().includes(q);
  });
}

// Three independent things can narrow the board. Any of them being on is what makes the
// "Clear all filters" button appear.
function anyFilterActive() {
  return !!(STATE.batchFilter || STATE.query.trim() || STATE.projectFilter.size);
}

function clearAllFilters() {
  STATE.batchFilter = '';
  STATE.query = '';
  STATE.projectFilter.clear();
  $('search').value = '';       // the box keeps its text otherwise, and the board looks broken
  updateFilterBadge();
  if (secOpen('folders')) renderFilterList();
  render();
  $('board').scrollLeft = 0;
}

function setBatchFilter(batch) {
  STATE.batchFilter = batch || '';
  render();
  $('board').scrollLeft = 0;
}

// The bar that makes the filter escapable, and doubles as the batch's summary row.
function renderBatchBar() {
  const el = $('batch-bar');
  const b = STATE.batchFilter && BATCH_INDEX.get(STATE.batchFilter);
  if (!b) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const kids = STATE.tasks.filter((t) => t.batch === STATE.batchFilter);
  const allPaths = esc(kids.map((t) => t.path).join('\n')).replace(/\n/g, '&#10;');
  el.classList.remove('hidden');
  el.innerHTML = `
    <span class="bb-label">${ICONS.layers} ${esc(STATE.batchFilter)}</span>
    <span class="bb-summary">${b.done}/${b.total} done${b.blocked
      ? ` · <span class="st-blocked">${b.blocked} blocked</span>` : ''}</span>
    ${b.parent ? `<button type="button" class="bb-parent" data-path="${esc(b.parent.path)}">Open the parent task</button>` : ''}
    <button type="button" class="st-copyall" data-copy="${allPaths}"
      title="Copy all ${kids.length} vault paths, one per line">${ICONS.copy} Copy all ${kids.length} paths</button>
    <button type="button" class="bb-clear" title="Stop filtering to this batch.${STATE.hideSubtasks
      ? ' These subtasks fold back into their parent card.' : ''} Any search text or folder filter stays on — use Clear all filters in the header for those.">${ICONS.close} Clear batch</button>`;
  bindCopyButtons(el);
  const open = el.querySelector('.bb-parent');
  if (open) open.addEventListener('click', () => openTask(open.dataset.path));
  el.querySelector('.bb-clear').addEventListener('click', () => setBatchFilter(''));
}

// The chip a card carries. A parent gets the count of what is behind it; a child gets the
// batch it belongs to, so "clicking this opens a subtask" is readable before the click.
function batchChip(t) {
  const asParent = BATCH_INDEX.get(batchKeyOf(t));
  if (asParent && !t.batch) {
    // With the children collapsed this chip is the only thing on the board saying they
    // exist, so it says so louder: an eye-off marker, and a title that names the way back.
    const hidden = subtasksCollapsed();   // this card is the batch's parent, so its children are the collapsed ones
    return `<button type="button" class="batch-chip is-parent${hidden ? ' is-collapsed' : ''}" data-batch="${esc(batchKeyOf(t))}"
      title="${asParent.total} subtasks in this batch${hidden ? ', hidden from the board' : ''} — click to filter the board to them">${ICONS.layers} ${asParent.total} subtasks · ${asParent.done}/${asParent.total} done${hidden ? ICONS.eyeOff : ''}</button>`;
  }
  if (t.batch) {
    return `<button type="button" class="batch-chip is-child" data-batch="${esc(t.batch)}"
      title="Subtask of ${esc(t.batch)} — click to filter the board to that batch">${ICONS.subtask} ${esc(t.batch)}</button>`;
  }
  return '';
}

// Live agents by task path ({ id, state, since }), filled by workbench.js's
// poll of /api/term/list. A card shows a pill for the terminal "Start agent"
// opened on it; clicking the pill jumps to that terminal.
let TASK_AGENTS = {};
function agentPill(p) {
  const a = TASK_AGENTS[p];
  if (!a) return '';
  const text = { working: 'working', blocked: 'needs you', done: 'finished', idle: 'idle' }[a.state] || a.state;
  return `<button type="button" class="card-agent" data-agent="${esc(a.state)}" data-term="${esc(a.id)}" title="${esc(twAgentText(a.state, agentLabel()))} — click to go to its terminal"><span class="agent-dot" data-agent="${esc(a.state)}"></span>${esc(agentLabel() || 'Agent')} ${esc(text)}</button>`;
}
// Repaint just the pills, so a state change doesn't rebuild the whole board.
function paintCardAgents() {
  for (const el of $('board').querySelectorAll('.card')) {
    const old = el.querySelector(':scope > .card-agent');
    const html = agentPill(el.dataset.path);
    if (old && old.outerHTML === html) continue;
    if (old) old.remove();
    if (html) el.insertAdjacentHTML('beforeend', html);
  }
}
// Capture phase, so the card's own click (open the drawer) never sees it.
$('board').addEventListener('click', (e) => {
  const b = e.target.closest('.card-agent');
  if (!b) return;
  e.stopPropagation();
  goToAgent(b.dataset.term);
}, true);

function card(t) {
  const { done, total } = t.checklist;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const kbLink = t.articlePath
    ? `<a class="card-kb" data-article="${esc(t.articlePath)}" tabindex="0" title="Read the write-up in the Knowledge Base">${ICONS.book} Knowledge Base</a>`
    : (t.status === 'done' ? `<span class="card-kb muted" title="Done but no article yet">no article yet</span>` : '');
  return `
    <div class="card" draggable="true" tabindex="0" data-path="${esc(t.path)}" data-mtime="${t.mtime}">
      <h3>${esc(t.title)}</h3>
      <div class="row">
        ${t.id ? `<span class="tag">${esc(t.id)}</span>` : ''}
        ${t.area ? `<span class="tag">${esc(t.area)}</span>` : ''}
        <span class="tag pri-${esc(t.priority)}">${esc(t.priority)}</span>
      </div>
      ${(() => { const c = batchChip(t); return c ? `<div class="row batch-row">${c}${t.host ? `<span class="tag st-host">${esc(t.host)}</span>` : ''}</div>` : ''; })()}
      ${total ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}
      ${t.status === 'scheduled' && t.scheduled_for ? `<div class="scheduled-note">${ICONS.calendar} ${esc(t.scheduled_for)}</div>` : ''}
      ${t.blocked_by ? `<div class="blocked-on">${ICONS.ban} ${esc(t.blocked_by)}</div>` : ''}
      ${t.status === 'needs-decision' && t.decision_note ? `<div class="decision-note">${ICONS.help} ${esc(t.decision_note)}</div>` : ''}
      ${t.status === 'review' && t.review_note ? `<div class="review-note">${ICONS.eye} ${esc(t.review_note)}</div>` : ''}
      <div class="meta">
        ${total ? `<span>${done}/${total} done</span>` : '<span>no plan items</span>'}
        <span>·</span>
        <span>updated ${esc(t.updated || '—')}</span>
      </div>
      ${kbLink ? `<div class="card-foot">${kbLink}</div>` : ''}
      ${agentPill(t.path)}
    </div>`;
}

function updateBoardNav() {
  const board = $('board');
  const view = $('board-view');
  view.classList.toggle('board-scrollable', board.scrollWidth > board.clientWidth + 1);
  view.classList.toggle('board-at-start', board.scrollLeft <= 0);
  view.classList.toggle('board-at-end', board.scrollLeft + board.clientWidth >= board.scrollWidth - 1);
}
$('board').addEventListener('scroll', updateBoardNav);
window.addEventListener('resize', updateBoardNav);
$('board-prev').addEventListener('click', () => $('board').scrollBy({ left: -320, behavior: 'smooth' }));
$('board-next').addEventListener('click', () => $('board').scrollBy({ left: 320, behavior: 'smooth' }));

function render() {
  // The board's columns are new DOM nodes every render, so hold the reader's
  // place across the repaint — Refresh, a drag or a status change shouldn't
  // throw them back to the top of the column they were reading.
  const restore = holdScroll($('board'));
  // On a phone each column body is its own vertical scroller (see "Board
  // columns" in styles.css), so hold those too, keyed by status: a hidden
  // column or a filter can shift the positions between renders.
  const colTops = new Map([...$('board').querySelectorAll('.col-body')].map((b) => [b.dataset.status, b.scrollTop]));
  indexBatches();          // before visibleTasks()/card() — both read BATCH_INDEX
  updateFilterBadge();
  updateColsBadge();
  if (secOpen('folders')) renderFilterList();
  if (secOpen('cols')) renderColsList();
  // Unconditional: the subtask row carries a count off STATE.tasks, and its checkbox has to
  // be right the first time the popover opens after a reload, not one render behind.
  renderSubtaskToggle();
  const tasks = visibleTasks();
  // "12 of 95 tasks" whenever anything is hiding cards. The bare count used to be the only
  // feedback, so a leftover search behind a cleared batch filter read as an empty board.
  // Done cards are left out of the count entirely: the number is "what's still outstanding",
  // not the workspace's full history.
  // Only on the Board: the board repaints behind other modes too (a workspace switch, a poll),
  // and Today owns the count slot while it's showing.
  const open = tasks.filter((t) => t.status !== 'done').length;
  const allOpen = STATE.tasks.filter((t) => t.status !== 'done').length;
  if (STATE.mode === 'board') {
    $('count').textContent = allOpen - open
      ? `${open} of ${allOpen} open tasks`
      : `${open} open task${open === 1 ? '' : 's'}`;
  }
  $('clear-filters').classList.toggle('hidden', STATE.mode !== 'board' || !anyFilterActive());

  const statuses = STATE.statuses.filter((s) => !STATE.hiddenColumns.has(s));
  $('board').innerHTML = statuses.map((s) => {
    const inCol = tasks
      .filter((t) => t.status === s)
      .sort((a, b) => (a.updated || '').localeCompare(b.updated || '') || a.title.localeCompare(b.title));
    return `
      <section class="col">
        <div class="col-head">
          <span class="dot" style="background: var(--${s})"></span>
          ${esc(s.replace('-', ' '))}
          <span class="n">${inCol.length}</span>
        </div>
        <div class="col-body" data-status="${esc(s)}">
          ${inCol.length ? inCol.map(card).join('') : '<div class="empty">Nothing here</div>'}
        </div>
      </section>`;
  }).join('');

  for (const el of $('board').querySelectorAll('.card')) {
    el.addEventListener('click', () => openTask(el.dataset.path));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;   // Enter on a button inside the card is that button's
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(el.dataset.path); }
    });
    el.addEventListener('dragstart', (e) => {
      DRAG = { path: el.dataset.path, mtime: Number(el.dataset.mtime) };
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); DRAG = null; });
  }
  // Batch chip filters the board; it must not also open the card it sits on.
  for (const el of $('board').querySelectorAll('.batch-chip')) {
    el.addEventListener('click', (e) => { e.stopPropagation(); setBatchFilter(el.dataset.batch); });
  }
  // KB shortcut on done cards — don't let it open the task drawer.
  for (const el of $('board').querySelectorAll('.card-kb[data-article]')) {
    el.addEventListener('click', (e) => { e.stopPropagation(); setMode('kb'); openArticle(el.dataset.article); });
  }

  for (const col of $('board').querySelectorAll('.col-body')) {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      if (!DRAG) return;
      const status = col.dataset.status;
      const moving = DRAG;
      DRAG = null;
      const task = STATE.tasks.find((t) => t.path === moving.path);
      if (!task || task.status === status) return;
      try {
        const updated = await api(ws('/api/task/status'), {
          method: 'POST',
          body: JSON.stringify({ path: moving.path, status, mtime: moving.mtime }),
        });
        Object.assign(task, updated);
        render();
      } catch (err) {
        toast(err.message);
        load();
      }
    });
  }
  renderBatchBar();
  restore();   // before the tabs/nav read scroll state, so they agree with it
  for (const b of $('board').querySelectorAll('.col-body')) {
    const top = colTops.get(b.dataset.status);
    if (top) b.scrollTop = top;
  }
  updateBoardNav();
}

// ---------- Toast ----------
let TOAST_T;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---------- Copy to clipboard ----------
// Vault paths contain spaces ("Projects/2. home-server/..."), so a double-click
// selects one word and stops at the first space — there is no way to select a path by
// hand. Every path this app renders therefore needs a button, which makes this helper
// load-bearing rather than a nicety.
//
// navigator.clipboard only exists in a secure context. The board is reachable at
// plain http (a reverse proxy that answers :80 without redirecting to https), where
// it is undefined — so the execCommand path is the one that actually runs for a good
// share of real use, not a legacy fallback. Don't delete it.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the textarea */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    // Off-screen but focusable: display:none or visibility:hidden can't be selected.
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Wire a button whose data-copy holds exactly the text to copy. The tick is the whole
// feedback — a toast on every path copy would fire N times during a fan-out.
function bindCopyButtons(root) {
  for (const btn of root.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await copyText(btn.dataset.copy);
      if (!ok) { toast('Could not copy — your browser blocked clipboard access'); return; }
      if (btn.dataset.copied) return;       // already ticking; don't stack timers
      btn.dataset.copied = '1';
      const was = btn.innerHTML;
      btn.innerHTML = ICONS.check;
      setTimeout(() => { btn.innerHTML = was; delete btn.dataset.copied; }, 1200);
    });
  }
}

// ---------- Task drawer ----------
// Three ways to view a task, Notion-style: side peek, centre peek, full page.
// The choice persists and applies to every task until changed.
const TASK_VIEWS = ['side', 'center', 'full'];
let TASKVIEW = localStorage.getItem('vaultboard.taskview') || 'side';

function applyTaskView(v) {
  TASKVIEW = TASK_VIEWS.includes(v) ? v : 'side';
  localStorage.setItem('vaultboard.taskview', TASKVIEW);
  const d = $('drawer');
  for (const view of TASK_VIEWS) d.classList.toggle('view-' + view, view === TASKVIEW);
  for (const b of document.querySelectorAll('.viewseg button')) {
    b.classList.toggle('on', b.dataset.v === TASKVIEW);
  }
}
applyTaskView(TASKVIEW);
for (const b of document.querySelectorAll('.viewseg button')) {
  b.addEventListener('click', () => applyTaskView(b.dataset.v));
}

async function openTask(p) {
  let t;
  try { t = await api(ws('/api/task?path=' + encodeURIComponent(p))); }
  catch (err) { toast(err.message); return; }
  // Repainting the task that's already on screen (a status change writes the
  // file, then reopens it) should leave you where you were reading; opening a
  // different task, or reopening a closed one, starts at the top.
  const inPlace = !!OPEN && OPEN.path === t.path && !$('drawer').classList.contains('hidden');
  showTask(t, { keepScroll: inPlace });
  $('drawer').classList.remove('hidden');
  $('scrim').classList.remove('hidden');
  if (!inPlace) $('drawer').scrollTop = 0;   // showTask's reset ran while the drawer still had no layout box
}

// Back up one level, from a subtask to the task its `batch:` names. One level only —
// batches don't nest, so this is a single link, not a breadcrumb trail.
function renderParentLink(t) {
  const el = $('d-parent');
  if (!t.parent) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <button type="button" class="d-back" data-path="${esc(t.parent.path)}">
      ${ICONS.arrowLeft}<span class="dot" style="background: var(--${esc(t.parent.status)})"></span>
      <span class="d-back-title">${esc(t.parent.title)}</span>
    </button>
    <button type="button" class="st-copy" data-copy="${esc(t.parent.path)}"
      title="Copy ${esc(t.parent.path)}" aria-label="Copy the parent task's vault path">${ICONS.copy}</button>`;
  el.querySelector('.d-back').addEventListener('click', (e) => openTask(e.currentTarget.dataset.path));
  bindCopyButtons(el);
}

// ---------- Subtasks (batch fan-out) ----------
// A batch is N sibling task.md files that each carry `batch: <this task's id>`. They stay
// real cards in their normal columns; this section is the dispatch surface — one row per
// subtask with its status, the box it runs on, and the one thing that gets pasted into a
// terminal: the vault path to its task.md. Nothing else. No cd, no ssh, no command.
//
// `host` is a label so the user knows which terminal is which. It is never part of a copy.
function renderSubtasks(t) {
  const el = $('d-subtasks');
  const subs = t.subtasks || [];
  // The overwhelmingly common case — a standalone task with no children — renders nothing
  // at all, not an empty section. 164 of the vault's 165 task.md files are this today.
  if (!subs.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const done = subs.filter((s) => s.status === 'done').length;
  const blocked = subs.filter((s) => s.status === 'blocked').length;
  // A newline inside an HTML attribute survives parsing, but spell it out rather than
  // relying on that: this string is the whole point of the button.
  const allPaths = esc(subs.map((s) => s.path).join('\n')).replace(/\n/g, '&#10;');
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="st-head">
      <span class="st-label">${ICONS.layers} Subtasks <span class="n">${subs.length}</span></span>
      <span class="st-summary">${done}/${subs.length} done${blocked
        ? ` · <span class="st-blocked">${blocked} blocked</span>` : ''}</span>
      <button type="button" class="st-copyall" data-copy="${allPaths}"
        title="Copy all ${subs.length} vault paths, one per line">${ICONS.copy} Copy all ${subs.length} paths</button>
    </div>
    <ul class="st-list">
      ${subs.map((s) => `
        <li class="st-row" data-path="${esc(s.path)}" tabindex="0">
          <span class="dot" style="background: var(--${esc(s.status)})" title="${esc(STATUS_LABELS[s.status] || s.status)}"></span>
          <span class="st-name">${esc(s.title)}</span>
          ${s.host ? `<span class="tag st-host" title="Runs on ${esc(s.host)}">${esc(s.host)}</span>` : ''}
          <button type="button" class="st-copy" data-copy="${esc(s.path)}"
            title="Copy ${esc(s.path)}" aria-label="Copy vault path for ${esc(s.title)}">${ICONS.copy}</button>
        </li>`).join('')}
    </ul>`;
  bindCopyButtons(el);
  for (const row of el.querySelectorAll('.st-row')) {
    row.addEventListener('click', () => openTask(row.dataset.path));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTask(row.dataset.path); }
    });
  }
}

// ---------- Status section (task drawer) ----------
// The card you clicked came out of a column, but once the drawer is open — or once
// it's been open a while, or was reached from a subtask row or a parent link — there
// was nothing on the page saying which column that was. The facts row states it,
// colour-coded to match the board, and carries the one line of context the column
// implies a
// question about ("blocked on what?", "scheduled for when?").
//
// Each entry returns [icon, text] or nothing. Same fields the cards use, so a note
// never appears in one place and not the other.
const STATUS_NOTE = {
  blocked: (t) => t.blocked_by && ['ban', 'Blocked on ' + t.blocked_by],
  scheduled: (t) => t.scheduled_for && ['calendar', 'Scheduled for ' + t.scheduled_for],
  'needs-decision': (t) => t.decision_note && ['help', t.decision_note],
  review: (t) => t.review_note && ['eye', t.review_note],
};

// The column's own note, plus — always — a `blocked_by`, which the cards render
// under every status. Two notes rather than one: a task in Review that's also
// waiting on someone needs to say both, and the old single-note version let the
// column's note swallow the blocked_by entirely.
function statusNotes(t) {
  const notes = [];
  const own = STATUS_NOTE[t.status] ? STATUS_NOTE[t.status](t) : null;
  if (own) notes.push(own);
  // Outside the Blocked column the note is about waiting, not about the column it's
  // sitting in, so it keeps the danger colour rather than borrowing that column's.
  if (t.blocked_by && t.status !== 'blocked') notes.push(['ban', 'Blocked on ' + t.blocked_by, true]);
  return notes;
}

// One row of facts under the title: the status chip, then the frontmatter the card
// already shows, in the card's own quiet vocabulary. This used to be two stacked
// rows — an "On the board" label, then a strip of four bordered `key: value` pills —
// which read as congested above the task itself. What changed:
//   · the label is gone; a coloured, named chip doesn't need announcing
//   · `area` and a non-default `priority` stay chips, exactly as on the card, so the
//     open task looks like the card it was opened from
//   · `priority: med` is dropped — it's the fallback for every task that never set
//     one, so it was noise on most of the board
//   · owner and updated become the same muted ·-separated run the card foots with
// Notes keep a line of their own below: a `blocked_by` can run to a paragraph.
function renderFacts(t) {
  const el = $('d-facts');
  const notes = statusNotes(t);
  // One custom property feeds the dot, the tint and the note colour, so every status
  // reads from the same board token (and flips correctly in Sepia). It's set on the
  // wrapper rather than the chip so the notes below inherit it too.
  el.style.setProperty('--s', `var(--${t.status})`);
  const quiet = [t.owner, t.updated ? 'updated ' + t.updated : ''].filter(Boolean);
  el.innerHTML = `
    <div class="d-facts-row">
      <span class="d-status-chip">
        <span class="dot"></span>
        <span class="d-status-name">${esc(STATUS_LABELS[t.status] || t.status)}</span>
        ${ICONS.chevron}
        <select id="d-status-select" class="d-status-select" title="Move this task to another column" aria-label="Move this task to another column">
          ${STATE.statuses.map((s) => `<option value="${esc(s)}" ${s === t.status ? 'selected' : ''}>${esc(STATUS_LABELS[s] || s)}</option>`).join('')}
        </select>
      </span>
      ${t.area ? `<span class="tag">${esc(t.area)}</span>` : ''}
      ${t.priority && t.priority !== 'med' ? `<span class="tag pri-${esc(t.priority)}">${esc(t.priority)}</span>` : ''}
      ${quiet.length ? `<span class="d-fact-text">${quiet.map((v) => esc(v)).join('<span class="sep">·</span>')}</span>` : ''}
    </div>
    ${notes.length ? `<div class="d-notes">${notes.map(([icon, text, warn]) =>
      `<span class="d-status-note${warn ? ' warn' : ''}">${ICONS[icon]} ${esc(text)}</span>`).join('')}</div>` : ''}`;
  $('d-status-select').addEventListener('change', async (e) => {
    const status = e.target.value;
    if (status === t.status) return;
    const select = e.target;
    select.disabled = true;
    try {
      const updated = await api(ws('/api/task/status'), {
        method: 'POST',
        body: JSON.stringify({ path: OPEN.path, status, mtime: OPEN.mtime }),
      });
      const task = STATE.tasks.find((x) => x.path === updated.path);
      if (task) Object.assign(task, updated);
      render();
      await openTask(OPEN.path); // repaint the drawer with the fresh body/progress log
    } catch (err) {
      select.value = t.status;
      select.disabled = false;
      toast(err.message);
    }
  });
}

// Paint (or repaint) the drawer from a full task payload — used on open, on the
// drawer refresh button, and after posting a comment.
function showTask(t, { keepScroll = false } = {}) {
  const restore = keepScroll ? holdScroll($('drawer')) : null;
  $('d-title').textContent = t.title;
  // The parent's own path gets a button for the same reason its children's do — the
  // spaces in "2. home-server" make it unselectable by double-click.
  $('d-path').innerHTML = `<span class="path-text">${esc(t.path)}</span>`
    + `<button type="button" class="path-copy" data-copy="${esc(t.path)}"`
    + ` title="Copy ${esc(t.path)}" aria-label="Copy vault path">${ICONS.copy}</button>`;
  bindCopyButtons($('d-path'));
  renderFacts(t);
  $('d-kb-link').innerHTML = t.articlePath
    ? `<a class="kb-open-btn" data-article="${esc(t.articlePath)}" tabindex="0">${ICONS.book} Read the Knowledge Base article →</a>` : '';
  const kbBtn = $('d-kb-link').querySelector('[data-article]');
  if (kbBtn) kbBtn.addEventListener('click', () => { closeDrawer(); setMode('kb'); openArticle(kbBtn.dataset.article); });
  renderParentLink(t);
  renderSubtasks(t);
  renderWorkbenchLinks(t);
  const docs = t.docs || [];
  $('d-docs').innerHTML = docs.length
    ? `<div class="d-docs-list">${docs.map((d) =>
        `<button class="d-doc" data-path="${esc(d.path)}">${ICONS.file} ${esc(d.name)}</button>`).join('')}</div>`
    : '';
  for (const el of $('d-docs').querySelectorAll('.d-doc')) {
    el.addEventListener('click', () => openDoc(el.dataset.path));
  }
  $('d-body').innerHTML = t.html;
  OPEN = { path: t.path, mtime: t.mtime };
  if (restore) restore(); else $('drawer').scrollTop = 0;
  const diagrams = hydrateDiagrams($('d-body'));
  if (restore) diagrams.then(restore, restore);   // re-pin once diagrams change the height

  const boxes = [...$('d-body').querySelectorAll('input[type="checkbox"]')];
  boxes.forEach((cb, i) => {
    cb.disabled = false;
    cb.addEventListener('change', async () => {
      cb.disabled = true;
      try {
        const updated = await api(ws('/api/task/check'), {
          method: 'POST',
          body: JSON.stringify({ path: OPEN.path, index: i, checked: cb.checked, mtime: OPEN.mtime }),
        });
        OPEN.mtime = updated.mtime;
        const task = STATE.tasks.find((x) => x.path === updated.path);
        if (task) Object.assign(task, updated);
        render();
      } catch (err) {
        cb.checked = !cb.checked;
        toast(err.message);
      } finally {
        cb.disabled = false;
      }
    });
  });
}

function closeDrawer() {
  $('drawer').classList.add('hidden');
  $('scrim').classList.add('hidden');
}
$('d-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // The diagram viewer sits above the drawer and owns Escape while it's open,
  // so one press closes the diagram and leaves the task underneath it.
  if (DGV) return;
  closeDrawer();
});

$('d-refresh').addEventListener('click', () => {
  if (!OPEN) return;
  withRefreshFeedback($('d-refresh'), async () => {
    showTask(await api(ws('/api/task?path=' + encodeURIComponent(OPEN.path))), { keepScroll: true });
  });
});

// ========================================================================
// Knowledge Base view
// ========================================================================
function setMode(mode) {
  if (mode === 'today' && !todayOn()) mode = 'board';   // Today is off: nothing to show (a Refresh's 'today' too)
  // Leaving Files: the spreadsheet grid on screen closes its editor (see SheetFiles.beforeViewChange).
  if (STATE.mode === 'files' && mode !== 'files' && window.SheetFiles) SheetFiles.beforeViewChange(null, null);
  STATE.mode = mode;
  $('mode-today').classList.toggle('active', mode === 'today');
  $('mode-board').classList.toggle('active', mode === 'board');
  $('mode-kb').classList.toggle('active', mode === 'kb');
  $('mode-files').classList.toggle('active', mode === 'files');
  $('today-view').classList.toggle('hidden', mode !== 'today');
  $('board-view').classList.toggle('hidden', mode !== 'board');
  $('kb-view').classList.toggle('hidden', mode !== 'kb');
  $('files-view').classList.toggle('hidden', mode !== 'files');
  // The header is shared, but "Clear all filters" only means anything on the board.
  $('clear-filters').classList.toggle('hidden', mode !== 'board' || !anyFilterActive());
  $('search').placeholder = { kb: 'Search the knowledge base…', files: 'Find a file…' }[mode] || 'Search tasks…';
  $('search').value = { kb: STATE.kb.query, files: FX.query }[mode] ?? STATE.query;
  $('search').classList.toggle('hidden', mode === 'today');   // nothing to search on Today
  document.body.dataset.mode = mode;
  closeSheet();   // its folder/column sections depend on the mode (see secAvailable)
  updateFilterBadge();
  if (mode === 'today') Today.show(); else Today.hide();   // Today.show() fills #count from its payload
  if (mode === 'kb') {
    $('count').textContent = `${STATE.kb.articles.length} article${STATE.kb.articles.length === 1 ? '' : 's'}`;
    if (!STATE.kb.loaded) loadKB();
  } else if (mode === 'files') {
    $('count').textContent = '';
    if (!FX.loaded) fxLoad(); else fxRenderAll();
  } else if (mode === 'board') {
    if (!STATE.loaded) load(); else render();
  }
}
$('mode-today').addEventListener('click', () => setMode('today'));
$('mode-board').addEventListener('click', () => setMode('board'));
$('mode-kb').addEventListener('click', () => setMode('kb'));
$('mode-files').addEventListener('click', () => setMode('files'));

// ---------- Mobile nav ----------
// The phone's bottom tab bar. Each button clicks its header twin (so every
// listener on #mode-* and #termbtn — workbench.js has some — still runs once),
// and the active state is read back off those twins rather than tracked twice.
const MNAV = [...document.querySelectorAll('#mobile-nav button')];
function syncMobileNav() {
  for (const b of MNAV) {
    const twin = $(b.dataset.for);
    const on = b.dataset.for === 'termbtn' ? twin.getAttribute('aria-pressed') === 'true' : twin.classList.contains('active');
    b.classList.toggle('active', on);
    if (b.dataset.for === 'termbtn') { b.dataset.n = twin.dataset.n || ''; b.dataset.alert = twin.dataset.alert || ''; }
  }
}
for (const b of MNAV) b.addEventListener('click', () => {
  // A mode tab while the full-screen terminal is up means "take me there", so
  // it minimises the terminal as well (the shells keep running).
  // Same for an open task sheet, which would otherwise sit over the new mode.
  if (b.dataset.for !== 'termbtn' && $('termbtn').getAttribute('aria-pressed') === 'true') $('termbtn').click();
  if (b.dataset.for !== 'termbtn' && !$('drawer').classList.contains('hidden')) closeDrawer();
  $(b.dataset.for).click();
});
new MutationObserver(syncMobileNav).observe($('termbtn'), { attributes: true, attributeFilter: ['aria-pressed', 'data-n', 'data-alert'] });
for (const id of ['mode-today', 'mode-board', 'mode-files', 'mode-kb']) new MutationObserver(syncMobileNav).observe($(id), { attributes: true, attributeFilter: ['class'] });

// ---------- KB sidebar (collections/article list) ----------
// Closed by default; opens as a hover panel over the reader rather than
// pushing it. The open/closed choice persists like the other reading prefs.
function applyKbSidebarClass() {
  const open = STATE.kb.sidebarOpen;
  document.querySelector('#kb-view .kb-layout').classList.toggle('kb-sidebar-open', open);
  $('kb-sidebar-toggle').setAttribute('aria-expanded', String(open));
  $('kb-sidebar-toggle').title = open ? 'Hide collections' : 'Browse collections';
}
function setKbSidebar(open) {
  STATE.kb.sidebarOpen = open;
  localStorage.setItem('vaultboard.kbSidebarOpen', open ? '1' : '0');
  applyKbSidebarClass();
}
applyKbSidebarClass();
$('kb-sidebar-toggle').addEventListener('click', () => setKbSidebar(!STATE.kb.sidebarOpen));
$('kb-scrim').addEventListener('click', () => setKbSidebar(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && STATE.mode === 'kb' && STATE.kb.sidebarOpen && !DGV && !DOCV) setKbSidebar(false);
});

async function loadKB(q) {
  const data = await api(ws('/api/kb' + (q ? '?q=' + encodeURIComponent(q) : '')));
  STATE.kb.collections = data.collections;
  STATE.kb.articles = data.articles;
  STATE.kb.loaded = true;
  renderKB();
  if (!STATE.kb.article) renderKBWelcome();
  // A load still in flight when you switch away mustn't overwrite the next mode's count.
  if (STATE.mode === 'kb') $('count').textContent = `${data.articles.length} article${data.articles.length === 1 ? '' : 's'}`;
}

// ---------- KB welcome dashboard ----------
// Read history lives client-side only (this is a single-user app behind one
// shared password, so there's no per-account server state to hang it off) —
// a map of article path → the timestamp it was last opened.
function kbReadMap() {
  try { return JSON.parse(localStorage.getItem('vaultboard.kbReads') || '{}'); }
  catch { return {}; }
}
function markArticleRead(p) {
  const map = kbReadMap();
  map[p] = Date.now();
  try { localStorage.setItem('vaultboard.kbReads', JSON.stringify(map)); } catch {}
}
function readStaleness(p, reads) {
  const last = reads[p];
  if (!last) return 'Not read yet';
  const days = Math.floor((Date.now() - last) / 86400000);
  if (days <= 0) return 'Read today';
  if (days === 1) return 'Read 1 day ago';
  if (days < 30) return `Read ${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Read ${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `Read ${years} year${years === 1 ? '' : 's'} ago`;
}
// Never-read articles first, then whichever read article has gone longest
// without a revisit — ties among never-read broken toward the newest content.
function recommendedArticles(arts, reads) {
  return [...arts]
    .map((a) => ({ a, last: reads[a.path] || 0 }))
    .sort((x, y) => x.last - y.last || (y.a.updated || '').localeCompare(x.a.updated || ''))
    .map((x) => x.a);
}

async function paintSpotlightDiagram(pick) {
  const slot = $('kb-spotlight-slot');
  if (!slot) return;
  try {
    const d = DIAGRAMS.get(pick.path) || await api(ws('/api/diagram?path=' + encodeURIComponent(pick.path)));
    DIAGRAMS.set(pick.path, d);
    const [, , vw, vh] = d.viewBox;
    slot.style.aspectRatio = `${vw} / ${vh}`;
    slot.innerHTML = d.svg;
    const el = slot.querySelector('svg');
    if (el) fluidSvg(el);
  } catch {
    slot.innerHTML = `<span class="diagram-loading">Diagram unavailable</span>`;
  }
}

// Return to the KB dashboard from an open article — clears the open article,
// restores the tab title, and repaints the welcome dashboard.
function goToKBHome() {
  STATE.kb.article = null;
  document.title = 'VaultOS';
  renderKB();
  renderKBWelcome();
  $('kb-reader').scrollTop = 0;   // a new page, not a refresh — start at the top
  window.scrollTo(0, 0);
}

// The landing state of the reader: not a static blurb, but a small dashboard —
// what's worth picking back up, one diagram surfaced at random, and the shape
// of the collections. Only painted while no article is open.
function renderKBWelcome() {
  if (STATE.kb.article) return;
  const arts = STATE.kb.articles;
  const collections = STATE.kb.collections;
  const reads = kbReadMap();
  // While searching, the server's order is the ranking: show it as Best matches
  // instead of re-sorting by date, and drop the reading picks.
  const searching = !!STATE.kb.query;
  const picks = searching ? [] : recommendedArticles(arts, reads).slice(0, 3);
  const withDiagrams = arts.flatMap((a) => (a.diagrams || []).map((d) => ({ ...d, article: a })));
  const diagramPick = withDiagrams.length ? withDiagrams[Math.floor(Math.random() * withDiagrams.length)] : null;

  // Re-rendering (e.g. on every search keystroke) replaces the dash search
  // input wholesale — capture focus/cursor here and restore it after so
  // typing doesn't get interrupted mid-word.
  const active = document.activeElement;
  const restoreFocus = active && active.id === 'kb-dash-search'
    ? { start: active.selectionStart, end: active.selectionEnd } : null;

  // Each collection keeps one hue everywhere on the dashboard (cards, timeline,
  // collection tiles), by its position in the list — the keys are numbered, so
  // the order and the colours are stable.
  const hueOf = new Map(collections.map((c, i) => [c.key, `var(--kb-c${(i % 6) + 1})`]));
  const hue = (a) => hueOf.get(a.collection) || 'var(--brand)';
  const unread = arts.filter((a) => !reads[a.path]).length;
  const pickPaths = new Set(picks.map((a) => a.path));
  const latest = searching ? arts.slice(0, 8) : [...arts]
    .filter((a) => !pickPaths.has(a.path))
    .sort((x, y) => (y.updated || '').localeCompare(x.updated || '') || (y.mtime || 0) - (x.mtime || 0))
    .slice(0, 5);
  const newestIn = new Map();
  for (const a of arts) {
    const cur = newestIn.get(a.collection);
    if (!cur || (a.updated || '') > (cur.updated || '')) newestIn.set(a.collection, a);
  }
  const maxCount = Math.max(1, ...collections.map((c) => c.count));
  const when = (d) => {
    if (!d) return '';
    const days = Math.round((new Date(new Date().toDateString()) - new Date(d + 'T00:00:00')) / 86400000);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  // Only animate the first paint — the dashboard is rebuilt on every search
  // keystroke and shouldn't replay its entrance each time.
  const enter = !$('kb-reader').querySelector('.kb-dash');

  // Same boxes as the Board: each section is a .col panel with a .col-head,
  // and everything clickable inside it is a .card — one visual language
  // across both modes. The collection's hue rides on the meta-row dot, the
  // way a status colour does on a board column.
  const metaRow = (a, right) => `<div class="meta"><span class="kb-meta-coll"><span class="dot" style="background:${hue(a)}"></span>${esc(a.collectionName)}</span><span class="kb-meta-right">${right}</span></div>`;
  const recCard = (a, i) => `
    <button type="button" class="card kb-card${i === 0 ? ' kb-card-lead' : ''}" data-path="${esc(a.path)}">
      <h3>${esc(a.title)}</h3>
      ${a.excerpt ? `<p class="kb-card-ex">${esc(a.excerpt.replace(/^TL;DR\s*/i, ''))}</p>` : ''}
      ${i === 0 && a.stack.length ? `<div class="row kb-card-tags">${a.stack.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${metaRow(a, reads[a.path] ? esc(readStaleness(a.path, reads)) : '<span class="kb-unread">Not read yet</span>')}
    </button>`;
  const col = (title, n, body, extra = '') => `
    <section class="col kb-col ${extra}">
      <div class="col-head"><span class="dot" style="background:var(--brand)"></span>${title}${n != null ? `<span class="n">${n}</span>` : ''}</div>
      <div class="col-body">${body}</div>
    </section>`;

  const stat = (n, label) => `<div class="kb-stat"><b>${n}</b><span>${label}</span></div>`;

  $('kb-reader').innerHTML = `
    <div class="kb-dash${enter ? ' kb-dash-enter' : ''}">
      <div class="kb-hero">
        <span class="kb-eyebrow">Knowledge Base</span>
        ${STATE.kb.query ? `<h2>Results for “${esc(STATE.kb.query)}”</h2>` : ''}
        <div class="kb-stats">
          ${stat(arts.length, arts.length === 1 ? 'article' : 'articles')}
          ${stat(collections.length, collections.length === 1 ? 'collection' : 'collections')}
          ${stat(withDiagrams.length, withDiagrams.length === 1 ? 'diagram' : 'diagrams')}
          ${stat(unread, 'unread')}
        </div>
        <div class="kb-dash-searchbar">
          <span class="kb-dash-search-icon">${ICONS.search}</span>
          <input type="search" id="kb-dash-search" placeholder="Search every article, stack and diagram…" value="${esc(STATE.kb.query)}">
        </div>
      </div>
      <div class="kb-cols">
        ${picks.length ? col('Pick this up again', picks.length, picks.map(recCard).join(''), 'kb-col-picks') : ''}
        ${latest.length ? col(searching ? 'Best matches' : 'Latest', latest.length, latest.map((a) => `
          <button type="button" class="card kb-card kb-card-row" data-path="${esc(a.path)}">
            <h3>${esc(a.title)}</h3>
            ${metaRow(a, esc(when(a.updated)))}
          </button>`).join(''), 'kb-col-latest') : ''}
        ${diagramPick ? col('From the archive', null, `
          <button type="button" class="card kb-card kb-spotlight" data-path="${esc(diagramPick.article.path)}" title="Open the article this diagram is from">
            <span class="kb-spotlight-slot" id="kb-spotlight-slot"><span class="diagram-loading">Loading diagram…</span></span>
            <span class="kb-spotlight-cap">
              <h3>${esc(diagramPick.caption || diagramPick.article.title)}</h3>
              <span class="kb-card-ex">${esc(diagramPick.article.title)}</span>
              ${metaRow(diagramPick.article, '')}
            </span>
          </button>`, 'kb-col-wide') : ''}
        ${collections.length ? col('Collections', collections.length, `<div class="kb-coll-grid">${collections.map((c) => {
          const top = newestIn.get(c.key);
          return `<button type="button" class="card kb-card kb-coll-card" data-key="${esc(c.key)}">
            <div class="kb-coll-head"><span class="dot" style="background:${hueOf.get(c.key)}"></span><h3>${esc(c.name)}</h3><span class="kb-coll-n">${c.count}</span></div>
            <div class="bar"><i style="width:${Math.round(c.count / maxCount * 100)}%;background:${hueOf.get(c.key)}"></i></div>
            ${top ? `<div class="meta"><span class="kb-meta-latest">Latest · ${esc(top.title)}</span></div>` : ''}
          </button>`;
        }).join('')}</div>`, 'kb-col-wide') : ''}
      </div>
    </div>`;

  for (const el of $('kb-reader').querySelectorAll('.kb-card[data-path]:not(.kb-spotlight)')) {
    el.addEventListener('click', () => openArticle(el.dataset.path));
  }
  const spot = $('kb-reader').querySelector('.kb-spotlight');
  if (spot) {
    spot.addEventListener('click', () => openArticle(spot.dataset.path));
    paintSpotlightDiagram(diagramPick);
  }
  for (const el of $('kb-reader').querySelectorAll('.kb-coll-card')) {
    el.addEventListener('click', () => {
      STATE.kb.collectionFilter = new Set([el.dataset.key]);
      updateFilterBadge();
      setKbSidebar(true);
      renderKB();
    });
  }
  const dashSearch = $('kb-dash-search');
  if (dashSearch) {
    dashSearch.addEventListener('input', (e) => {
      $('search').value = e.target.value;
      kbSearch(e.target.value);
    });
    if (restoreFocus) {
      dashSearch.focus();
      dashSearch.setSelectionRange(restoreFocus.start, restoreFocus.end);
    }
  }
}

function renderKB() {
  const k = STATE.kb;
  // The list's scroller is thrown away and rebuilt below, so its offset has to
  // travel by value — holdScroll can't hold on to a node that won't exist.
  const listTop = $('kb-list').querySelector('.kb-list-items')?.scrollTop || 0;
  updateFilterBadge();
  if (secOpen('folders')) renderFilterList();

  const list = k.articles.filter((a) => !k.collectionFilter.size || k.collectionFilter.has(a.collection));
  const items = list.length ? list.map((a) => `
    <button class="kb-item ${k.article === a.path ? 'active' : ''}" data-path="${esc(a.path)}">
      <div class="kb-item-top">
        <span class="kb-item-coll">${esc(a.collectionName)}</span>
        <span class="kb-item-date">${esc(a.updated || '')}</span>
      </div>
      <h3>${esc(a.title)}</h3>
      ${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ''}
      ${a.stack.length ? `<div class="kb-chips">${a.stack.slice(0, 5).map((s) => `<span class="chip-stack">${esc(s)}</span>`).join('')}</div>` : ''}
    </button>`).join('')
    : `<div class="empty">No articles${k.query ? ' match your search' : ' here yet'}.</div>`;
  $('kb-list').innerHTML = `
    <div class="kb-list-head">
      <span class="kb-list-count">${list.length} article${list.length === 1 ? '' : 's'}</span>
      <button id="kb-list-close" class="kb-list-close" type="button" title="Close" aria-label="Close collections panel">${ICONS.close}</button>
    </div>
    <div class="kb-list-items">${items}</div>`;
  const listEl = $('kb-list').querySelector('.kb-list-items');
  if (listEl) listEl.scrollTop = listTop;
  for (const el of $('kb-list').querySelectorAll('.kb-item')) {
    el.addEventListener('click', () => openArticle(el.dataset.path));
  }
  const closeBtn = $('kb-list-close');
  if (closeBtn) closeBtn.addEventListener('click', () => setKbSidebar(false));
}

async function exportArticlePdf(p, btn) {
  if (btn.dataset.busy) return;
  const label = btn.innerHTML;
  btn.dataset.busy = '1';
  btn.disabled = true;
  btn.innerHTML = `${ICONS.download} Preparing PDF…`;
  try {
    const res = await fetch(ws('/api/kb/article.pdf?path=' + encodeURIComponent(p)));
    if (res.status === 401) { showLogin(); throw new Error('Not authenticated'); }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'article.pdf';
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    toast('PDF export failed: ' + err.message);
  } finally {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.innerHTML = label;
  }
}

// keepScroll repaints the article you're already reading (the Refresh button
// re-reads it from disk) without sending you back to its first line.
async function openArticle(p, { keepScroll = false } = {}) {
  let a;
  try { a = await api(ws('/api/kb/article?path=' + encodeURIComponent(p))); }
  catch (err) { toast(err.message); return; }
  const restore = keepScroll ? holdScroll($('kb-reader')) : null;
  STATE.kb.article = a.path;
  setKbSidebar(false); // picking an article retracts the hover panel
  markArticleRead(a.path);

  const chips = a.stack.length ? `<div class="kb-chips">${a.stack.map((s) => `<span class="chip-stack">${esc(s)}</span>`).join('')}</div>` : '';
  const metaBits = [
    a.tickets ? `<span class="tag">${esc(a.tickets)}</span>` : '',
    a.updated ? `<span class="tag">updated ${esc(a.updated)}</span>` : '',
    a.status && a.status !== 'published' ? `<span class="tag pri-high">${esc(a.status)}</span>` : '',
  ].filter(Boolean).join('');
  const toc = a.toc && a.toc.length
    ? `<nav class="kb-toc"><div class="kb-toc-head">On this page</div>${a.toc.map((h) =>
        `<a class="lvl${h.level}" href="#${esc(h.id)}">${esc(h.text)}</a>`).join('')}</nav>`
    : '';
  const related = a.related && a.related.length
    ? `<div class="kb-related"><h3>Related</h3>${a.related.map((r) =>
        `<a class="kb-rel" data-path="${esc(r.path)}">${esc(r.title)} <span>· ${esc(r.collectionName)}</span></a>`).join('')}</div>`
    : '';
  const jobLink = a.job
    ? `<a class="kb-joblink" data-job="${esc(a.job)}">Open the working task →</a>` : '';

  $('kb-reader').innerHTML = `
    <div class="kb-reader-inner">
      <article class="kb-article markdown">
        <div class="kb-crumb">
          <button id="kb-back" class="ghost kb-back" type="button" title="Back to the Knowledge Base">${ICONS.arrowLeft} <span class="kb-back-long">Knowledge Base</span><span class="kb-back-short">KB</span></button>
          <span class="kb-crumb-coll">${esc(a.collectionName)}</span> ${jobLink}
          <button id="kb-export-pdf" class="ghost kb-export-pdf" type="button" title="Export this article as a PDF">${ICONS.download} Export PDF</button>
        </div>
        <h1>${esc(a.title)}</h1>
        ${chips}
        ${metaBits ? `<div class="d-meta">${metaBits}</div>` : ''}
        ${a.html}
        ${related}
      </article>
      ${toc}
    </div>`;

  // "Export PDF" downloads a document the server lays out and prints with
  // headless Chromium (cover, one section per page, page numbers — see the PDF
  // export section of server.js and public/pdf.css). Ctrl+P still works as a
  // plain fallback through @media print in styles.css.
  document.title = `${a.title} · VaultOS`;
  $('kb-export-pdf').addEventListener('click', (e) => exportArticlePdf(a.path, e.currentTarget));
  $('kb-back').addEventListener('click', goToKBHome);

  // Wikilinks between articles.
  for (const el of $('kb-reader').querySelectorAll('a[href^="#kb/"]')) {
    el.addEventListener('click', (e) => { e.preventDefault(); openArticle(decodeURIComponent(el.getAttribute('href').slice(4))); });
  }
  // TOC smooth scroll within the reader.
  for (const el of $('kb-reader').querySelectorAll('.kb-toc a')) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = $('kb-reader').querySelector('#' + CSS.escape(el.getAttribute('href').slice(1)));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  // Related links.
  for (const el of $('kb-reader').querySelectorAll('.kb-rel')) {
    el.addEventListener('click', () => openArticle(el.dataset.path));
  }
  // Jump to the working task.
  const jl = $('kb-reader').querySelector('.kb-joblink');
  if (jl) jl.addEventListener('click', () => openTask(jl.dataset.job));

  const diagrams = hydrateDiagrams($('kb-reader'));

  renderKB();
  if (restore) { restore(); diagrams.then(restore, restore); }
  else $('kb-reader').scrollTop = 0;
}

// ========================================================================
// Diagrams
// ========================================================================
// The server hands back the diagram's inline SVG with its ids namespaced, so we
// can drop several onto one page and pan/zoom them by rewriting viewBox — no
// iframe, no CSS transforms, and text stays vector-crisp at any zoom.

const DIAGRAMS = new Map();   // rel path -> payload from /api/diagram

// Keep in sync with .diagram-slot's max-height in styles.css.
const MAX_DIAGRAM_H = 420;

const DG_ICONS = {
  expand: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/><path d="M8 11h6"/>'),
  fit: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
};

// Make an SVG behave as a responsive block: drop the intrinsic size the file may
// carry so it fills its container, and let the viewBox do all the work.
function fluidSvg(el) {
  el.removeAttribute('width');
  el.removeAttribute('height');
  el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.display = 'block';
  return el;
}

// Replace every figure.diagram placeholder in `root` with its rendered thumbnail.
// Called after any markdown body is painted (KB article or task drawer).
async function hydrateDiagrams(root) {
  const figs = [...root.querySelectorAll('figure.diagram[data-diagram]')].filter((f) => !f.dataset.hydrated);
  for (const fig of figs) {
    fig.dataset.hydrated = '1';
    const p = fig.dataset.diagram;
    const slot = fig.querySelector('.diagram-slot');
    let d;
    try {
      d = DIAGRAMS.get(p) || await api(ws('/api/diagram?path=' + encodeURIComponent(p)));
    } catch (err) {
      slot.innerHTML = `<span class="diagram-error">Diagram unavailable — ${esc(err.message)}<br><code>${esc(p)}</code></span>`;
      continue;
    }
    DIAGRAMS.set(p, d);

    // Match the slot's own box to the diagram's natural aspect ratio, capped
    // by the CSS max-height (kept in sync via MAX_DIAGRAM_H). Without this the
    // slot stays full column width while its height gets clamped, so the box's
    // shape stops matching the SVG's — the letterboxing that results reads as
    // the diagram sitting off-centre rather than evenly matted.
    const [, , vw, vh] = d.viewBox;
    slot.style.aspectRatio = `${vw} / ${vh}`;
    slot.style.maxWidth = `${Math.round(MAX_DIAGRAM_H * (vw / vh))}px`;
    slot.innerHTML = d.svg;
    const el = slot.querySelector('svg');
    if (el) fluidSvg(el);

    // The pill is the control. It started as the whole thumbnail ("click the
    // picture to open the viewer"), but at figure size that reads as a giant
    // button on every hover — so the picture reveals the pill and the pill takes
    // the click (see .diagram-open in styles.css).
    const btn = document.createElement('button');
    btn.className = 'diagram-open';
    btn.type = 'button';
    btn.innerHTML = `<span class="diagram-open-pill">${DG_ICONS.expand} Open viewer</span>`;
    btn.setAttribute('aria-label', `Open “${d.title}” in the diagram viewer`);
    btn.addEventListener('click', () => openDiagram(p));
    slot.appendChild(btn);

    if (!fig.querySelector('figcaption') && d.title) {
      const cap = document.createElement('figcaption');
      cap.textContent = d.title;
      fig.appendChild(cap);
    }
  }
}

// ---------- Viewer ----------
// A single reusable overlay. Pan/zoom is pure viewBox arithmetic: zoom keeps the
// point under the cursor fixed, pan converts pixel deltas into user units.
let DGV = null;   // { base: [x,y,w,h], box: [x,y,w,h], svg, dragging }

function dgvApply() {
  if (!DGV) return;
  DGV.svg.setAttribute('viewBox', DGV.box.join(' '));
  const pct = Math.round((DGV.base[2] / DGV.box[2]) * 100);
  $('dgv-zoom').textContent = `${pct}%`;
}

function dgvFit() {
  if (!DGV) return;
  DGV.box = [...DGV.base];
  dgvApply();
}

// Scale about a fixed point given in user-space coordinates.
function dgvZoom(factor, ax, ay) {
  if (!DGV) return;
  const [x, y, w, h] = DGV.box;
  const cx = ax === undefined ? x + w / 2 : ax;
  const cy = ay === undefined ? y + h / 2 : ay;
  // 10% out to 40x in, measured against the diagram's own natural size.
  const min = DGV.base[2] / 40, max = DGV.base[2] * 10;
  const nw = Math.min(max, Math.max(min, w / factor));
  const nh = nw * (h / w);
  DGV.box = [cx - (cx - x) * (nw / w), cy - (cy - y) * (nh / h), nw, nh];
  dgvApply();
}

// Pointer position (client px) → the diagram's own coordinate space.
function dgvPoint(e) {
  const r = DGV.svg.getBoundingClientRect();
  const [x, y, w, h] = DGV.box;
  // preserveAspectRatio="xMidYMid meet" letterboxes, so back out the real scale.
  const scale = Math.min(r.width / w, r.height / h);
  const offX = (r.width - w * scale) / 2;
  const offY = (r.height - h * scale) / 2;
  return { x: x + (e.clientX - r.left - offX) / scale, y: y + (e.clientY - r.top - offY) / scale, scale };
}

// The generated backdrop is `<rect width="100%" height="100%">`, and an SVG
// percentage resolves against the *current* viewBox — so the moment this viewer
// rewrites that viewBox to zoom or pan, the backdrop stays anchored at the
// diagram's origin and scales with the zoom instead of with the content. Zoom in
// and the paper shrinks out from under the figure, leaving the mat showing
// through the middle of it. Nothing is wrong with the file: the percentage form
// is exact at fit, which is all a thumbnail ever is. Only here, where the viewBox
// moves, does it need restating as one large absolute box that the paper can
// never be panned off. 25x the diagram's own size covers the full zoom range
// (10% out) with room left for panning; the browser only rasterises what's on
// screen, so the size costs nothing.
function dgvExpandBackdrop(el, base) {
  const [bx, by, bw, bh] = base;
  const skip = new Set(['title', 'desc', 'defs', 'style', 'metadata']);
  for (const node of el.children) {
    const tag = node.tagName.toLowerCase();
    if (skip.has(tag)) continue;
    // Backdrops are the leading full-bleed rects — the paper, then any dot
    // pattern over it. The first element that isn't one is the diagram proper.
    if (tag !== 'rect' || node.getAttribute('width') !== '100%' || node.getAttribute('height') !== '100%') break;
    node.setAttribute('x', bx - bw * 12);
    node.setAttribute('y', by - bh * 12);
    node.setAttribute('width', bw * 25);
    node.setAttribute('height', bh * 25);
  }
}

function openDiagram(p) {
  const d = DIAGRAMS.get(p);
  if (!d) return;
  const stage = $('dgv-stage');
  $('dgv-title').textContent = d.title;
  $('dgv-path').textContent = p;
  $('dgv-desc').textContent = d.desc || '';
  $('dgv-desc').classList.toggle('hidden', !d.desc);

  stage.innerHTML = d.svg;
  const el = fluidSvg(stage.querySelector('svg'));
  dgvExpandBackdrop(el, d.viewBox);
  DGV = { base: [...d.viewBox], box: [...d.viewBox], svg: el, dragging: null };
  dgvApply();

  // Groups the generator labelled (`<g aria-label="Role lanes">`) are the only
  // per-node metadata these diagrams carry. Where they exist, hovering one names
  // it in the footer; where they don't, the footer keeps the diagram's own <desc>.
  const groups = [...el.querySelectorAll('g[aria-label]')];
  for (const g of groups) {
    g.classList.add('dgv-hit');
    g.addEventListener('mouseenter', () => { $('dgv-desc').textContent = g.getAttribute('aria-label'); $('dgv-desc').classList.remove('hidden'); });
    g.addEventListener('mouseleave', () => { $('dgv-desc').textContent = d.desc || ''; $('dgv-desc').classList.toggle('hidden', !d.desc); });
  }

  $('dgview').classList.remove('hidden');
  $('dgv-close').focus();
}

function closeDiagram() {
  $('dgview').classList.add('hidden');
  $('dgv-stage').innerHTML = '';
  DGV = null;
  DGV_PTRS.clear();
  DGV_PINCH = null;
}

$('dgv-out').innerHTML = DG_ICONS.zoomOut;
$('dgv-in').innerHTML = DG_ICONS.zoomIn;
$('dgv-fit').innerHTML = DG_ICONS.fit;
$('dgv-close').innerHTML = DG_ICONS.close;

$('dgv-close').addEventListener('click', closeDiagram);
$('dgv-in').addEventListener('click', () => dgvZoom(1.3));
$('dgv-out').addEventListener('click', () => dgvZoom(1 / 1.3));
$('dgv-fit').addEventListener('click', dgvFit);
$('dgview').addEventListener('click', (e) => { if (e.target === $('dgview')) closeDiagram(); });

$('dgv-stage').addEventListener('wheel', (e) => {
  if (!DGV) return;
  e.preventDefault();
  const pt = dgvPoint(e);
  dgvZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, pt.x, pt.y);
}, { passive: false });

// One pointer pans; two (a pinch on a phone) zoom about the midpoint of the
// fingers and pan with it. Every active pointer is tracked by id, because a
// second finger arriving used to just restart the one-finger drag.
const DGV_PTRS = new Map();   // pointerId → { x, y } in client px
let DGV_PINCH = null;         // { d0, box0, ax, ay } while two fingers are down

function dgvStartDrag(clientX, clientY) {
  const pt = dgvPoint({ clientX, clientY });
  DGV.dragging = { x: pt.x, y: pt.y };
}
function dgvStartPinch() {
  const [p1, p2] = [...DGV_PTRS.values()];
  const mid = { clientX: (p1.x + p2.x) / 2, clientY: (p1.y + p2.y) / 2 };
  const a = dgvPoint(mid);
  DGV_PINCH = { d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, box0: [...DGV.box], ax: a.x, ay: a.y };
  DGV.dragging = null;
}

$('dgv-stage').addEventListener('pointerdown', (e) => {
  if (!DGV || e.button !== 0) return;
  // Suppress the native drag-select this would otherwise begin: `user-select`
  // stops the stage's own text being selected, but only preventDefault keeps the
  // selection from starting here and extending into the page underneath.
  e.preventDefault();
  $('dgv-stage').setPointerCapture(e.pointerId);
  DGV_PTRS.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (DGV_PTRS.size === 2) dgvStartPinch();
  else if (DGV_PTRS.size === 1) dgvStartDrag(e.clientX, e.clientY);
  $('dgv-stage').classList.add('grabbing');
});
$('dgv-stage').addEventListener('pointermove', (e) => {
  if (!DGV || !DGV_PTRS.has(e.pointerId)) return;
  DGV_PTRS.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const r = DGV.svg.getBoundingClientRect();
  if (DGV_PINCH && DGV_PTRS.size >= 2) {
    // New width from how far the fingers have spread, then place the box so
    // the diagram point first under the midpoint stays under the midpoint.
    const [p1, p2] = [...DGV_PTRS.values()];
    const d = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
    const [, , w0, h0] = DGV_PINCH.box0;
    const min = DGV.base[2] / 40, max = DGV.base[2] * 10;
    const nw = Math.min(max, Math.max(min, w0 * (DGV_PINCH.d0 / d)));
    const nh = nw * (h0 / w0);
    const scale = Math.min(r.width / nw, r.height / nh);
    const offX = (r.width - nw * scale) / 2, offY = (r.height - nh * scale) / 2;
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    DGV.box = [DGV_PINCH.ax - (mx - r.left - offX) / scale, DGV_PINCH.ay - (my - r.top - offY) / scale, nw, nh];
    dgvApply();
    return;
  }
  if (!DGV.dragging) return;
  // Recompute in the *current* box so the grabbed point stays under the cursor.
  const [x, y, w, h] = DGV.box;
  const scale = Math.min(r.width / w, r.height / h);
  const offX = (r.width - w * scale) / 2, offY = (r.height - h * scale) / 2;
  const px = x + (e.clientX - r.left - offX) / scale;
  const py = y + (e.clientY - r.top - offY) / scale;
  DGV.box = [x - (px - DGV.dragging.x), y - (py - DGV.dragging.y), w, h];
  dgvApply();
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('dgv-stage').addEventListener(ev, (e) => {
    if (!DGV_PTRS.delete(e.pointerId) || !DGV) return;
    DGV_PINCH = null;
    // Lifting one finger of a pinch carries on as a one-finger pan from where
    // the other finger is, rather than jumping.
    const rest = [...DGV_PTRS.values()];
    if (rest.length >= 2) dgvStartPinch();
    else if (rest.length === 1) dgvStartDrag(rest[0].x, rest[0].y);
    else { DGV.dragging = null; $('dgv-stage').classList.remove('grabbing'); }
  });
}

document.addEventListener('keydown', (e) => {
  if (!DGV) return;
  if (e.key === 'Escape') { e.stopPropagation(); closeDiagram(); }
  else if (e.key === '+' || e.key === '=') dgvZoom(1.3);
  else if (e.key === '-' || e.key === '_') dgvZoom(1 / 1.3);
  else if (e.key === '0') dgvFit();
  else return;
  e.preventDefault();
}, true);   // capture, so Escape closes the viewer without also closing the drawer behind it

// ========================================================================
// Doc viewer — other .md files (guides, notes) sitting beside a task.md
// ========================================================================
let DOCV = null;   // the path of the doc currently open, or null

// Fetch + repaint in place — shared by first open, the refresh button, and
// the auto-refresh-on-focus below, so all three stay in sync.
async function paintDoc(p, { keepScroll = false } = {}) {
  const d = await api(ws('/api/task/doc?path=' + encodeURIComponent(p)));
  // Captured after the fetch, not before it: the refresh-on-focus below fires
  // on every tab switch, and holding a stale offset would fight the reader.
  const restore = keepScroll ? holdScroll($('docv-body')) : null;
  DOCV = d.path;
  $('docv-title').textContent = d.title;
  $('docv-path').textContent = d.path;
  $('docv-body').innerHTML = d.html;
  if (restore) restore(); else $('docv-body').scrollTop = 0;
  const diagrams = hydrateDiagrams($('docv-body'));
  if (restore) diagrams.then(restore, restore);
}

async function openDoc(p) {
  try { await paintDoc(p); }
  catch (err) { toast(err.message); return; }
  $('docview').classList.remove('hidden');
  $('docv-body').scrollTop = 0;   // same as the drawer: the reset in paintDoc ran while this was hidden
  $('docv-close').focus();
}

function closeDoc() {
  $('docview').classList.add('hidden');
  $('docv-body').innerHTML = '';
  DOCV = null;
}

$('docv-close').innerHTML = DG_ICONS.close;
$('docv-close').addEventListener('click', closeDoc);
$('docv-refresh').addEventListener('click', () => {
  if (DOCV) withRefreshFeedback($('docv-refresh'), () => paintDoc(DOCV, { keepScroll: true }));
});
$('docview').addEventListener('click', (e) => { if (e.target === $('docview')) closeDoc(); });

// Pick up edits made outside the app (code-server, Obsidian, Syncthing) without
// a manual reload — the moment worth refetching is the browser tab or window
// regaining focus while the doc is open. Silent on failure: the manual refresh
// button above is where errors surface.
window.addEventListener('focus', () => { if (DOCV) paintDoc(DOCV, { keepScroll: true }).catch(() => {}); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && DOCV) paintDoc(DOCV, { keepScroll: true }).catch(() => {});
});
// Capture phase, like the diagram viewer: Escape closes just the doc and
// stops there, leaving the drawer underneath it open. Bail if a diagram is
// open on top of the doc (DGV's own capture listener owns that Escape —
// capture-phase listeners on the same node all still fire regardless of
// stopPropagation, so without this check one Escape would close both).
document.addEventListener('keydown', (e) => {
  if (!DOCV || DGV || e.key !== 'Escape') return;
  e.stopPropagation();
  closeDoc();
}, true);

// ========================================================================
// Search (mode-aware) + boot
// ========================================================================
const kbSearch = debounce((q) => { STATE.kb.query = q; loadKB(q); }, 250);
$('search').addEventListener('input', (e) => {
  if (STATE.mode === 'kb') kbSearch(e.target.value);
  else if (STATE.mode === 'files') fxSearch(e.target.value);
  else { STATE.query = e.target.value; render(); }
});
$('clear-filters').addEventListener('click', clearAllFilters);
// Refresh reloads the whole app, not just the data: an installed home-screen
// app on iOS resumes the old page indefinitely, so this is how it picks up a
// new VaultOS. Where you were (mode + open article) rides across the reload in
// sessionStorage and is restored at startup. Server-side terminals survive it.
const RELOAD_KEY = 'vaultboard.reloadState';
$('refresh').addEventListener('click', () => {
  try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ mode: STATE.mode, article: STATE.kb.article })); } catch {}
  location.reload();
});
function restoreAfterReload() {
  let st = null;
  try { st = JSON.parse(sessionStorage.getItem(RELOAD_KEY)); sessionStorage.removeItem(RELOAD_KEY); } catch {}
  if (!st || !st.mode) return false;   // Board too: the home mode isn't always Board
  setMode(st.mode);   // 'today' with Today off lands on the Board (setMode)
  if (st.mode === 'kb' && st.article) openArticle(st.article);
  return true;
}

async function load() {
  const data = await api(ws('/api/tasks'));
  STATE.tasks = data.tasks;
  STATE.projects = data.projects;
  STATE.statuses = data.statuses;
  STATE.loaded = true;
  BOARD_SIG = JSON.stringify(data);
  $('app').classList.remove('hidden');
  render();
}

// ---------- Board auto-refresh ----------
// Agents, Obsidian and Syncthing change task.md files underneath an open board,
// so the board rescans on its own: every BOARD_POLL_MS while it's on screen, and
// at once when the tab comes back. A scan is ~20ms, and it repaints only when the
// answer actually differs, so an idle board never flickers. Skipped mid-drag, and
// an answer is thrown away if a write or a workspace switch landed while it was
// in flight (it would paint the card back in its old column). If the open task's
// file changed, the drawer re-reads it too, keeping its scroll.
const BOARD_POLL_MS = 10000;
let BOARD_SIG = '';
let BOARD_POLLING = false;
async function pollBoard() {
  if (BOARD_POLLING || DRAG || !STATE.loaded || STATE.mode !== 'board'
      || document.visibilityState !== 'visible' || $('app').classList.contains('hidden')) return;
  BOARD_POLLING = true;
  const gen = WRITES, wsKey = STATE.workspace;
  try {
    const data = await api(ws('/api/tasks'));
    if (gen !== WRITES || wsKey !== STATE.workspace || DRAG || !STATE.loaded) return;
    const sig = JSON.stringify(data);
    if (sig === BOARD_SIG) return;
    BOARD_SIG = sig;
    STATE.tasks = data.tasks;
    STATE.projects = data.projects;
    STATE.statuses = data.statuses;
    render();
    if (OPEN) {
      const t = data.tasks.find((x) => x.path === OPEN.path);
      if (t && t.mtime !== OPEN.mtime) {
        showTask(await api(ws('/api/task?path=' + encodeURIComponent(OPEN.path))), { keepScroll: true });
      }
    }
  } catch { /* silent: a manual Refresh is where errors surface */ }
  finally { BOARD_POLLING = false; }
}
setInterval(pollBoard, BOARD_POLL_MS);
document.addEventListener('visibilitychange', pollBoard);
window.addEventListener('focus', pollBoard);

// ---------- Workspace switcher ----------
// Lives in the Settings sheet (Workspace section) rather than as a pill in the header, so the
// header is the same shape in every mode. The popover lists the full registry:
// click a row to switch to it.
let WORKSPACE_LIST = [];

function renderWorkspaceSwitcher() {
  const cur = WORKSPACE_LIST.find((w) => w.key === STATE.workspace);
  $('ws-current').textContent = cur ? cur.label : '';
  if (secOpen('ws')) renderWsList();
}

async function loadWorkspaces() {
  try { WORKSPACE_LIST = await api('/api/workspaces'); }
  catch { return; }
  // The remembered board may be hidden or gone, or never existed here (a new install, another VaultOS
  // in this browser): fall back to the first visible one, so the app never opens on a board that isn't
  // there. Before anything is loaded (startup, sign-in) that is its key and its own column choices; with
  // a board already on screen (hidden from Settings → Boards) it is a full switch.
  const fallback = !WORKSPACE_LIST.some((w) => w.key === STATE.workspace) && WORKSPACE_LIST[0];
  if (fallback && (STATE.loaded || STATE.kb.loaded)) return setWorkspace(fallback.key);
  if (fallback) {
    STATE.workspace = fallback.key;
    localStorage.setItem('vaultboard.workspace', fallback.key);
    STATE.hiddenColumns = loadHiddenColumns(fallback.key);
    STATE.hideSubtasks = loadHideSubtasks(fallback.key);
  }
  renderWorkspaceSwitcher();
}

function renderWsList() {
  // Belt and braces: if the list never arrived (failed fetch, or a login path
  // that skipped it), fetch it now rather than show an empty section.
  if (!WORKSPACE_LIST.length) { loadWorkspaces().then(() => { if (WORKSPACE_LIST.length && secOpen('ws')) renderWsList(); }); }
  // One pick, radio-style: the whole row (circle or name) switches straight to that
  // board. Only the visible boards are listed; hiding is in the list below it.
  $('ws-list').innerHTML = WORKSPACE_LIST.map((w) => `
    <label class="filter-item ws-row${w.key === STATE.workspace ? ' active' : ''}">
      <input type="radio" name="ws-pick" value="${esc(w.key)}" ${w.key === STATE.workspace ? 'checked' : ''}>
      <span class="ws-pick">${esc(w.label)}</span>
    </label>`).join('');
  for (const el of $('ws-list').querySelectorAll('input[type=radio]')) {
    el.addEventListener('change', () => { closeSheet(); setWorkspace(el.value); });
  }
}
function setWorkspace(key) {
  if (key === STATE.workspace) return;
  STATE.workspace = key;
  localStorage.setItem('vaultboard.workspace', key);
  renderWorkspaceSwitcher();

  // Fresh start in the new workspace: drop cached tasks/KB state and any open drawer/article.
  STATE.hiddenColumns = loadHiddenColumns(key); // this board's own remembered column set
  STATE.hideSubtasks = loadHideSubtasks(key);   // …and its own answer on collapsing batches
  STATE.projectFilter = new Set();
  STATE.batchFilter = '';   // batch values are workspace-scoped; carrying one over empties the board
  STATE.query = '';
  STATE.tasks = [];
  STATE.projects = [];
  STATE.loaded = false;
  STATE.kb = { collections: [], articles: [], collectionFilter: new Set(), query: '', article: null, loaded: false,
    sidebarOpen: STATE.kb.sidebarOpen };
  applyKbSidebarClass();
  $('search').value = '';
  updateFilterBadge();
  closeDrawer();
  $('kb-reader').innerHTML = `
    <div class="kb-welcome">
      <h2>Knowledge Base</h2>
      <p>Finished work, written up to be picked back up fast. Choose a collection, then an article.</p>
    </div>`;

  // render() and renderKB() hold their scroll position across a repaint now, so
  // a "fresh start" has to say so explicitly or it inherits the old board's.
  $('board').scrollLeft = 0;
  $('kb-reader').scrollTop = 0;
  window.scrollTo(0, 0);

  if (STATE.mode === 'kb') loadKB(); else load();
}

// ========================================================================
// Settings: boards, features, agent and password (settings.json, via /api/settings/*)
// ========================================================================
// The server's messages are written for the person; validate() prefixes its own with the file's name,
// which means nothing here.
function settingsMsg(err) {
  const m = String((err && err.message) || '').replace(/^settings\.json: /, '');
  return m ? m[0].toUpperCase() + m.slice(1) : 'Something went wrong';
}
// An input's error line (its id + '-err'), and the red border with it.
function fieldErr(id, msg) {
  $(id + '-err').textContent = msg || '';
  if (msg) $(id).setAttribute('aria-invalid', 'true'); else $(id).removeAttribute('aria-invalid');
}

// ---------- Boards ----------
// Under the switcher: every board, hidden ones too, from /api/settings. A change goes to the server, then
// this list and the switcher are read again. Changes queue, so each one sees the list the last one left.
let BOARDS = { boards: [], folders: [] };
let BOARDS_QUEUE = Promise.resolve();
let BD_RENDERING = false;      // the rows are being rebuilt: the focused name's focusout is not a person leaving it
const BD_RENAMING = new Map();   // board key → the name a queued rename is saving
const BD_ICONS = { up: svg('<path d="m18 15-6-6-6 6"/>'), down: svg('<path d="m6 9 6 6 6-6"/>') };

async function loadBoardSettings() {
  $('bd-manage').classList.toggle('hidden', !!ME.localRead);
  if (ME.localRead) return;
  try {
    const d = await api('/api/settings');
    BOARDS = { boards: d.settings.boards, folders: d.folders };
    renderBoardSettings();
  } catch (err) { $('bd-err').textContent = settingsMsg(err); }
}
function boardChange(run, errEl) {
  BOARDS_QUEUE = BOARDS_QUEUE.then(async () => {
    errEl.textContent = '';
    try { await run(); } catch (err) { errEl.textContent = settingsMsg(err); }
    await loadBoardSettings();
    await loadWorkspaces();
  });
  return BOARDS_QUEUE;
}
const boardAt = (key) => BOARDS.boards.findIndex((b) => b.key === key);
const patchBoard = (key, body) => api('/api/settings/boards/' + encodeURIComponent(key), { method: 'PATCH', body: JSON.stringify(body) });

// Rebuilt on every change. Focus stays on the same control of the same board (or its name, when that
// arrow is now at the end), and a name being typed keeps its text.
function renderBoardSettings() {
  const list = $('bd-list');
  const a = document.activeElement;
  const row0 = a && list.contains(a) ? a.closest('.bd-row') : null;
  const was = row0 ? { key: row0.dataset.key, act: a.dataset.act, value: a.matches('.bd-label') ? a.value : null } : null;
  const n = BOARDS.boards.length;
  const rows = BOARDS.boards.map((b, i) => {
    const row = document.createElement('div');
    row.className = 'bd-row' + (b.hidden ? ' is-hidden' : '');
    row.dataset.key = b.key;
    row.innerHTML = '<input class="su-input bd-label" type="text" maxlength="60" autocomplete="off">'
      + `<button type="button" class="su-iconbtn" data-act="up"${i === 0 ? ' disabled' : ''}>${BD_ICONS.up}</button>`
      + `<button type="button" class="su-iconbtn" data-act="down"${i === n - 1 ? ' disabled' : ''}>${BD_ICONS.down}</button>`
      + `<button type="button" class="su-btn su-sm bd-vis" data-act="hidden">${b.hidden ? 'Show' : 'Hide'}</button>`
      + '<span class="bd-dir"></span>';
    const input = row.querySelector('.bd-label');
    input.value = b.label;
    input.setAttribute('aria-label', `Name of board ${i + 1}`);
    for (const [act, what] of [['up', 'Move up'], ['down', 'Move down']]) {
      const btn = row.querySelector(`[data-act="${act}"]`);
      btn.title = what;
      btn.setAttribute('aria-label', `${what}: ${b.label}`);
    }
    row.querySelector('.bd-vis').setAttribute('aria-label', `${b.hidden ? 'Show' : 'Hide'} ${b.label}`);
    row.querySelector('.bd-dir').textContent = `${b.dir}/${b.hidden ? ' · hidden' : ''}`;
    return row;
  });
  // Chrome fires focusout, synchronously, on a focused input it removes. Without the flag that would save
  // whatever is in the name being typed (a failed rename would even save itself again, in a loop).
  BD_RENDERING = true;
  try { list.replaceChildren(...rows); } finally { BD_RENDERING = false; }
  if (was) {
    const row = [...list.children].find((r) => r.dataset.key === was.key);
    const el = row && ((was.act && row.querySelector(`[data-act="${was.act}"]:not(:disabled)`)) || row.querySelector('.bd-label'));
    if (el) {
      el.focus({ preventScroll: true });
      if (was.value != null && el.matches('.bd-label')) el.value = was.value;
    }
  }
  const sel = $('bd-existing-dir');
  sel.replaceChildren(...BOARDS.folders.map((f) => Object.assign(document.createElement('option'), { value: f, textContent: f })));
  $('bd-existing-row').classList.toggle('hidden', !BOARDS.folders.length);
  $('bd-existing-hint').textContent = BOARDS.folders.length
    ? 'A top-level folder that isn\'t a board yet. VaultOS adds the board files it is missing and changes nothing else.'
    : 'No other top-level folders to add.';
}

// A name is saved on Enter or on leaving the field, when it changed. An empty one goes back to the old name.
// A name already on its way (Enter, then Tab before the answer) isn't sent twice.
function renameBoard(input) {
  const key = input.closest('.bd-row').dataset.key;
  const b = BOARDS.boards[boardAt(key)];
  const label = input.value.trim();
  if (!b || label === b.label || BD_RENAMING.get(key) === label) return;
  if (!label) { input.value = b.label; $('bd-err').textContent = 'A board needs a name'; return; }
  BD_RENAMING.set(key, label);
  boardChange(async () => {
    try { await patchBoard(key, { label }); } finally { BD_RENAMING.delete(key); }
  }, $('bd-err'));
}
$('bd-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.bd-label')) { e.preventDefault(); renameBoard(e.target); }
});
$('bd-list').addEventListener('focusout', (e) => {
  if (!BD_RENDERING && e.target.matches('.bd-label')) renameBoard(e.target);
});
$('bd-list').addEventListener('input', () => { $('bd-err').textContent = ''; });
// The index is worked out when the change runs, from the list the change before it left.
$('bd-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const key = btn.closest('.bd-row').dataset.key;
  const act = btn.dataset.act;
  boardChange(() => {
    const i = boardAt(key);
    if (i < 0) return null;
    if (act === 'hidden') return patchBoard(key, { hidden: !BOARDS.boards[i].hidden });
    const to = act === 'up' ? i - 1 : i + 1;
    return to < 0 || to >= BOARDS.boards.length ? null : patchBoard(key, { index: to });
  }, $('bd-err'));
});
$('bd-add').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('bd-add-name');
  const label = input.value.trim();
  fieldErr('bd-add-name', '');
  if (!label) { fieldErr('bd-add-name', 'Give the board a name'); return input.focus(); }
  boardChange(async () => {
    await api('/api/settings/boards', { method: 'POST', body: JSON.stringify({ label }) });
    input.value = '';
  }, $('bd-add-name-err'));
});
$('bd-add-name').addEventListener('input', () => fieldErr('bd-add-name', ''));
$('bd-existing').addEventListener('submit', (e) => {
  e.preventDefault();
  const dir = $('bd-existing-dir').value;
  if (dir) boardChange(() => api('/api/settings/boards/existing', { method: 'POST', body: JSON.stringify({ dir }) }), $('bd-existing-err'));
});

// ---------- Features ----------
// Today and the terminal are for everyone on this VaultOS. Saving reloads the page: the UI reads what is
// on once, at startup (ME). TERMINAL=0 on the machine overrides the setting, so the switch is off then.
let TERMINAL_ALLOWED = true;
const validTz = (tz) => {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch { return false; }
};
async function loadFeatures() {
  $('ft-err').textContent = '';
  fieldErr('ft-tz', '');
  if (!$('ft-tzs').children.length) {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: no suggestions */ }
    $('ft-tzs').replaceChildren(...zones.map((z) => Object.assign(document.createElement('option'), { value: z })));
  }
  try {
    const d = await api('/api/settings');
    TERMINAL_ALLOWED = d.terminalAllowed;
    $('ft-today').checked = d.settings.features.today;
    $('ft-tz').value = d.settings.today.timezone;
    $('ft-term').checked = d.terminalAllowed && d.settings.features.terminal;
    $('ft-term').disabled = !d.terminalAllowed;
    $('ft-term-d').textContent = d.terminalAllowed
      ? 'Shells inside VaultOS, and the coding agent that Start agent opens.'
      : 'Turned off for this machine (TERMINAL=0)';
  } catch (err) { $('ft-err').textContent = settingsMsg(err); }
}
$('ft-tz').addEventListener('input', () => fieldErr('ft-tz', ''));
$('ft-save').addEventListener('click', async () => {
  const timezone = $('ft-tz').value.trim();
  if (!validTz(timezone)) { fieldErr('ft-tz', 'Unknown time zone. Use a name like Asia/Tokyo'); return $('ft-tz').focus(); }
  $('ft-err').textContent = '';
  const body = { today: $('ft-today').checked, timezone, ...(TERMINAL_ALLOWED ? { terminal: $('ft-term').checked } : {}) };
  $('ft-save').disabled = true;
  try {
    await api('/api/settings/features', { method: 'POST', body: JSON.stringify(body) });
    location.reload();
  } catch (err) {
    $('ft-err').textContent = settingsMsg(err);
    $('ft-save').disabled = false;
  }
});

// ---------- Agent ----------
// Setup's step 4 again: the agent tiles, the detail panel and the Other fields are AgentForm's (agent-form.js),
// shared with setup.js; this section owns the order of saves and the polling. Install and Sign in open an
// ordinary terminal; once one has, the agents are read again every 3 s while this section is open. Saves go in
// order and only the last one's answer counts; a read that a save started after is dropped.
const AG = { saving: 0, termed: false, poll: null };
$('ag-custom').insertAdjacentHTML('afterbegin', AgentForm.CUSTOM_FIELDS.map((f) => {
  const id = `ag-f-${f.key}`;
  return `<div class="su-field${f.wide ? ' wide' : ''}"><label for="${id}">${esc(f.label)}</label>`
    + `<input id="${id}" class="su-input${f.code ? ' mono' : ''}" type="text" data-k="${f.key}" placeholder="${esc(f.placeholder)}"`
    + ` autocomplete="off"${f.code ? ' spellcheck="false" autocapitalize="off"' : ''}${f.maxlength ? ` maxlength="${f.maxlength}"` : ''}`
    + ` aria-describedby="${f.hint ? `${id}-hint ` : ''}${id}-err">`
    + (f.hint ? `<p class="su-hint" id="${id}-hint">${esc(f.hint)}</p>` : '')
    + `<p class="su-err" id="${id}-err" aria-live="polite"></p></div>`;
}).join(''));
async function agSave(body) {
  const mine = ++AG.saving;
  try { await api('/api/settings/agent', { method: 'POST', body: JSON.stringify(body) }); } catch (err) {
    return mine === AG.saving ? { error: settingsMsg(err) } : { stale: true };
  }
  if (mine !== AG.saving) return { stale: true };
  refreshMe();   // Start agent follows the new default
  agRefresh();
  return { ok: true };
}
const AG_PICKER = AgentForm.mountPicker($('ag-picker'), {
  save: agSave,
  openTerm: (kind, a) => agTerm(a[kind]),
  customFields: $('ag-custom'),
});
// AgentForm.saveCustom's side of this section: the Other fields and their messages.
const AG_CUSTOM = {
  save: agSave,
  value: (k) => $(`ag-f-${k}`).value,
  fieldError: (k, msg) => fieldErr(`ag-f-${k}`, msg),
  focus: (k) => $(`ag-f-${k}`).focus(),
  customError: (msg) => { $('ag-custom-err').textContent = msg; },
};
async function loadAgent() {
  $('ag-err').textContent = '';
  const mine = AG.saving;
  let d;
  let list;
  try { [d, list] = await Promise.all([api('/api/settings'), api('/api/agents')]); } catch (err) {
    $('ag-err').textContent = settingsMsg(err);
    return;
  }
  if (mine !== AG.saving) return;   // a choice made while this loaded wins
  // /api/agents carries the commands it runs, not the templates they came from: the fields come from the settings.
  const c = d.settings.agent.custom;
  if (c) for (const f of AgentForm.CUSTOM_FIELDS) $(`ag-f-${f.key}`).value = c[f.key] || '';
  AG_PICKER.refresh(list);
  if (AG.termed) agPoll();
}
const agSaveCustom = () => AgentForm.saveCustom(AG_CUSTOM);
// The terminal opens where the setting says. The dock sits under this sheet, so the sheet makes way for it.
function agTerm(cmd) {
  if (!cmd) return;
  termOpen({ cwd: '', run: cmd });
  AG.termed = true;
  if (dockVisible()) closeSheet(); else agPoll();
}
function agPoll() {
  clearInterval(AG.poll);
  AG.poll = setInterval(() => {
    if (secOpen('agent')) agRefresh();
    else { clearInterval(AG.poll); AG.poll = null; }
  }, 3000);
}
async function agRefresh() {
  const mine = AG.saving;
  let list;
  try { list = await api('/api/agents'); } catch { return; }
  if (mine !== AG.saving || !secOpen('agent')) return;
  AG_PICKER.refresh(list);
}
$('ag-custom-save').addEventListener('click', agSaveCustom);
$('ag-custom').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); agSaveCustom(); }
});
$('ag-custom').addEventListener('input', (e) => {
  if (e.target.dataset.k) fieldErr(e.target.id, '');
  $('ag-custom-err').textContent = '';
});

// ---------- Password ----------
// Two different 401s come back from here. A wrong current password has its own message (it doesn't count
// toward the sign-in lockout); a lost session is the guard's "Not authenticated", and goes to the sign-in
// screen as everywhere else. So this posts without api(), which treats every 401 as the second.
const MIN_PASSWORD = 8;
const PW_FIELDS = ['pw-cur', 'pw-new', 'pw-new2'];
function resetPassword() {
  $('pw-form').reset();
  for (const id of PW_FIELDS) fieldErr(id, '');
  $('pw-err').textContent = '';
  $('pw-ok').textContent = '';
}
$('pw-form').addEventListener('input', (e) => {
  if (PW_FIELDS.includes(e.target.id)) fieldErr(e.target.id, '');
  $('pw-err').textContent = '';
  $('pw-ok').textContent = '';
});
$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = $('pw-form');
  if (form.getAttribute('aria-busy')) return;
  const current = $('pw-cur').value;
  const next = $('pw-new').value;
  const bad = !current ? ['pw-cur', 'Enter your current password']
    : next.length < MIN_PASSWORD ? ['pw-new', `Password must be at least ${MIN_PASSWORD} characters`]
      : next !== $('pw-new2').value ? ['pw-new2', "Passwords don't match"] : null;
  if (bad) { fieldErr(bad[0], bad[1]); return $(bad[0]).focus(); }
  form.setAttribute('aria-busy', 'true');
  let res = null;
  let data = {};
  try {
    res = await fetch('/api/settings/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current, next }),
    });
    data = await res.json().catch(() => ({}));
  } catch { /* unreachable: said below */ }
  form.removeAttribute('aria-busy');
  if (res && res.ok) {
    resetPassword();
    $('pw-ok').textContent = data.signedOut ? 'Password changed. Every other browser is signed out.' : 'Password changed.';
    return;
  }
  if (res && res.status === 401 && data.error === 'Not authenticated') {
    resetPassword();
    closeSheet();
    return showLogin();
  }
  if (res && res.status === 401) {
    fieldErr('pw-cur', data.error || 'Current password is wrong');
    return $('pw-cur').select();
  }
  if (res && res.status === 400) return fieldErr('pw-new', data.error || `Password must be at least ${MIN_PASSWORD} characters`);
  $('pw-err').textContent = res ? data.error || 'Could not change the password' : "Can't reach VaultOS. Try again";
});

// Signed in: what is on, the boards, the board itself, then the first mode. At startup a Refresh's
// mode (and article) wins over the home mode; after a sign-in it's always the home mode.
async function start({ restore = false } = {}) {
  applyMe();
  await loadWorkspaces();
  await load();
  if (todayOn()) Today.init();
  if (!(restore && restoreAfterReload())) setMode(homeMode());
}

// Once every script has run: start() uses today.js (Today) and workbench.js (renderDrawerAgent), which load
// after this file.
document.addEventListener('DOMContentLoaded', async () => {
  ME = await fetchMe();
  if (ME.authed) await start({ restore: true });
  else if (ME.setup) location.replace('/setup');
  else showLogin();
});
