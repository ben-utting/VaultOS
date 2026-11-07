#!/usr/bin/env node
'use strict';
// README screenshots. Resets the portable preview (127.0.0.1:7692) and seeds the made-up demo vault (readme-demo.js),
// then takes each shot in the dark and light themes into docs/images/.
//
//   node scripts/readme-shots.js            all shots
//   node scripts/readme-shots.js board kb   only these (board, card, kb, workbench, today)
//
// Only ever runs against the portable preview; it wipes that preview's vault.
const path = require('path');
const fs = require('fs');
const { OUT, PUPPETEER, CHROME, sleep, setup, openPage, fontsReady, mode } = require('./readme-demo');

const VIEW = { width: 1440, height: 900, deviceScaleFactor: 2 };
// Headless Chrome draws xterm's text at twice its size when the scale is 2, so the terminal shot is taken at 1.
const TERM_VIEW = { ...VIEW, deviceScaleFactor: 1 };
// Five columns (Needs Decision and Scheduled hidden, as Settings can) need about 1480 CSS px; 2880 px wide.
const BOARD_VIEW = { width: 1500, height: 820, deviceScaleFactor: 1.92 };
const ALL = ['board', 'card', 'kb', 'workbench', 'today'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const w of want) if (!ALL.includes(w)) { console.error(`unknown shot: ${w} (${ALL.join(', ')})`); process.exit(2); }

// ---------- shots ----------
async function main() {
  const { cookie, sp } = await setup();
  fs.mkdirSync(OUT, { recursive: true });
  const puppeteer = (await import(PUPPETEER)).default;
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--font-render-hinting=none'] });
  try {
    for (const theme of ['dark', 'light']) {
      // One context per theme and one page per shot: nothing (a terminal, a scroll position, the screen scale)
      // carries from one shot into the next.
      const ctx = await browser.createBrowserContext();
      const open = (view) => openPage(ctx, view, { theme, cookie, sp });
      const shot = async (page, name, after) => {
        await sleep(700);
        await fontsReady(page);
        const file = path.join(OUT, `${name}-${theme}.png`);
        await page.screenshot({ path: file });
        console.log(`  ${path.relative(process.cwd(), file)}`);
        if (after) await after();
        await page.close();
      };

      if (want.includes('board')) {
        const page = await open(BOARD_VIEW);
        await mode(page, 'board');
        await shot(page, 'board');
      }
      if (want.includes('card')) {
        const page = await open(VIEW);
        await mode(page, 'board');
        await page.click('#board .card[data-path$="01-landing-page/task.md"]');
        await page.waitForSelector('#drawer [data-v="center"]', { visible: true });
        await sleep(400);
        await page.click('#drawer [data-v="center"]');   // the floating centre view
        await shot(page, 'card');
      }
      if (want.includes('kb')) {
        const page = await open(VIEW);
        await mode(page, 'kb');
        await page.click('.kb-card[data-path$="05-postgres-backups/article.md"]');
        await shot(page, 'kb');
      }
      if (want.includes('workbench')) {
        const page = await open(TERM_VIEW);
        await mode(page, 'files');
        await page.evaluate((p) => fxOpen(p, { reveal: true }), `${sp.dir}/1. launch/01-landing-page/task.md`);
        await sleep(800);
        await page.evaluate((cwd) => termOpen({ cwd, run: "ls -1 .. && echo && grep -E '^- \\[' task.md" }), `${sp.dir}/1. launch/01-landing-page`);
        await sleep(4000);
        // End the shell afterwards, or the next theme's dock reports it as "1 detached".
        const ids = await page.evaluate(() => TW.sessions().map((x) => x.id));
        await shot(page, 'workbench', async () => { for (const id of ids) await page.evaluate((i) => TW.remove(i), id); await sleep(500); });
      }
      if (want.includes('today')) {
        const page = await open(VIEW);
        await mode(page, 'today');
        await shot(page, 'today');
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
