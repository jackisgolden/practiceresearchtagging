import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { validateIntakeEvent, validateReprocessBody } from '../src/validate.mjs';
import { fixture } from './helpers.mjs';

for (const f of readdirSync(new URL('./fixtures/valid', import.meta.url))) {
  test(`valid fixture ${f}`, () => assert.deepEqual(validateIntakeEvent(fixture(`valid/${f}`)), { ok: true }));
}
for (const f of readdirSync(new URL('./fixtures/invalid', import.meta.url))) {
  test(`invalid fixture ${f}`, () => {
    const { _expect, ...body } = fixture(`invalid/${f}`);
    const r = validateIntakeEvent(body);
    assert.equal(r.ok, false);
    for (const e of _expect) assert.ok(r.errors.includes(e), `expected error "${e}" in ${JSON.stringify(r.errors)}`);
  });
}
test('non-object rejected', () => assert.equal(validateIntakeEvent([]).ok, false));
test('reprocess body: only params allowed', () => {
  assert.deepEqual(validateReprocessBody({}), { ok: true });
  assert.deepEqual(validateReprocessBody({ params: { a: 1 } }), { ok: true });
  assert.equal(validateReprocessBody({ params: 1 }).ok, false);
  assert.equal(validateReprocessBody({ status: 'QUEUED' }).ok, false);
});
