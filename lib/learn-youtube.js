'use strict';
// "Add YouTube video": a video's captions, or every video's in a playlist, saved into a notebook's Sources/ as
// time-marked text. yt-dlp does the fetching. It is run with an argument list (no shell), with `--` before a
// canonical URL rebuilt from the parsed id, so nothing typed into the link box can become a flag. A video already in
// Sources/ is never fetched again, so adding a playlist a second time brings only what's new, and the files keep the
// order they came in (Learn lists Sources/ oldest first).
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { LearnError, safeTitle, uniqueName } = require('./learn-names');
const { parseVtt, dedupeRolling, toParagraphs, transcriptText } = require('./learn-captions');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const CALL_MS = 90000;
const KEEP_JOB_MS = 3600000;

const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const listUrl = (id) => `https://www.youtube.com/playlist?list=${id}`;

// { videoId, listId } (either may be null), or null when it isn't a YouTube video or playlist link. A YouTube "mix"
// (list=RD…, endless and made up on the fly) is dropped, so a link from one is just its video.
function parseYoutubeUrl(s) {
  if (typeof s !== 'string') return null;
  let raw = s.trim();
  if (/^(www\.|m\.)?youtube\.com\/|^youtu\.be\//i.test(raw)) raw = `https://${raw}`;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  let video = null;
  if (host === 'youtu.be') video = segs[0] || null;
  else if (HOSTS.has(host)) {
    if (segs[0] === 'watch') video = u.searchParams.get('v');
    else if ((segs[0] === 'shorts' || segs[0] === 'live') && segs.length === 2) video = segs[1];
    else if (segs[0] !== 'playlist') return null;
  } else return null;
  let list = u.searchParams.get('list');
  if (list && (/^RD/.test(list) || !LIST_ID.test(list))) list = null;
  const videoId = video && VIDEO_ID.test(video) ? video : null;
  if (!videoId && !list) return null;
  return { videoId, listId: list };
}

const hasVtt = (tracks) => Array.isArray(tracks) && tracks.some((t) => t && t.ext === 'vtt');

// Which caption track to fetch: { lang, auto } or null. Captions a person wrote first (English, then the video's
// language); then auto-captions in the video's own language only (a machine translation of speech recognition reads
// badly, and the agent can translate).
function pickCaption(info) {
  const manual = (info && info.subtitles) || {};
  const auto = (info && info.automatic_captions) || {};
  const lang = info && typeof info.language === 'string' && info.language ? info.language : null;
  const manualKeys = Object.keys(manual).filter((k) => k !== 'live_chat' && hasVtt(manual[k]));
  const english = ['en', ...manualKeys.filter((k) => /^en-/.test(k)).sort()];
  const own = lang ? [lang, ...manualKeys.filter((k) => k.startsWith(`${lang}-`)).sort()] : [];
  for (const k of [...english, ...own]) if (manualKeys.includes(k)) return { lang: k, auto: false };
  const autoKeys = Object.keys(auto).filter((k) => hasVtt(auto[k]));
  const wanted = lang ? [`${lang}-orig`, lang] : autoKeys.filter((k) => k.endsWith('-orig'));
  for (const k of wanted) if (autoKeys.includes(k)) return { lang: k, auto: true };
  return null;
}

class FetchFail extends Error {}
class Stop extends FetchFail {}   // ends the whole job (the notebook is gone, YouTube refused us), not one video
const REFUSED = 'YouTube refused the request from this server. Try again later.';
const GONE = 'That notebook is gone.';

// yt-dlp runs YouTube's player JavaScript (under node), so it gets a small environment: no keys or secrets. The one
// extra is SSL_CERT_FILE, a path: the bundle docker-entrypoint.sh writes when certs/ holds a work proxy's root, which
// yt-dlp's Python needs to reach YouTube through a proxy that inspects HTTPS.
function ytdlpEnv(env) {
  const out = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME || '/tmp', LANG: env.LANG || 'C.UTF-8' };
  if (env.SSL_CERT_FILE) out.SSL_CERT_FILE = env.SSL_CERT_FILE;
  return out;
}
// The importer's default `run`: an argument list, never a shell. timedOut: killed for running too long.
function execRun(bin, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: ytdlpEnv(process.env) }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr, error: error || undefined, timedOut: !!(error && error.killed) });
    });
  });
}
async function exists(dir) {
  try { return (await fsp.stat(dir)).isDirectory(); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
}

function failure(result) {
  if (result.error && result.error.code === 'ENOENT') return 'Transcript import needs yt-dlp in the image.';
  if (result.timedOut) return 'YouTube took too long to answer.';
  const err = String(result.stderr || '');
  if (/not a bot|HTTP Error 429|Too Many Requests/i.test(err)) return REFUSED;
  if (/confirm your age|age-restricted|age restricted/i.test(err)) return 'This video is age-restricted.';
  if (/Private video|Video unavailable|has been removed|is private|does not exist/i.test(err)) return 'This video is private or was removed.';
  return null;
}

// The videos a notebook already has: the id on the Link line of each transcript in Sources/. Only a .txt that starts
// "Title: " counts, and only its header (up to the first blank line), so a file that just mentions a link doesn't.
const LINK_LINE = /^Link: https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/m;
const HEAD_BYTES = 4096;
async function importedIds(notebookAbs) {
  const dir = path.join(notebookAbs, 'Sources');
  let names;
  try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return new Set(); throw e; }
  const ids = new Set();
  for (const name of names) {
    if (name.startsWith('.') || !/\.txt$/i.test(name)) continue;
    let head;
    try {
      const fh = await fsp.open(path.join(dir, name), 'r');
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
        head = buf.toString('utf8', 0, bytesRead);
      } finally { await fh.close(); }
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'EISDIR') continue; throw e; }
    if (!head.startsWith('Title: ')) continue;
    const m = head.split('\n\n')[0].match(LINK_LINE);
    if (m) ids.add(m[1]);
  }
  return ids;
}

function createImporter({ run = execRun, bin = 'yt-dlp', tmpRoot, fetchedAt, pauseMs = 2000, cap = 50 }) {
  const jobs = new Map();      // id -> job
  const running = new Map();   // notebook rel -> job id
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = ['--ignore-config', '--no-warnings', '--js-runtimes', 'node'];

  async function call(args, generic) {
    const result = await run(bin, [...base, ...args], { timeoutMs: CALL_MS });
    if (result.error || result.code !== 0) {
      const why = failure(result) || generic;
      throw why === REFUSED ? new Stop(why) : new FetchFail(why);
    }
    return result.stdout;
  }
  async function json(args, generic) {
    const out = await call(args, generic);
    try { return JSON.parse(out); } catch { throw new FetchFail('Couldn\'t read YouTube\'s answer.'); }
  }

  // One video into Sources/. Returns its vault-relative path; throws FetchFail with the one-line reason.
  async function fetchOne(videoId, notebookAbs, notebookRel) {
    const url = watchUrl(videoId);
    const info = await json(['-J', '--skip-download', '--', url], 'Couldn\'t fetch that video.');
    const pick = pickCaption(info);
    if (!pick) throw new FetchFail('This video has no captions.');
    const tmp = await fsp.mkdtemp(path.join(tmpRoot, 'learn-'));
    try {
      await call(['--skip-download', pick.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', pick.lang,
        '--sub-format', 'vtt', '-o', path.join(tmp, '%(id)s'), '--', url], 'Couldn\'t fetch that video\'s captions.');
      const vtt = (await fsp.readdir(tmp)).find((n) => n.endsWith('.vtt'));
      if (!vtt) throw new FetchFail('This video has no captions.');
      const paragraphs = toParagraphs(dedupeRolling(parseVtt(await fsp.readFile(path.join(tmp, vtt), 'utf8'))));
      if (!paragraphs.length) throw new FetchFail('This video has no captions.');
      const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : videoId;
      const text = transcriptText({
        title, channel: info.channel || info.uploader || '', url,
        duration: Number(info.duration), fetched: fetchedAt(),
      }, paragraphs);
      // Never bring a deleted or renamed notebook back by making its Sources/ folder.
      if (!(await exists(notebookAbs))) throw new Stop(GONE);
      const sources = path.join(notebookAbs, 'Sources');
      await fsp.mkdir(sources, { recursive: true });
      const name = await uniqueName(sources, safeTitle(title, { max: 100, maxBytes: 180, fallback: videoId }), '.txt');
      const part = path.join(sources, `.${name}.learn-${process.pid}-${Date.now()}`);
      try {
        await fsp.writeFile(part, text);
        await fsp.rename(part, path.join(sources, name));
      } catch (e) {
        await fsp.rm(part, { force: true });
        throw e;
      }
      return `${notebookRel}/Sources/${name}`;
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  async function work(job, notebookAbs, target) {
    const have = await importedIds(notebookAbs);
    if (target.video) {
      if (have.has(target.video)) throw new FetchFail('That video is already in Sources.');
      job.total = 1;
      job.listed = 1;
      job.saved.push(await fetchOne(target.video, notebookAbs, job.notebook));
      job.done = 1;
      return;
    }
    const list = await json(['--flat-playlist', '-J', '--', listUrl(target.list)], 'Couldn\'t fetch that playlist.');
    const entries = (Array.isArray(list.entries) ? list.entries : []).filter((e) => e && VIDEO_ID.test(e.id));
    job.listed = entries.length;
    // New videos only (a playlist can list one twice); the cap counts these, so adding the playlist again gets the rest.
    const fresh = entries.filter((e) => !have.has(e.id) && have.add(e.id));
    job.skipped = entries.length - fresh.length;
    const take = fresh.slice(0, cap);
    job.total = take.length;
    for (let i = 0; i < take.length; i++) {
      const e = take[i];
      const title = typeof e.title === 'string' && e.title ? e.title : e.id;
      try {
        if (!(await exists(notebookAbs))) throw new Stop(GONE);
        job.saved.push(await fetchOne(e.id, notebookAbs, job.notebook));
      } catch (err) {
        if (err instanceof Stop) throw err;   // the notebook went, or YouTube refused: trying the rest makes it worse
        if (err instanceof FetchFail) job.failed.push({ title, reason: err.message });
        else {
          console.error('[learn] import', e.id, err);
          job.failed.push({ title, reason: 'Something went wrong with this video.' });
        }
      }
      job.done = i + 1;
      if (i + 1 < take.length && pauseMs) await sleep(pauseMs);
    }
  }

  function start(notebookAbs, notebookRel, { url, playlist } = {}) {
    const p = parseYoutubeUrl(url);
    if (!p) throw new LearnError(400, 'That isn\'t a YouTube link.');
    let target;
    if (playlist === true) {
      if (!p.listId) throw new LearnError(400, 'That link isn\'t a playlist.');
      target = { list: p.listId };
    } else target = p.videoId ? { video: p.videoId } : { list: p.listId };
    if (running.has(notebookRel)) throw new LearnError(409, 'An import is already running in this notebook.');
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, notebook: notebookRel, state: 'running', done: 0, total: 0, listed: 0, skipped: 0, saved: [], failed: [], error: null };
    jobs.set(id, job);
    running.set(notebookRel, id);
    work(job, notebookAbs, target).then(() => { job.state = 'done'; }, (err) => {
      job.state = 'failed';
      if (err instanceof FetchFail) job.error = err.message;
      else { job.error = 'Something went wrong.'; console.error('[learn] import', err); }
    }).finally(() => {
      running.delete(notebookRel);
      setTimeout(() => jobs.delete(id), KEEP_JOB_MS).unref();
    });
    return id;
  }

  const status = (id) => {
    const j = jobs.get(id);
    return j ? structuredClone(j) : null;
  };
  const busy = (notebookRel) => running.get(notebookRel) || null;

  return { start, status, busy };
}

module.exports = { parseYoutubeUrl, pickCaption, createImporter, ytdlpEnv, execRun };
