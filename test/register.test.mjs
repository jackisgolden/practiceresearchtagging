import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signed, parse, fixture } from './helpers.mjs';
import { validateAudit, validateRegistration } from '../src/validate.mjs';
const ev = fixture('valid/basic.synthetic.json');

test('happy path: 202, row QUEUED attempt 1, audit REGISTER/OK', async () => {
  const { handle, ledger, sink } = makeApp();
  const res = parse(await handle(signed('POST', '/registrations', ev)));
  assert.equal(res.status, 202); assert.equal(res.json.status, 'QUEUED'); assert.ok(res.headers['x-request-id']);
  const row = await ledger.getById(res.json.id);
  assert.equal(row.status, 'QUEUED'); assert.equal(row.attempt, 1); assert.equal(row.idemKey, `${ev.bucket}|${ev.key}|${ev.etag}`);
  assert.deepEqual(validateRegistration(row), { ok: true });
  assert.equal(sink.lines.length, 1); assert.equal(sink.lines[0].event, 'REGISTER'); assert.equal(sink.lines[0].outcome, 'OK');
  assert.deepEqual(validateAudit(sink.lines[0]), { ok: true });
});
test('duplicate: 200 duplicate:true, same id, no second row', async () => {
  const { handle, ledger, sink } = makeApp();
  const a = parse(await handle(signed('POST', '/registrations', ev)));
  const b = parse(await handle(signed('POST', '/registrations', ev)));
  assert.equal(b.status, 200); assert.equal(b.json.duplicate, true); assert.equal(b.json.id, a.json.id);
  assert.equal(ledger._rows.size, 1); assert.equal(sink.lines[1].event, 'DUPLICATE');
});
test('ledger failure: 503, no REGISTER/OK audit', async () => {
  const { handle, ledger, sink } = makeApp();
  ledger.failNext = new Error('dynamo down');
  const res = parse(await handle(signed('POST', '/registrations', ev)));
  assert.equal(res.status, 503); assert.equal(ledger._rows.size, 0);
  assert.ok(!sink.lines.some((l) => l.event === 'REGISTER' && l.outcome === 'OK'));
  assert.ok(sink.lines.some((l) => l.event === 'REGISTER' && l.outcome === 'ERROR'));
});
test('unsigned: 401 + REJECT/DENIED', async () => {
  const { handle, sink } = makeApp();
  const res = parse(await handle({ method: 'POST', path: '/registrations', headers: {}, rawBody: Buffer.from(JSON.stringify(ev)) }));
  assert.equal(res.status, 401); assert.equal(sink.lines[0].outcome, 'DENIED');
});
test('invalid json: 400', async () => {
  const { handle } = makeApp();
  assert.equal((await handle(signed('POST', '/registrations', '{not json'))).status, 400);
});
test('schema failure: 400 with all errors', async () => {
  const { handle } = makeApp();
  const res = parse(await handle(signed('POST', '/registrations', { ...ev, etag: 'x', size: -1 })));
  assert.equal(res.status, 400); assert.equal(res.json.errors.length, 2);
});
test('audit sink failure does not block 202', async () => {
  const { handle, sink } = makeApp();
  sink.failNext = new Error('s3 down');
  assert.equal((await handle(signed('POST', '/registrations', ev))).status, 202);
});
test('GET /registrations/{id} returns row; unknown 404', async () => {
  const { handle } = makeApp();
  const a = parse(await handle(signed('POST', '/registrations', ev)));
  const g = parse(await handle(signed('GET', `/registrations/${a.json.id}`)));
  assert.equal(g.status, 200); assert.equal(g.json.id, a.json.id);
  assert.equal((await handle(signed('GET', '/registrations/nope'))).status, 404);
});
