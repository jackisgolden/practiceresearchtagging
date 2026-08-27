import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/server.mjs';
import { makeApp, signed } from './helpers.mjs';
import { nullLog } from '../src/observability.mjs';

async function withServer(fn, over) {
  const app = makeApp(over);
  const server = createHttpServer(app.handle, { maxBodyBytes: 64 * 1024, log: nullLog });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, app); } finally { await new Promise((r) => server.close(r)); }
}
test('/healthz 200 without auth', () => withServer(async (b) => assert.equal((await fetch(`${b}/healthz`)).status, 200)));
test('/readyz 503 when ledger rejects', () => withServer(async (b, app) => {
  app.ledger.failNext = new Error('down');
  assert.equal((await fetch(`${b}/readyz`)).status, 503);
  assert.equal((await fetch(`${b}/readyz`)).status, 200);
}));
test('unknown route 404, wrong method 405', () => withServer(async (b) => {
  assert.equal((await fetch(`${b}/nope`)).status, 404);
  assert.equal((await fetch(`${b}/healthz`, { method: 'POST' })).status, 405);
}));
test('body > 64KB -> 413', () => withServer(async (b) => {
  const r = await fetch(`${b}/registrations`, { method: 'POST', body: 'x'.repeat(70 * 1024) });
  assert.equal(r.status, 413);
}));
test('signed request over real HTTP -> 202', () => withServer(async (b) => {
  const req = signed('POST', '/registrations', { gaFileId: 'g', bucket: 'abc', key: 'k', etag: 'd41d8cd98f00b204e9800998ecf8427e', size: 1, uploader: 'u', uploadedAt: '2026-08-25T00:00:00Z' });
  const r = await fetch(`${b}/registrations`, { method: 'POST', headers: { ...req.headers, 'content-type': 'application/json' }, body: req.rawBody });
  assert.equal(r.status, 202); assert.ok(r.headers.get('x-request-id'));
}));
test('server closes cleanly on close()', () => withServer(async () => {}));
