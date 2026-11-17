#!/usr/bin/env node
'use strict';
// A fake LogicMonitor REST API v3 for tests, under /santaba/rest. It wants X-Version: 3 and takes either the bearer
// token in state.goodToken or an LMv1 signature for state.accessId/state.accessKey (epoch within 30 minutes), and
// answers a few core-monitoring GETs from fixtures. Modes make it answer 403, 429, 500, a redirect, an HTML page,
// or a device list over 150 KB. node:http only, so it runs inside the image.
const http = require('node:http');
const crypto = require('node:crypto');

const REST = '/santaba/rest';

function startFakeLm({ port = 0, host = '127.0.0.1' } = {}) {
  const state = { seen: [], mode: 'normal', goodToken: 'lmb-good', accessId: 'lm-id', accessKey: 'lm-key' };
  const DEVICE = {
    id: 1, displayName: 'web01', hostStatus: 'normal',
    customProperties: [{ name: 'snmp.community', value: 'public' }, { name: 'wmi.pass', value: 'pw' }, { name: 'system.hostname', value: 'web01' }],
  };
  const ALERTS = [
    { id: 'LMA1', severity: 4, monitorObjectName: 'web01', dataPointName: 'CPUBusyPercent', cleared: false },
    { id: 'LMA2', severity: 2, monitorObjectName: 'db01', dataPointName: 'DiskUsedPercent', cleared: false },
  ];
  const list = (items) => ({ total: items.length, items });
  const FIXTURES = {
    '/device/devices': () => list([DEVICE]),
    '/device/devices/1': () => DEVICE,
    '/alert/alerts': () => list(ALERTS),
    '/device/groups': () => list([{ id: 7, name: 'Web servers', fullPath: 'Web servers' }]),
    '/sdt/sdts': () => list([{ id: 'S1', type: 'ResourceSDT', deviceDisplayName: 'db01', isEffective: true }]),
    '/device/devices/1/devicedatasources/2/instances/3/data': () => ({ dataPoints: ['CPUBusyPercent'], values: [[12.5]], time: [1700000000000] }),
  };

  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  function authorised(req, resource) {
    const h = req.headers.authorization || '';
    if (h === `Bearer ${state.goodToken}`) return true;
    const m = /^LMv1 ([^:]+):([^:]+):(\d+)$/.exec(h);
    if (!m || m[1] !== state.accessId) return false;
    const epoch = Number(m[3]);
    if (Math.abs(Date.now() - epoch) > 30 * 60 * 1000) return false;
    const hex = crypto.createHmac('sha256', state.accessKey).update(`${req.method}${epoch}${resource}`).digest('hex');
    return m[2] === Buffer.from(hex).toString('base64');
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    state.seen.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...req.headers } });
    if (!u.pathname.startsWith(`${REST}/`)) return send(res, 404, { errorMessage: 'not found', errorCode: 1404 });
    const resource = u.pathname.slice(REST.length);
    if (req.headers['x-version'] !== '3') return send(res, 400, { errorMessage: 'X-Version 3 required', errorCode: 1400 });
    if (!authorised(req, resource)) return send(res, 401, { errorMessage: 'Authentication failed', errorCode: 1401 });
    if (state.mode === '403') return send(res, 403, { errorMessage: 'Permission denied', errorCode: 1403 });
    if (state.mode === '429') return send(res, 429, { errorMessage: 'Too many requests', errorCode: 1429 });
    if (state.mode === '500') return send(res, 500, { errorMessage: 'Internal error', errorCode: 1500 });
    if (state.mode === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); return res.end(); }
    if (state.mode === 'html') return send(res, 200, '<html><body>Sign in to the proxy</body></html>', 'text/html');
    if (state.mode === 'big' && resource === '/device/devices') {
      return send(res, 200, list(Array.from({ length: 1500 }, (_, i) => ({ ...DEVICE, id: i + 1, description: 'x'.repeat(100) }))));
    }
    const f = req.method === 'GET' && Object.hasOwn(FIXTURES, resource) ? FIXTURES[resource] : null;
    if (!f) return send(res, 404, { errorMessage: 'not found', errorCode: 1404 });
    return send(res, 200, f());
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => {
      ok({
        origin: `http://${host}:${server.address().port}`,
        state,
        setMode: (m) => { state.mode = m; },
        stop: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

module.exports = { startFakeLm };

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  startFakeLm({ port: i > 0 ? Number(process.argv[i + 1]) : 5599, host: process.env.FAKE_HOST || '127.0.0.1' })
    .then((f) => console.log(`fake LogicMonitor listening on ${f.origin}`));
}
