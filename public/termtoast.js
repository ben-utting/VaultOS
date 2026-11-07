// Toasts for the terminal workspace: a background agent needs you or finished, a
// terminal opened elsewhere, the 12-terminal cap. A card is a button that never
// takes focus; at most 4 show (the oldest goes). Plus an optional tone.
// Exposes one global: TermToast. Titles and subs are set as text, never as HTML.
const TermToast = (() => {
  const LIFE = { blocked: 8000, done: 5000, info: 4000 };
  const MAX = 4;

  function create(ctx = {}) {
    const el = document.createElement('div');
    el.className = 'tw-toasts';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    let items = [];   // { id, node, timer }

    function drop(it) {
      clearTimeout(it.timer);
      it.node.remove();
      items = items.filter((x) => x !== it);
    }
    function push(t) {
      const kind = LIFE[t.kind] ? t.kind : 'info';
      // A newer toast for the same terminal and kind replaces the older one.
      for (const old of items.filter((x) => t.id != null && x.id === t.id && x.kind === kind)) drop(old);
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'tw-toast';
      node.dataset.kind = kind;
      node.tabIndex = -1;
      const title = document.createElement('span');
      title.className = 'tw-toast-title';
      title.textContent = t.title || '';
      node.appendChild(title);
      if (t.sub) {
        const sub = document.createElement('span');
        sub.className = 'tw-toast-sub';
        sub.textContent = t.sub;
        node.appendChild(sub);
      }
      node.title = [t.title, t.sub].filter(Boolean).join(' · ');
      // Never take focus from the terminal.
      node.addEventListener('mousedown', (e) => e.preventDefault());
      const it = { id: t.id, kind, node, timer: 0 };
      node.addEventListener('click', () => {
        drop(it);
        if (t.id != null && ctx.onClick) ctx.onClick(t.id);
      });
      it.timer = setTimeout(() => drop(it), LIFE[kind]);
      items.push(it);
      el.appendChild(node);
      while (items.length > MAX) drop(items[0]);
      return node;
    }
    function clear() { for (const it of items.slice()) drop(it); }
    return { push, clear, el };
  }

  // A short beep: 660Hz blocked, 880Hz done; focus (a Today session ended) is
  // the two in turn, a rising chime. The context is resumed by the first
  // pointerdown / keydown (browsers keep it suspended until a gesture).
  let ac = null;
  function audio() {
    if (ac) return ac;
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; }
    return ac;
  }
  function wake() { const a = audio(); if (a && a.state === 'suspended') a.resume().catch(() => {}); }
  document.addEventListener('pointerdown', wake, { capture: true, passive: true });
  document.addEventListener('keydown', wake, { capture: true, passive: true });

  const NOTES = { blocked: [660], done: [880], focus: [660, 880] };
  const NOTE_S = 0.12;
  function tone(kind) {
    const notes = Object.hasOwn(NOTES, kind) ? NOTES[kind] : null;
    if (!notes) return;
    const a = audio();
    if (!a) return;
    try {
      notes.forEach((hz, i) => {
        const o = a.createOscillator();
        const g = a.createGain();
        o.frequency.value = hz;
        g.gain.value = 0.05;
        o.connect(g);
        g.connect(a.destination);
        const at = a.currentTime + i * NOTE_S;
        o.start(at);
        o.stop(at + NOTE_S);
      });
    } catch { /* no audio */ }
  }

  return { create, tone };
})();
