import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSweeper } from '../src/sweeper.mjs';
import { makeApp, signed, parse } from './helpers.mjs';

const obj = (key, etag = 'd41d8cd98f00b204e9800998ecf8427e') => ({ bucket: 'abc', key, etag, size: 10, lastModified: '2026-08-25T01:00:00Z' });

test('inventory 3 objects, 1 already registered, 1 ignored prefix -> 1 found', async () => {
  const app = makeApp();
  await app.handle(signed('POST', '/registrations', { gaFileId: 'g', bucket: 'abc', key: 'a.csv', etag: 'd41d8cd98f00b204e9800998ecf8427e', size: 10, uploader: 'u', uploadedAt: '2026-08-25T00:00:00Z' }));
  const sweeper = createSweeper({ inventory: { latest: async () => [obj('a.csv'), obj('b.csv'), obj('tmp/c.csv')] }, ledger: app.ledger, audit: app.sink && (await import('../src/audit.mjs')).createAudit({ sink: app.sink, env: 'test', log: { error() {} }, metrics: { count() {} } }), log: { info() {}, error() {} }, metrics: { count: (n) => app.metricsLog.push([n]) }, ignorePrefixes: ['tmp/'] });
  const r = await sweeper.runOnce();
  assert.deepEqual(r, { seen: 2, found: 1 });
  assert.equal(app.ledger._rows.size, 2);
  const found = app.sink.lines.filter((l) => l.event === 'SWEEP_FOUND');
  assert.equal(found.length, 1); assert.equal(found[0].uploader, 'sweeper');
  assert.ok(app.metricsLog.some(([n]) => n === 'intake_sweeper_found'));
  const row = await app.ledger.getByIdemKey('abc|b.csv|d41d8cd98f00b204e9800998ecf8427e');
  assert.equal(row.status, 'QUEUED'); assert.equal(row.uploader, 'sweeper');
});
