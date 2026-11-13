'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseYoutubeUrl, pickCaption, createImporter, ytdlpEnv, execRun } = require('../lib/learn-youtube');
const { LearnError } = require('../lib/learn-names');

const VTT = fs.readFileSync(path.join(__dirname, 'fixtures', 'learn', 'manual.vtt'), 'utf8');
const ID = (n) => `vid${String(n).padStart(8, '0')}`;   // 11 characters
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseYoutubeUrl accepts the link shapes people paste', () => {
  const v = 'abcdefghijk';
  for (const s of [`https://www.youtube.com/watch?v=${v}`, `https://youtube.com/watch?v=${v}&t=42s`, `https://youtu.be/${v}`,
    `https://youtu.be/${v}?si=xyz`, `https://www.youtube.com/shorts/${v}`, `https://www.youtube.com/live/${v}`,
    `https://m.youtube.com/watch?v=${v}`, `youtube.com/watch?v=${v}`, `  https://www.youtube.com/watch?v=${v}  `]) {
    assert.deepEqual(parseYoutubeUrl(s), { videoId: v, listId: null }, s);
  }
  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/playlist?list=PLe3qqz7JaEDM'), { videoId: null, listId: 'PLe3qqz7JaEDM' });
  assert.deepEqual(parseYoutubeUrl(`https://www.youtube.com/watch?v=${v}&list=PL0123456789abcdef`), { videoId: v, listId: 'PL0123456789abcdef' });
});

test('parseYoutubeUrl ignores YouTube mixes (endless RD lists) and refuses everything else', () => {
  assert.deepEqual(parseYoutubeUrl('https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1'), { videoId: 'abcdefghijk', listId: null });
  for (const s of ['https://example.com/watch?v=abcdefghijk', '-o/etc/passwd', 'javascript:alert(1)', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=abcdefghijk1', 'https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://www.youtube.com/',
    'ftp://youtube.com/watch?v=abcdefghijk', '', null, 42]) {
    assert.equal(parseYoutubeUrl(s), null, String(s));
  }
});

test('pickCaption: captions a person wrote win, English first, then the video\'s language', () => {
  const vtt = [{ ext: 'json3' }, { ext: 'vtt' }];
  assert.deepEqual(pickCaption({ language: 'en', subtitles: { 'en-GB': vtt }, automatic_captions: { en: vtt } }), { lang: 'en-GB', auto: false });
  assert.deepEqual(pickCaption({ language: 'de', subtitles: { de: vtt, en: vtt }, automatic_captions: {} }), { lang: 'en', auto: false });
  assert.deepEqual(pickCaption({ language: 'de', subtitles: { de: vtt, fr: vtt }, automatic_captions: { en: vtt } }), { lang: 'de', auto: false });
  assert.deepEqual(pickCaption({ language: 'en', subtitles: { live_chat: vtt }, automatic_captions: { en: vtt, 'en-orig': vtt } }), { lang: 'en-orig', auto: true });
  assert.deepEqual(pickCaption({ language: 'en', subtitles: {}, automatic_captions: { en: vtt } }), { lang: 'en', auto: true });
});

test('pickCaption: auto captions only in the video\'s own language, never a machine translation', () => {
  const vtt = [{ ext: 'vtt' }];
  assert.deepEqual(pickCaption({ language: 'de', subtitles: {}, automatic_captions: { en: vtt, de: vtt, 'de-orig': vtt } }), { lang: 'de-orig', auto: true });
  assert.deepEqual(pickCaption({ language: null, subtitles: {}, automatic_captions: { en: vtt, 'fr-orig': vtt } }), { lang: 'fr-orig', auto: true });
  assert.equal(pickCaption({ language: 'de', subtitles: {}, automatic_captions: { en: vtt } }), null);
  assert.equal(pickCaption({ language: 'en', subtitles: { en: [{ ext: 'srv3' }] }, automatic_captions: {} }), null);
  assert.equal(pickCaption({}), null);
});

// A fake yt-dlp: -J answers from `videos`, --flat-playlist from `lists`, a captions call writes the fixture.
function fakeRun(t, { videos = {}, lists = {}, delayMs = 0, fail = {} } = {}) {
  const calls = [];
  const run = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (delayMs) await sleep(delayMs);
    const url = args[args.indexOf('--') + 1];
    if (fail.enoent) return { code: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn'), { code: 'ENOENT' }) };
    if (fail.timeout) return { code: null, stdout: '', stderr: '', error: new Error('killed'), timedOut: true };
    if (args.includes('--flat-playlist')) {
      const id = new URL(url).searchParams.get('list');
      const entries = (lists[id] || []).map((v) => ({ id: v, title: `Title ${v}` }));
      return { code: 0, stdout: JSON.stringify({ id, title: 'A playlist', entries }), stderr: '' };
    }
    const id = new URL(url).searchParams.get('v');
    const v = videos[id];
    if (!v) return { code: 1, stdout: '', stderr: 'ERROR: [youtube] x: Video unavailable' };
    if (v.stderr) return { code: 1, stdout: '', stderr: v.stderr };
    if (args.includes('-J')) {
      return { code: 0, stdout: JSON.stringify({ id, title: v.title, channel: 'A channel', duration: 593, language: 'en', subtitles: v.subs || {}, automatic_captions: {} }), stderr: '' };
    }
    const lang = args[args.indexOf('--sub-langs') + 1];
    const out = args[args.indexOf('-o') + 1].replace('%(id)s', id);
    fs.writeFileSync(`${out}.${lang}.vtt`, v.vtt || VTT);
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-yt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  const tmpRoot = path.join(root, 'tmp');
  fs.mkdirSync(path.join(vault, 'Learning', 'A'), { recursive: true });
  fs.mkdirSync(path.join(vault, 'Learning', 'B'), { recursive: true });
  fs.mkdirSync(tmpRoot);
  return { root, vault, tmpRoot, nb: (n) => ({ abs: path.join(vault, 'Learning', n), rel: `Learning/${n}` }) };
}
const caps = { en: [{ ext: 'vtt' }] };
async function finished(imp, id, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = imp.status(id);
    if (j.state !== 'running') return j;
    if (Date.now() > end) throw new Error('job did not finish');
    await sleep(10);
  }
}

test('one video: saved as Sources/<title>.txt with the transcript layout, no temp files left', async (t) => {
  const s = setup(t);
  const { run, calls } = fakeRun(t, { videos: { [ID(1)]: { title: 'Part 3: Lights / lamps?', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const id = imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` });
  const job = await finished(imp, id);
  assert.equal(job.state, 'done');
  assert.deepEqual(job.saved, ['Learning/A/Sources/Part 3 Lights lamps.txt']);
  const text = fs.readFileSync(path.join(s.nb('A').abs, 'Sources', 'Part 3 Lights lamps.txt'), 'utf8');
  assert.match(text, /^Title: Part 3: Lights \/ lamps\?\nChannel: A channel\nLink: https:\/\/www\.youtube\.com\/watch\?v=vid00000001\nLength: 9:53\nFetched: 2026-11-13\n\n\[0:02\] So, has everyone/);
  assert.deepEqual(fs.readdirSync(path.join(s.nb('A').abs, 'Sources')), ['Part 3 Lights lamps.txt']);
  assert.deepEqual(fs.readdirSync(s.tmpRoot), []);
  for (const c of calls) {
    const at = c.args.indexOf('--');
    assert.ok(at > 0 && c.args[at + 1] === `https://www.youtube.com/watch?v=${ID(1)}`, 'canonical URL after --');
    assert.ok(c.args.includes('--ignore-config'));
  }
});

test('a second import of the same title gets (2)', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, { videos: { [ID(1)]: { title: 'Same', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` }));
  const j = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` }));
  assert.deepEqual(j.saved, ['Learning/A/Sources/Same (2).txt']);
});

test('failures are one plain line and leave no file', async (t) => {
  const cases = [
    [{ videos: { [ID(1)]: { title: 'x', subs: {} } } }, 'This video has no captions.'],
    [{ videos: { [ID(1)]: { stderr: 'ERROR: [youtube] x: Private video. Sign in if you\'ve been granted access' } } }, 'This video is private or was removed.'],
    [{ videos: {} }, 'This video is private or was removed.'],
    [{ videos: { [ID(1)]: { stderr: 'ERROR: [youtube] x: Sign in to confirm your age.' } } }, 'This video is age-restricted.'],
    [{ videos: { [ID(1)]: { stderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot.' } } }, 'YouTube refused the request from this server. Try again later.'],
    [{ videos: { [ID(1)]: { stderr: 'ERROR: unable to download webpage: HTTP Error 429: Too Many Requests' } } }, 'YouTube refused the request from this server. Try again later.'],
    [{ fail: { timeout: true } }, 'YouTube took too long to answer.'],
    [{ fail: { enoent: true } }, 'Transcript import needs yt-dlp in the image.'],
    [{ videos: { [ID(1)]: { title: 'x', subs: caps, vtt: 'WEBVTT\n\n' } } }, 'This video has no captions.'],
  ];
  for (const [opts, message] of cases) {
    const s = setup(t);
    const { run } = fakeRun(t, opts);
    const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
    const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` }));
    assert.equal(job.state, 'failed', message);
    assert.equal(job.error, message);
    assert.deepEqual(job.saved, []);
    const src = path.join(s.nb('A').abs, 'Sources');
    assert.deepEqual(fs.existsSync(src) ? fs.readdirSync(src) : [], [], message);
    assert.deepEqual(fs.readdirSync(s.tmpRoot), [], message);
  }
});

test('a link that is not YouTube is 400 before anything runs', (t) => {
  const s = setup(t);
  const { run, calls } = fakeRun(t);
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13' });
  assert.throws(() => imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://example.com/v' }),
    (e) => e instanceof LearnError && e.status === 400 && e.message === 'That isn\'t a YouTube link.');
  assert.throws(() => imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}`, playlist: true }),
    (e) => e instanceof LearnError && e.status === 400);
  assert.equal(calls.length, 0);
});

test('a playlist: one video without captions does not stop the rest', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, {
    lists: { PL0123456789: [ID(1), ID(2), ID(3)] },
    videos: { [ID(1)]: { title: 'One', subs: caps }, [ID(2)]: { title: 'Two', subs: {} }, [ID(3)]: { title: 'Three', subs: caps } },
  });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' }));
  assert.equal(job.state, 'done');
  assert.equal(job.done, 3);
  assert.equal(job.total, 3);
  assert.equal(job.listed, 3);
  assert.deepEqual(job.saved, ['Learning/A/Sources/One.txt', 'Learning/A/Sources/Three.txt']);
  assert.deepEqual(job.failed, [{ title: `Title ${ID(2)}`, reason: 'This video has no captions.' }]);
});

test('a watch link with a list imports the list only when asked', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, { lists: { PL0123456789: [ID(1), ID(2)] }, videos: { [ID(1)]: { title: 'One', subs: caps }, [ID(2)]: { title: 'Two', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const url = `https://www.youtube.com/watch?v=${ID(1)}&list=PL0123456789`;
  assert.equal((await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url }))).saved.length, 1);
  assert.equal((await finished(imp, imp.start(s.nb('B').abs, s.nb('B').rel, { url, playlist: true }))).saved.length, 2);
});

test('a playlist longer than 50 imports the first 50 and says how many there were', async (t) => {
  const s = setup(t);
  const ids = Array.from({ length: 60 }, (_, i) => ID(i + 1));
  const videos = Object.fromEntries(ids.map((v) => [v, { title: v, subs: caps }]));
  const { run } = fakeRun(t, { lists: { PL0123456789: ids }, videos });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' }), 10000);
  assert.equal(job.total, 50);
  assert.equal(job.listed, 60);
  assert.equal(job.saved.length, 50);
});

test('the pause between playlist videos is honoured', async (t) => {
  const s = setup(t);
  const { run, calls } = fakeRun(t, { lists: { PL0123456789: [ID(1), ID(2)] }, videos: { [ID(1)]: { title: 'One', subs: caps }, [ID(2)]: { title: 'Two', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 150 });
  const started = Date.now();
  await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' }));
  assert.ok(Date.now() - started >= 150);
  assert.equal(calls.length, 5);
});

test('one import per notebook at a time: a second is 409', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, { delayMs: 50, videos: { [ID(1)]: { title: 'One', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const id = imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` });
  assert.equal(imp.busy('Learning/A'), id);
  assert.throws(() => imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` }),
    (e) => e instanceof LearnError && e.status === 409 && e.message === 'An import is already running in this notebook.');
  await finished(imp, id);
  assert.equal(imp.busy('Learning/A'), null);
});

test('an import carries on unwatched, and lands in its own notebook while another runs (Review Focus 5)', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, {
    delayMs: 5,
    lists: { PL0123456789: [ID(1), ID(2), ID(3)], PLabcdefghij: [ID(4)] },
    videos: Object.fromEntries([1, 2, 3, 4].map((n) => [ID(n), { title: `T${n}`, subs: caps }])),
  });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 5 });
  const a = imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' });
  const b = imp.start(s.nb('B').abs, s.nb('B').rel, { url: 'https://www.youtube.com/playlist?list=PLabcdefghij' });
  await sleep(400);   // nobody asks for status meanwhile
  assert.equal(imp.status(a).state, 'done');
  assert.equal(imp.status(b).state, 'done');
  assert.deepEqual(fs.readdirSync(path.join(s.nb('A').abs, 'Sources')).sort(), ['T1.txt', 'T2.txt', 'T3.txt']);
  assert.deepEqual(fs.readdirSync(path.join(s.nb('B').abs, 'Sources')), ['T4.txt']);
});

test('status of an unknown job is null', (t) => {
  const s = setup(t);
  const imp = createImporter({ run: fakeRun(t).run, tmpRoot: s.tmpRoot, today: () => '2026-11-13' });
  assert.equal(imp.status('nope'), null);
});

test('one video that breaks in an unexpected way is a failed entry, not the end of the playlist', async (t) => {
  const s = setup(t);
  const base = fakeRun(t, { lists: { PL0123456789: [ID(1), ID(2), ID(3)] }, videos: Object.fromEntries([1, 2, 3].map((n) => [ID(n), { title: `T${n}`, subs: caps }])) });
  const run = async (bin, args, opts) => { if (args.includes(`https://www.youtube.com/watch?v=${ID(2)}`)) throw new Error('spawn exploded'); return base.run(bin, args, opts); };
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' }));
  assert.equal(job.state, 'done');
  assert.deepEqual(job.saved, ['Learning/A/Sources/T1.txt', 'Learning/A/Sources/T3.txt']);
  assert.deepEqual(job.failed, [{ title: `Title ${ID(2)}`, reason: 'Something went wrong with this video.' }]);
});

test('a long non-Latin title and an odd character code still import', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, { videos: { [ID(1)]: { title: '漢'.repeat(120), subs: caps, vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi &#99999999; there.\n' } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: `https://youtu.be/${ID(1)}` }));
  assert.equal(job.state, 'done', job.error);
  assert.ok(Buffer.byteLength(path.basename(job.saved[0])) <= 255);
});

test('a notebook deleted mid-import stops the job and is not brought back', async (t) => {
  const s = setup(t);
  const { run } = fakeRun(t, { delayMs: 30, lists: { PL0123456789: [ID(1), ID(2), ID(3)] }, videos: Object.fromEntries([1, 2, 3].map((n) => [ID(n), { title: `T${n}`, subs: caps }])) });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 30 });
  const id = imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' });
  await sleep(40);
  fs.rmSync(s.nb('A').abs, { recursive: true, force: true });
  const job = await finished(imp, id, 5000);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'That notebook is gone.');
  assert.equal(fs.existsSync(s.nb('A').abs), false, 'the notebook folder was not recreated');
});

test('YouTube refusing the server stops a playlist instead of trying every video', async (t) => {
  const s = setup(t);
  const { run, calls } = fakeRun(t, { lists: { PL0123456789: [ID(1), ID(2), ID(3)] }, videos: { [ID(1)]: { stderr: 'ERROR: [youtube] x: Sign in to confirm you’re not a bot.' }, [ID(2)]: { title: 'T2', subs: caps }, [ID(3)]: { title: 'T3', subs: caps } } });
  const imp = createImporter({ run, tmpRoot: s.tmpRoot, today: () => '2026-11-13', pauseMs: 0 });
  const job = await finished(imp, imp.start(s.nb('A').abs, s.nb('A').rel, { url: 'https://www.youtube.com/playlist?list=PL0123456789' }));
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'YouTube refused the request from this server. Try again later.');
  assert.equal(calls.filter((c) => c.args.includes(`https://www.youtube.com/watch?v=${ID(2)}`)).length, 0, 'no more videos were tried');
});

test('yt-dlp gets a small environment: no keys or secrets from the server', async () => {
  const env = ytdlpEnv({ PATH: '/usr/bin', HOME: '/home/x', OPENROUTER_API_KEY: 'sk-or-secret', SESSION_SECRET: 's', LANG: 'en_GB.UTF-8' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  process.env.OPENROUTER_API_KEY = 'sk-or-should-not-leak';
  try {
    const r = await execRun('/usr/bin/env', [], { timeoutMs: 5000 });
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('OPENROUTER_API_KEY'));
    assert.match(r.stdout, /^PATH=/m);
  } finally { delete process.env.OPENROUTER_API_KEY; }
});
