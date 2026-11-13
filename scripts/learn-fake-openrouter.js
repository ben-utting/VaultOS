#!/usr/bin/env node
'use strict';
// Stand-in for OpenRouter in the Learn preview (OPENROUTER_BASE_URL=http://127.0.0.1:7697/api/v1). Run inside the
// preview container: docker exec -d -u 1000 learn-preview node /app/scripts/learn-fake-openrouter.js
//   POST /api/v1/responses  -> an explainer "image" (a 96x64 PNG), the title "Rivers in three steps", a model and a cost
//   GET  /api/v1/key        -> { data: { limit_remaining: 4.2 } }
// Anything without "Authorization: Bearer sk-or-…" gets a 401, as OpenRouter would.
const http = require('http');
const zlib = require('zlib');

// A small solid PNG, built by hand (no image library in the image).
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMAGE = png(96, 64, [79, 93, 117]).toString('base64');

http.createServer((req, res) => {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!/^Bearer sk-or-/.test(req.headers.authorization || '')) return send(401, { error: { message: 'No auth credentials found' } });
  if (req.method === 'GET' && req.url === '/api/v1/key') return send(200, { data: { limit_remaining: 4.2 } });
  if (req.method === 'POST' && req.url === '/api/v1/responses') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => send(200, {
      model: 'fake/auto-picked',
      usage: { cost: 0.0312 },
      output: [
        { type: 'image_generation_call', status: 'completed', result: `data:image/png;base64,${IMAGE}` },
        { type: 'message', content: [{ type: 'output_text', text: 'Rivers in three steps' }] },
      ],
    }));
    return undefined;
  }
  return send(404, { error: { message: 'not here' } });
}).listen(7697, '127.0.0.1');
