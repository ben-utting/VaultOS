// The capture box: write a thought down from anywhere in VaultOS, then carry on (window.Capture).
//
// Opened by the header pen (#capture-btn), Ctrl+J / ⌘J (NotesCore.captureKeyIntent) or /?capture=1 (the
// home-screen shortcut, app.js start()). Save, or Ctrl+Enter, posts to /api/notes/capture, which writes one file
// in the inbox folder; the toast's Open goes to that note in Notes mode. Esc, a click outside or × closes the box
// and keeps the draft (localStorage, a convenience only). A failed save keeps the box open with the text: nothing
// is cleared until the server says 200.
'use strict';

const Capture = (() => {
  const DRAFT_KEY = 'vaultboard.captureDraft';
  const OFFLINE = "Couldn't save. Check the connection and try again.";
  const box = $('cp-box');
  const ta = $('cp-text');
  const saveBtn = $('cp-save');
  const errEl = $('cp-err');
  const S = { open: false, saving: false, back: null };

  const isMac = () => /Mac|iPhone|iPad/.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
  const readDraft = () => { try { return localStorage.getItem(DRAFT_KEY) || ''; } catch { return ''; } };
  const writeDraft = (v) => { try { if (v) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch { /* no storage: the draft just doesn't outlive the page */ } };
  const setErr = (msg) => { errEl.textContent = msg || ''; };
  const inboxName = () => {
    const parts = String((ME.notes && ME.notes.inbox) || 'Inbox').split('/');
    return parts[parts.length - 1];
  };

  function open() {
    if (!notesOn()) return;
    if (S.open) { ta.focus(); return; }
    const a = document.activeElement;
    S.back = a && a !== document.body && !box.contains(a) ? a : null;
    S.open = true;
    if (!ta.value) ta.value = readDraft();
    setErr('');
    box.classList.remove('hidden');
    $('capture-btn').setAttribute('aria-expanded', 'true');
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function close({ restoreFocus = true } = {}) {
    if (!S.open) return;
    S.open = false;
    writeDraft(ta.value);
    box.classList.add('hidden');
    $('capture-btn').setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      const b = S.back && S.back.isConnected && S.back.getClientRects().length ? S.back : null;
      if (b) b.focus();
    }
    S.back = null;
  }

  async function save() {
    if (S.saving) return;
    const text = ta.value;
    if (!text.trim()) { setErr('Type something first.'); ta.focus(); return; }
    S.saving = true;
    saveBtn.disabled = true;
    setErr('');
    try {
      let res;
      try {
        res = await fetch('/api/notes/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      } catch { setErr(OFFLINE); return; }
      if (res.status === 401) { writeDraft(text); showLogin(); return; }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.path) { setErr((data && data.error) || OFFLINE); return; }
      ta.value = '';
      clearTimeout(draftTimer);
      writeDraft('');
      close();
      toast(`Saved to ${inboxName()}`, {
        tone: 'info',
        action: 'Open',
        onAction: () => { if (window.Notes) Notes.open(data.path); else setMode('notes'); },
      });
      if (window.Notes) Notes.refresh();
    } finally {
      S.saving = false;
      saveBtn.disabled = false;
    }
  }

  $('capture-btn').addEventListener('click', () => (S.open ? close() : open()));
  $('cp-close').addEventListener('click', () => close());
  saveBtn.addEventListener('click', save);
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  // The draft is kept as it is typed (not only on close), so a reload or the phone killing the app loses nothing.
  let draftTimer = 0;
  ta.addEventListener('input', () => {
    if (errEl.textContent) setErr('');
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => writeDraft(ta.value), 300);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (isMac() ? e.metaKey : e.ctrlKey)) { e.preventDefault(); save(); }
  });

  // Ctrl+J / ⌘J. Capture phase, so it's seen before the page acts on it. The same overlays that own the search
  // shortcut own this one: the document and diagram viewers, Settings, the sign-in screen, the Morning read card,
  // a terminal's shortcut sheet or picker, and the search panel itself.
  const overlayAbove = () => !!(DGV || DOCV) || sheetOpen() || $('app').classList.contains('hidden')
    || !$('km-card').classList.contains('hidden') || !!document.querySelector('.tw-sheet, .tw-pick')
    || (window.SearchPanel && SearchPanel.isOpen());
  document.addEventListener('keydown', (e) => {
    if (!notesOn() || overlayAbove()) return;
    const t = e.target instanceof Element ? e.target : null;
    const intent = NotesCore.captureKeyIntent({
      key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, isMac: isMac(),
      boxOpen: S.open,
      inEditable: !!(t && (t.isContentEditable || t.closest('input, textarea, select'))),
      inTerminal: !!(t && t.closest('.xterm')),
    });
    if (intent !== 'open') return;
    e.preventDefault();
    if (!e.repeat) open();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !S.open) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  return { open, close, isOpen: () => S.open };
})();
window.Capture = Capture;
