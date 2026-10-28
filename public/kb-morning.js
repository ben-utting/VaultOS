'use strict';

// ========================================================================
// The morning read: once a day, between 05:00 and noon in the Today time
// zone, a card with one Knowledge Base article to pick back up. The server
// picks it and keeps it for the day, so every device shows the same card
// until one of them answers it (the morning-read routes in server.js).
// Loaded after app.js and shares its globals ($, api, ws, toast, showLogin,
// setMode, setWorkspace, openArticle, readStaleness, sheetOpen, STATE, ME,
// DGV, DOCV). One global, KbMorning = { init, check }.
//
// It never opens over something else (the task drawer, a doc or diagram
// viewer, Settings, sign-in, a focused terminal): that check is skipped, and
// the next one (the tab coming back into view, a workspace switch) asks again.
// Text from the vault goes in with textContent.
// ========================================================================

const KbMorning = (() => {
  const REASON = { updated: 'Updated since you read it', unread: 'Not read yet' };
  let card = null;          // the card on screen, as the server sent it
  let checking = false;
  let inited = false;
  let returnFocus = null;

  const isOpen = () => !$('km-card').classList.contains('hidden');
  const blocked = () => isOpen() || sheetOpen() || !$('drawer').classList.contains('hidden') || !!DGV || !!DOCV
    || !$('login').classList.contains('hidden') || !!(document.activeElement && document.activeElement.closest('.xterm'));

  async function check() {
    if (!ME.features.morningRead || checking || blocked()) return;
    checking = true;
    try {
      const r = await api(ws('/api/kb/morning'));
      if (r.card && !blocked()) show(r.card);
    } catch { /* no card this time; the next check asks again */ }
    finally { checking = false; }
  }

  function show(c) {
    card = c;
    $('km-eyebrow').textContent = `Morning read · ${c.minutes} min`;
    $('km-title').textContent = c.title;
    $('km-excerpt').textContent = (c.excerpt || '').replace(/^TL;DR\s*/i, '');
    $('km-excerpt').classList.toggle('hidden', !c.excerpt);
    $('km-meta').textContent = `${c.wsLabel} · ${c.collectionName}`;
    $('km-reason').textContent = REASON[c.reason] || readStaleness(c.lastRead);
    $('km-reason').classList.toggle('kb-unread', c.reason !== 'stale');
    returnFocus = document.activeElement;
    $('km-scrim').classList.remove('hidden');
    $('km-card').classList.remove('hidden');
    $('km-read').focus();
  }

  function hide() {
    $('km-scrim').classList.add('hidden');
    $('km-card').classList.add('hidden');
    card = null;
    if (returnFocus && document.contains(returnFocus) && returnFocus !== document.body) returnFocus.focus();
    returnFocus = null;
  }

  // fetch, not api(): a 409 means another device answered first, which needs no message.
  async function answer(action) {
    try {
      const res = await fetch('/api/kb/morning', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      if (res.status === 401) return showLogin();
      if (res.ok || res.status === 409) return;
      throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    } catch (err) {
      toast("Couldn't save that: " + err.message);
    }
  }

  async function readNow() {
    const c = card;
    hide();
    await answer('open');   // the article opens whatever the answer
    if (c.ws !== STATE.workspace) setWorkspace(c.ws);
    setMode('kb');
    openArticle(c.path);
  }
  function later() { hide(); answer('later'); }
  function skip() { hide(); answer('skip'); }

  $('km-read').addEventListener('click', readNow);
  $('km-later').addEventListener('click', later);
  $('km-skip').addEventListener('click', skip);
  $('km-scrim').addEventListener('click', later);
  // On window, in the capture phase, so it runs before the document-level Escape handlers
  // of the overlays underneath: while the card is open, Escape is Not today and nothing else.
  window.addEventListener('keydown', (e) => {
    if (!isOpen()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      later();
    } else if (e.key === 'Tab') {   // keep focus on the card's three buttons
      const btns = [$('km-read'), $('km-later'), $('km-skip')];
      const i = btns.indexOf(document.activeElement);
      e.preventDefault();
      btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
    }
  }, true);

  // Once, from start(): the first check, and another whenever the tab comes back into view.
  function init() {
    if (!inited) {
      inited = true;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    }
    check();
  }

  return { init, check };
})();
