#!/usr/bin/env node
'use strict';
// Stand-in for yt-dlp in the Learn preview (YTDLP_BIN=/app/scripts/learn-fake-ytdlp.js). It answers the three calls
// lib/learn-youtube.js makes — video info (-J), a playlist listing (--flat-playlist -J) and a caption download — from
// a fixed, invented catalogue, and never touches the network.
//   Videos: vidaaaaaaa1, vidaaaaaaa2 (captions), noCaptions0 (none), slow0000001..3 (captions, 1.5s per call).
//   Playlists: PLfake00001 = [vidaaaaaaa1, noCaptions0, vidaaaaaaa2]; PLslow00001 = the three slow videos.
const fs = require('fs');

const args = process.argv.slice(2);
const url = new URL(args[args.indexOf('--') + 1]);
const VIDEOS = {
  vidaaaaaaa1: { title: 'Rivers part 1: Where they start', caps: true },
  vidaaaaaaa2: { title: 'Rivers part 2: Deltas', caps: true },
  noCaptions0: { title: 'Rivers part 3: Silent film', caps: false },
  slow0000001: { title: 'Slow lesson one', caps: true, slow: true },
  slow0000002: { title: 'Slow lesson two', caps: true, slow: true },
  slow0000003: { title: 'Slow lesson three', caps: true, slow: true },
};
const LISTS = { PLfake00001: ['vidaaaaaaa1', 'noCaptions0', 'vidaaaaaaa2'], PLslow00001: ['slow0000001', 'slow0000002', 'slow0000003'] };
const VTT = (title) => ['WEBVTT', '', '00:00:01.000 --> 00:00:04.000', `This is ${title}.`, '',
  '00:00:05.000 --> 00:00:09.000', 'Rivers carry water from the hills to the sea.', '',
  '00:00:40.000 --> 00:00:44.000', 'That is all for now.', ''].join('\n');

const out = (o) => { process.stdout.write(JSON.stringify(o)); };
const fail = (msg) => { process.stderr.write(`ERROR: ${msg}\n`); process.exit(1); };

(async () => {
  if (args.includes('--flat-playlist')) {
    const id = url.searchParams.get('list');
    const ids = LISTS[id];
    if (!ids) fail('[youtube:tab] This playlist does not exist');
    return out({ id, title: 'A sample playlist', entries: ids.map((v) => ({ id: v, title: VIDEOS[v].title })) });
  }
  const id = url.searchParams.get('v');
  const v = VIDEOS[id];
  if (!v) fail(`[youtube] ${id}: Video unavailable`);
  if (v.slow) await new Promise((r) => setTimeout(r, 1500));
  if (args.includes('-J')) {
    return out({ id, title: v.title, channel: 'A sample channel', duration: 593, language: 'en', subtitles: v.caps ? { en: [{ ext: 'vtt' }] } : {}, automatic_captions: {} });
  }
  const lang = args[args.indexOf('--sub-langs') + 1];
  const dest = args[args.indexOf('-o') + 1].replace('%(id)s', id);
  fs.writeFileSync(`${dest}.${lang}.vtt`, VTT(v.title));
})();
