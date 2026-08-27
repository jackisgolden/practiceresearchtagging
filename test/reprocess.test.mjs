import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, signed, parse, fixture } from './helpers.mjs';
const ev = fixture('valid/basic.synthetic.json');

async function seeded(status, extra = {}) {
  const app = makeApp();
  const a = parse(await app.handle(signed('POST', '/registrations', ev)));
  const row = await app.ledger.getById(a.json.id);
  Object.assign(row, { status, ...extra });
  return { ...app, id: a.json.id };
}

test('FAILED -> QUEUED: attempt 2, ttl/lastError removed, params merged', async () => {
  const { handle, ledger, sink, id } = await seeded('FAILED', { ttl: 123, lastError: 'boom' });
  const res = parse(await handle(signed('POST', `/registrations/${id}/reprocess`, { params: { priority: 'high', segment: 50 } })));
  assert.equal(res.status, 200); assert.deepEqual(res.json, { id, status: 'QUEUED', attempt: 2 });
  const row = await ledger.getById(id);
  assert.equal(row.status, 'QUEUED'); assert.equal(row.attempt, 2);
  assert.ok(!('ttl' in row)); assert.ok(!('lastError' in row));
  assert.deepEqual(row.params, { priority: 'high', segment: 50 });
  assert.equal(sink.lines.at(-1).event, 'REPROCESS'); assert.equal(sink.lines.at(-1).outcome, 'OK');
});
test('UNPROCESSABLE -> QUEUED allowed', async () => {
  const { handle, id } = await seeded('UNPROCESSABLE');
  assert.equal((await handle(signed('POST', `/registrations/${id}/reprocess`, {}))).status, 200);
});
for (const s of ['QUEUED', 'PROCESSING', 'CLEAN', 'FLAGGED']) {
  test(`${s} -> QUEUED is 409 invalid_transition`, async () => {
    const { handle, sink, id } = await seeded(s);
    const res = parse(await handle(signed('POST', `/registrations/${id}/reprocess`, {})));
    assert.equal(res.status, 409); assert.equal(res.json.error, 'invalid_transition'); assert.equal(res.json.from, s);
    assert.equal(sink.lines.at(-1).outcome, 'CONFLICT');
  });
}
test('stale: status moved between read and write -> 409 stale', async () => {
  const { handle, ledger, id } = await seeded('FAILED');
  const realGet = ledger.getById.bind(ledger);
  ledger.getById = async (i) => { const r = await realGet(i); const snap = { ...r }; r.status = 'PROCESSING'; return snap; };
  const res = parse(await handle(signed('POST', `/registrations/${id}/reprocess`, {})));
  assert.equal(res.status, 409); assert.equal(res.json.error, 'stale');
});
test('unknown id 404; bad body 400', async () => {
  const { handle } = makeApp();
  assert.equal((await handle(signed('POST', '/registrations/nope/reprocess', {}))).status, 404);
  const { handle: h2, id } = await seeded('FAILED');
  assert.equal((await h2(signed('POST', `/registrations/${id}/reprocess`, { status: 'CLEAN' }))).status, 400);
});
