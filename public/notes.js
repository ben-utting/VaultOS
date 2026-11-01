// Notes mode (window.Notes): the inbox of captured thoughts and the main notes, and the note itself.
//
// The list comes from GET /api/notes (lib/notes-service.js). A note opens with GET /api/fs/file and saves with
// POST /api/fs/text/save, the routes Files uses, so the lock, the 409 "changed on disk" guard and the previous
// version are shared. [[Links]] in the rendered note become links when a note of that name exists under the notes
// folder (a main note opens here, anything else in Files) and muted text when it doesn't. Done on a rough note
// deletes it (POST /api/notes/delete) with Undo for 30 s.
'use strict';

const Notes = (() => {
  const POLL_MS = 15000;
  const N = {
    data: null,             // the last /api/notes answer
    loading: null,          // the promise of the load in flight
    path: null,             // the note on show
    file: null,             // its /api/fs/file answer
    edit: null,             // { base, mtime, saving } while editing
    status: '', tag: '',    // Main Notes filters
    timer: null,
    removing: false,        // a Done in flight: a second press is ignored
  };
  const list = $('nt-list');
  const pane = $('nt-pane');
  const layout = document.querySelector('.nt-layout');
  const phoneNow = () => window.matchMedia('(max-width: 700px)').matches;
  const titleOf = (p) => p.split('/').pop().replace(/\.md$/i, '');
  const isInbox = (p) => !!N.data && N.data.inbox.some((i) => i.path === p);
  const isMain = (p) => !!N.data && N.data.main.some((i) => i.path === p);
  const nameMap = () => new Map((N.data ? N.data.names : []).map((n) => [n.name.toLowerCase(), n.path]));

  // ---- Loading ----
  function load() {
    if (N.loading) return N.loading;
    N.loading = api('/api/notes')
      .then((d) => { N.data = d; paintList(); paintCount(); return d; })
      // A failed refresh (a dropped connection, a restart) keeps the last good list; only a first load shows the error.
      .catch((err) => { if (!N.data) list.innerHTML = `<p class="nt-msg">${esc(err.message)}</p>`; return null; })
      .finally(() => { N.loading = null; });
    return N.loading;
  }
  function refresh() { if (STATE.mode === 'notes') return load(); N.data = null; return Promise.resolve(); }
  function paintCount() {
    if (STATE.mode !== 'notes' || !N.data) return;
    const n = N.data.inbox.length;
    $('count').textContent = `${n} in the inbox`;
  }

  // ---- The list ----
  function row(sec, item) {
    const sel = item.path === N.path ? ' sel' : '';
    if (sec === 'inbox') {
      const first = item.first || titleOf(item.path);
      return `<button type="button" class="nt-row${sel}" data-sec="inbox" data-path="${esc(item.path)}">
        <span class="nt-row-t">${esc(first)}</span>
        <span class="nt-row-m">${esc(NotesCore.ageLabel(item.mtime, Date.now()))}${item.old ? ' <span class="nt-old">old</span>' : ''}</span></button>`;
    }
    const meta = [item.status ? `<span class="nt-status nt-${esc(item.status)}">${esc(item.status)}</span>` : '', ...item.tags.map((t) => `<span class="nt-tag">${esc(t)}</span>`)].join('');
    return `<button type="button" class="nt-row${sel}" data-sec="main" data-path="${esc(item.path)}">
      <span class="nt-row-t">${esc(item.title)}</span>${meta ? `<span class="nt-row-m">${meta}</span>` : ''}</button>`;
  }
  function paintList() {
    const d = N.data;
    if (!d) return;
    const tags = [...new Set(d.main.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
    if (N.tag && !tags.includes(N.tag)) N.tag = '';
    const main = NotesCore.filterMain(d.main, { status: N.status || null, tag: N.tag || null });
    const empty = phoneNow() || matchMedia('(hover: none) and (pointer: coarse)').matches
      ? 'Nothing waiting. Tap the pen to catch the next thought.'
      : `Nothing waiting. ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘J' : 'Ctrl+J'} catches the next thought.`;
    const seg = [['', 'All'], ['baby', 'baby'], ['child', 'child'], ['adult', 'adult']]
      .map(([k, l]) => `<button type="button" data-status="${k}" aria-pressed="${N.status === k}">${l}</button>`).join('');
    list.innerHTML = `
      <h2 class="nt-h" data-sec="inbox">Inbox (${d.inbox.length})</h2>
      ${d.inbox.length ? d.inbox.map((i) => row('inbox', i)).join('') : `<p class="nt-empty">${esc(empty)}</p>`}
      <h2 class="nt-h" data-sec="main">Main Notes (${d.main.length})</h2>
      <div class="nt-filters">
        <div class="nt-seg" role="group" aria-label="Status">${seg}</div>
        <select id="nt-tag" aria-label="Tag"><option value="">All tags</option>${tags.map((t) => `<option value="${esc(t)}"${t === N.tag ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>
      </div>
      ${main.length ? main.map((i) => row('main', i)).join('') : `<p class="nt-msg">${d.main.length ? 'No notes match.' : 'No main notes yet.'}</p>`}`;
    if (!N.path) paintWelcome();
  }
  list.addEventListener('click', (e) => {
    const r = e.target.closest('.nt-row');
    if (r) { select(r.dataset.path); return; }
    const s = e.target.closest('.nt-seg button');
    if (s) { N.status = s.dataset.status; paintList(); }
  });
  list.addEventListener('change', (e) => { if (e.target.id === 'nt-tag') { N.tag = e.target.value; paintList(); } });

  // ---- The note ----
  function paintWelcome() {
    delete pane.dataset.path;
    const miss = N.data && N.data.missing.length ? N.data.missing : [];
    const folders = { dir: ME.notes.dir, inbox: `${ME.notes.dir}/${ME.notes.inbox}`, main: `${ME.notes.dir}/${ME.notes.main}`, tags: `${ME.notes.dir}/${ME.notes.tags}` };
    pane.innerHTML = miss.length
      ? `<div class="nt-welcome"><h2>Some folders are missing</h2>${miss.map((k) => `<p>notes.${k === 'dir' ? 'dir' : k} points at <code>${esc(folders[k])}</code>, which doesn't exist.</p>`).join('')}<p>Change it in <code>.vaultos/settings.json</code>, or make the folder.</p></div>`
      : '<div class="nt-welcome"><h2>Notes</h2><p>Pick a thought from the inbox to read it or tidy it up, or a main note to keep working on it.</p></div>';
  }

  function linkify(root) {
    const names = nameMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.includes('[[') && !n.parentElement.closest('pre, code, a') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const segs = NotesCore.wikiSegments(node.nodeValue, names);
      if (segs.length === 1 && segs[0].text !== undefined) continue;
      const frag = document.createDocumentFragment();
      for (const s of segs) {
        if (s.text !== undefined) { frag.append(s.text); continue; }
        const el = document.createElement(s.path ? 'a' : 'span');
        el.textContent = s.label;
        if (s.path) { el.className = 'nt-link'; el.href = '#'; el.dataset.path = s.path; el.title = s.anchor ? `${s.target} › ${s.anchor}` : s.target; }
        else { el.className = 'nt-link-missing'; el.title = `No note called ${s.target} yet`; }
        frag.append(el);
      }
      node.replaceWith(frag);
    }
  }

  function header() {
    const p = N.path;
    const inbox = isInbox(p);
    const item = inbox ? N.data.inbox.find((i) => i.path === p) : null;
    const meta = inbox ? `${ME.notes.inbox.split('/').pop()} · ${NotesCore.ageLabel(item.mtime, Date.now())}` : (isMain(p) ? ME.notes.main.split('/').pop() : p.split('/').slice(1, -1).join(' › '));
    return `<div class="nt-bar">
      <button type="button" id="nt-back" class="ghost nt-back" aria-label="Back to the list">‹ Notes</button>
      <span class="nt-where">${esc(meta)}</span>
      <span class="nt-acts">
        ${N.edit ? '' : '<button type="button" id="nt-edit" class="su-btn">Edit</button>'}
        ${inbox && !N.edit ? '<button type="button" id="nt-done" class="su-btn" title="Delete this rough note (you can undo)">Done</button>' : ''}
      </span></div>`;
  }

  function paintNote() {
    const f = N.file;
    pane.dataset.path = N.path;
    if (N.edit) {
      pane.innerHTML = `<div class="nt-col">${header()}
        <div id="nt-conflict" class="nt-conflict" hidden><span>Changed elsewhere since you opened it.</span>
          <button type="button" id="nt-theirs" class="su-btn">Load theirs</button><button type="button" id="nt-mine" class="su-btn">Keep mine</button></div>
        <textarea id="nt-text" class="nt-text" spellcheck="true" aria-label="Note text"></textarea>
        <p id="nt-err" class="cp-err" aria-live="polite"></p>
        <div class="nt-foot"><button type="button" id="nt-cancel" class="su-btn">Cancel</button><button type="button" id="nt-save" class="su-btn primary">Save</button></div></div>`;
      const ta = $('nt-text');
      ta.value = N.edit.text;
      ta.addEventListener('input', () => { N.edit.text = ta.value; });
      ta.focus();
      return;
    }
    pane.innerHTML = `<div class="nt-col">${header()}<article id="nt-body" class="markdown nt-md">${f.html || ''}</article></div>`;
    linkify($('nt-body'));
  }

  async function select(p, { keepEdit = false } = {}) {
    if (!keepEdit && !confirmLeave()) return;
    N.path = p;
    if (!keepEdit) N.edit = null;
    layout.classList.add('nt-reading');
    for (const r of list.querySelectorAll('.nt-row')) r.classList.toggle('sel', r.dataset.path === p);
    let f;
    try { f = await api(`/api/fs/file?path=${encodeURIComponent(p)}`); } catch (err) {
      if (N.path !== p) return;
      pane.dataset.path = p;
      pane.innerHTML = `<div class="nt-col">${header()}<p class="nt-msg">${esc(err.message === 'Not found' ? 'This note is gone. It may have been moved or deleted elsewhere.' : err.message)}</p></div>`;
      return;
    }
    if (N.path !== p) return;   // another pick came in while this one loaded
    N.file = f;
    paintNote();
  }

  // ---- Editing ----
  const dirty = () => !!N.edit && N.edit.text !== N.edit.base;
  function confirmLeave() {
    if (!dirty()) return true;
    if (!confirm(`Discard your unsaved changes to ${titleOf(N.path)}?`)) return false;
    N.edit = null;
    return true;
  }
  function startEdit() {
    N.edit = { base: N.file.source || '', text: N.file.source || '', mtime: N.file.mtime, saving: false };
    paintNote();
  }
  function showErr(msg) { const e = $('nt-err'); if (e) e.textContent = msg || ''; }
  async function save({ force = false } = {}) {
    if (!N.edit || N.edit.saving) return;
    if (!N.edit.text.trim()) { showErr('A note needs some text. Use Done to remove a rough note.'); return; }
    N.edit.saving = true;
    showErr('');
    try {
      let mtime = N.edit.mtime;
      if (force) mtime = (await api(`/api/fs/file?path=${encodeURIComponent(N.path)}`)).mtime;
      WRITES++;
      const res = await fetch('/api/fs/text/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: N.path, text: N.edit.text, mtime }) });
      if (res.status === 401) { showLogin(); return; }
      const d = await res.json().catch(() => ({}));
      if (res.status === 409) { const b = $('nt-conflict'); if (b) b.hidden = false; return; }
      if (!res.ok) { showErr(d.error || "Couldn't save. Check the connection and try again."); return; }
      N.edit = null;
      await select(N.path, { keepEdit: true });
      load();
    } catch {
      showErr("Couldn't save. Check the connection and try again.");
    } finally {
      if (N.edit) N.edit.saving = false;
    }
  }
  async function loadTheirs() {
    const f = await api(`/api/fs/file?path=${encodeURIComponent(N.path)}`);
    N.file = f;
    N.edit = { base: f.source || '', text: f.source || '', mtime: f.mtime, saving: false };
    paintNote();
  }

  // ---- Done / Undo ----
  async function done() {
    if (N.removing) return;
    N.removing = true;
    const btn = $('nt-done');
    if (btn) btn.disabled = true;
    try { await removeNote(N.path); } finally { N.removing = false; }
  }
  async function removeNote(p) {
    let res;
    try {
      WRITES++;
      res = await fetch('/api/notes/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) });
    } catch { toast("Couldn't reach VaultOS. Try again."); const b = $('nt-done'); if (b) b.disabled = false; return; }
    if (res.status === 401) { showLogin(); return; }
    const d = await res.json().catch(() => ({}));
    N.path = null;
    N.file = null;
    layout.classList.remove('nt-reading');
    if (!res.ok) { toast(d.error || 'Something went wrong.'); await load(); paintWelcome(); return; }
    await load();
    paintWelcome();
    toast('Removed', {
      tone: 'info', action: 'Undo', ms: 30000,
      onAction: async () => {
        try {
          await api('/api/notes/undo', { method: 'POST', body: JSON.stringify({ token: d.token }) });
          await load();
          select(p);
        } catch (err) { toast(err.message); }
      },
    });
  }

  pane.addEventListener('click', (e) => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.classList.contains('nt-link')) {
      e.preventDefault();
      const p = t.dataset.path;
      if (N.data && N.data.main.some((i) => i.path === p) || isInbox(p)) select(p);
      else fxOpen(p, { reveal: true });
      return;
    }
    switch (t.id) {
      case 'nt-back': if (confirmLeave()) { layout.classList.remove('nt-reading'); } break;
      case 'nt-edit': startEdit(); break;
      case 'nt-done': done(); break;
      case 'nt-save': save(); break;
      case 'nt-cancel': if (confirmLeave()) { N.edit = null; paintNote(); } break;
      case 'nt-theirs': loadTheirs(); break;
      case 'nt-mine': save({ force: true }); break;
      default:
    }
  });
  pane.addEventListener('keydown', (e) => {
    if (e.target.id === 'nt-text' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ---- Showing ----
  function show() {
    load();
    clearInterval(N.timer);
    N.timer = setInterval(() => { if (document.visibilityState === 'visible' && STATE.mode === 'notes') load(); }, POLL_MS);
    if (!N.path) paintWelcome();
  }
  function hide() { clearInterval(N.timer); N.timer = null; }
  async function open(p) {
    if (STATE.mode !== 'notes') setMode('notes');
    if (STATE.mode !== 'notes') return;   // setMode was refused (unsaved edit kept)
    await load();
    await select(p);
  }

  return { show, hide, open, refresh, current: () => N.path, isDirty: dirty, confirmLeave };
})();
window.Notes = Notes;
