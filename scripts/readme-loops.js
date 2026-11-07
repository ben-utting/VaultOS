#!/usr/bin/env node
'use strict';
// README loops: short silent clips that stand in for the README screenshots, one per section, in the dark and light
// themes, into docs/images/<name>-<theme>.webp. Same demo vault and preview as readme-shots.js (readme-demo.js).
// Chrome's screencast records the page while Puppeteer acts the loop out. Headless Chrome paints no pointer and no
// drag image, so the page gets a drawn cursor, a ghost card for drags and one caption. ffmpeg evens the frames out
// and cross-fades the last second back into the first frame, so the loop has no visible seam.
//
//   node scripts/readme-loops.js            all loops
//   node scripts/readme-loops.js board      only these (board)
//
// Needs ffmpeg and ffprobe on PATH. Only ever runs against the portable preview; it wipes that preview's vault.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VAULT, OUT, PUPPETEER, CHROME, sleep, setup, openPage, fontsReady, mode } = require('./readme-demo');

const FPS = 25;
const FADE = 0.6;   // seconds of cross-fade from the last frame back to the first
// Scale 1: a 2x screencast is four times the pixels for a picture GitHub shows about 880 px wide.
const BOARD_VIEW = { width: 1500, height: 820, deviceScaleFactor: 1 };

// ---------- the stage (runs in the page) ----------
// Everything the loops draw on top of the app, driven through window.demo. Colours come from the app's own tokens,
// so the cursor ring, ghost and caption follow the theme being recorded.
function stage(caption, rest) {
  const css = document.createElement('style');
  css.textContent = `
    .demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; will-change: transform; }
    .demo-cursor svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); transform-origin: 3px 2px; transition: transform 90ms ease-out; }
    .demo-cursor.down svg { transform: scale(.85); }
    .demo-ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px;
      border-radius: 50%; border: 2px solid var(--accent); opacity: 0; }
    .demo-ring.go { animation: demo-ring 450ms ease-out; }
    @keyframes demo-ring { from { transform: scale(.3); opacity: .9; } to { transform: scale(1.25); opacity: 0; } }
    .demo-ghost { position: fixed !important; left: 0; top: 0; z-index: 2147483645; pointer-events: none; margin: 0;
      border-color: color-mix(in srgb, var(--accent) 60%, transparent) !important;
      box-shadow: var(--shadow-4) !important; rotate: 1.5deg; transition: opacity 160ms ease-out; }
    .demo-caption { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 2147483644; pointer-events: none;
      display: flex; align-items: center; gap: 10px; padding: 11px 20px; border-radius: var(--radius-full);
      background: var(--panel-2); border: 1px solid var(--line); box-shadow: var(--shadow-3);
      color: var(--text); font: 500 17px/1.2 var(--ui-font); white-space: nowrap; }
    .demo-caption::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
    .demo-caption code { font: 500 15.5px var(--mono-font); color: var(--accent); }
  `;
  const el = (cls, html = '') => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; };
  // A plain arrow, white with a dark edge so it reads on both themes. Its tip is at (3, 2).
  const cur = el('demo-cursor', '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M3 2v17.2l4.6-4.3 2.9 6.5 3-1.3-2.9-6.4h6.3z" fill="#fff" stroke="#14161b" stroke-width="1.4" stroke-linejoin="round"/></svg>');
  const ring = el('demo-ring');
  const cap = el('demo-caption', caption);
  document.head.append(css);
  document.body.append(cap, ring, cur);

  let pos = { ...rest };
  let ghost = null;
  let grip = { x: 0, y: 0 };
  let over = null;
  const at = (x, y) => {
    pos = { x, y };
    cur.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    if (!ghost) return;
    ghost.style.transform = `translate(${x - grip.x}px, ${y - grip.y}px)`;
    // The ghost has no pointer events, so this finds the column under the cursor, as a real drag would.
    const col = document.elementFromPoint(x, y)?.closest('.col-body') || null;
    if (col !== over) {
      over?.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
      col?.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      over = col;
    }
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  // A hand doesn't move in a ruler line: the path bows a little to one side.
  const glide = (x, y, ms) => new Promise((done) => {
    const from = { ...pos };
    const bow = Math.hypot(x - from.x, y - from.y) * 0.06;
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      const k = ease(t);
      const off = Math.sin(Math.PI * k) * bow;
      const len = Math.hypot(x - from.x, y - from.y) || 1;
      at(from.x + (x - from.x) * k + (-(y - from.y) / len) * off, from.y + (y - from.y) * k + ((x - from.x) / len) * off);
      if (t < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  });
  const press = (down) => {
    cur.classList.toggle('down', down);
    if (!down) return;
    ring.style.left = `${pos.x}px`;
    ring.style.top = `${pos.y}px`;
    ring.classList.remove('go');
    void ring.offsetWidth;   // restart the animation
    ring.classList.add('go');
  };
  // Pick up the card under the cursor: the app's own dragstart runs, and a copy of the card follows the cursor.
  const lift = (sel) => {
    const card = document.querySelector(sel);
    const r = card.getBoundingClientRect();
    grip = { x: pos.x - r.left, y: pos.y - r.top };
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
    ghost = card.cloneNode(true);
    ghost.classList.remove('dragging');
    ghost.classList.add('demo-ghost');
    ghost.style.width = `${r.width}px`;
    document.body.append(ghost);
    at(pos.x, pos.y);
    return card;
  };
  // Let go over the column under the cursor; the app's drop handler saves the move. The ghost then settles onto the
  // card's new place once the board has redrawn it.
  const drop = async (sel) => {
    const col = over;
    col?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    document.querySelector(sel)?.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
    over = null;
    const g = ghost;
    ghost = null;
    let card = null;
    for (let i = 0; i < 60 && !(card = col && col.querySelector(sel)); i++) await new Promise((r) => setTimeout(r, 25));
    if (card) {
      const r = card.getBoundingClientRect();
      g.style.transition = 'transform 220ms ease-out, rotate 220ms ease-out, opacity 160ms ease-out 140ms';
      g.style.transform = `translate(${r.left}px, ${r.top}px)`;
      g.style.rotate = '0deg';
    }
    g.style.opacity = '0';
    await new Promise((r) => setTimeout(r, 320));
    g.remove();
  };
  at(rest.x, rest.y);
  window.demo = { glide, press, lift, drop, pos: () => pos };
}

// ---------- acting ----------
async function box(page, sel) {
  return page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; });
}
const glide = (page, p, ms = 850) => page.evaluate((x, y, ms) => demo.glide(x, y, ms), p.x, p.y, ms);

// ---------- recording ----------
// Chrome only sends a frame when something repaints, each stamped with its time; the gaps become frame durations.
async function record(page, act) {
  const cdp = await page.createCDPSession();
  const frames = [];
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, everyNthFrame: 1 });
  await act();
  const end = Date.now() / 1000;
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  if (frames.length < 2) throw new Error('the screencast sent no frames');
  return { frames, end };
}

function encode({ frames, end }, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-loop-'));
  try {
    const name = (i) => `f${String(i).padStart(5, '0')}.jpg`;
    const list = ['ffconcat version 1.0'];
    frames.forEach((f, i) => {
      fs.writeFileSync(path.join(dir, name(i)), Buffer.from(f.data, 'base64'));
      const next = i + 1 < frames.length ? frames[i + 1].t : end;
      list.push(`file ${name(i)}`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
    });
    list.push(`file ${name(frames.length - 1)}`);   // concat drops the last entry's duration unless the file repeats
    fs.writeFileSync(path.join(dir, 'list.txt'), `${list.join('\n')}\n`);
    const ff = (...args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: dir });
    ff('-f', 'concat', '-i', 'list.txt', '-vf', `fps=${FPS}`, '-c:v', 'ffv1', 'clip.mkv');
    ff('-i', 'clip.mkv', '-frames:v', '1', 'first.png');
    const len = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'clip.mkv'], { cwd: dir }).toString());
    ff('-i', 'clip.mkv', '-loop', '1', '-framerate', String(FPS), '-t', String(FADE), '-i', 'first.png',
      '-filter_complex', `[0:v]format=yuv420p,settb=AVTB[a];[1:v]format=yuv420p,settb=AVTB[b];[a][b]xfade=transition=fade:duration=${FADE}:offset=${(len - FADE).toFixed(3)}`,
      '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '95', '-compression_level', '6', '-preset', 'drawing', '-loop', '0', file);
    return len;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- the loops ----------
// Each loop starts and ends with the cursor at rest and the app as it was, so the cross-fade is short and quiet.
const LOOPS = {
  board: {
    view: BOARD_VIEW,
    caption: 'Drag a card and its <code>task.md</code> changes',
    rest: (v) => ({ x: v.width * 0.52, y: v.height * 0.66 }),
    async prepare(page) { await mode(page, 'board'); },
    async play(page, { sp }) {
      const sel = '#board .card[data-path$="03-waitlist-email/task.md"]';
      // The drag rewrites the card's status; put the file back afterwards so every take starts from Backlog.
      const file = path.join(VAULT, ...sp.dir.split('/'), '1. launch', '03-waitlist-email', 'task.md');
      const before = { text: fs.readFileSync(file, 'utf8'), stat: fs.statSync(file) };
      try {
        await sleep(900);
        const card = await box(page, sel);
        await glide(page, { x: card.left + card.width * 0.38, y: card.top + 30 }, 1000);
        await sleep(200);
        await page.evaluate(() => demo.press(true));
        await sleep(150);
        await page.evaluate((s) => { demo.lift(s); }, sel);
        const target = await box(page, '#board .col-body[data-status="in-progress"]');
        const p = await page.evaluate(() => demo.pos());
        await glide(page, { x: target.left + (p.x - card.left) + 10, y: target.bottom - 24 }, 1300);
        await sleep(150);
        await page.evaluate((s) => demo.drop(s), sel);
        await page.evaluate(() => demo.press(false));
        await sleep(1500);
        await glide(page, LOOPS.board.rest(BOARD_VIEW), 1000);
        await sleep(500);
      } finally {
        fs.writeFileSync(file, before.text);
        fs.utimesSync(file, before.stat.atime, before.stat.mtime);
      }
    },
  },
};

async function main() {
  const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(LOOPS);
  for (const w of want) if (!LOOPS[w]) { console.error(`unknown loop: ${w} (${Object.keys(LOOPS).join(', ')})`); process.exit(2); }
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });   // fail before the preview is wiped, not after
  const { cookie, sp } = await setup();
  fs.mkdirSync(OUT, { recursive: true });
  const puppeteer = (await import(PUPPETEER)).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    for (const theme of ['dark', 'light']) {
      const ctx = await browser.createBrowserContext();
      for (const name of want) {
        const loop = LOOPS[name];
        const page = await openPage(ctx, loop.view, { theme, cookie, sp });
        await loop.prepare(page);
        await fontsReady(page);
        await page.evaluate(stage, loop.caption, loop.rest(loop.view));
        await sleep(300);
        const take = await record(page, () => loop.play(page, { sp }));
        const file = path.join(OUT, `${name}-${theme}.webp`);
        const len = encode(take, file);
        console.log(`  ${path.relative(process.cwd(), file)}  ${len.toFixed(1)}s, ${take.frames.length} frames, ${(fs.statSync(file).size / 1e6).toFixed(2)} MB`);
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
