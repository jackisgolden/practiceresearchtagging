import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intakeMay, intakeTransitions, STATES, INITIAL } from '../src/states.mjs';

test('intake edges come from the contract file', () => {
  assert.equal(INITIAL, 'QUEUED');
  assert.ok(intakeTransitions.length >= 3);
  for (const t of intakeTransitions) { assert.ok(t.from === null || STATES.includes(t.from)); assert.ok(STATES.includes(t.to)); }
});
test('the transitions app.mjs performs are all intake-owned', () => {
  assert.equal(intakeMay(null, 'QUEUED'), true);
  assert.equal(intakeMay('FAILED', 'QUEUED'), true);
  assert.equal(intakeMay('UNPROCESSABLE', 'QUEUED'), true);
  assert.equal(intakeMay('QUEUED', 'PROCESSING'), false);
  assert.equal(intakeMay('CLEAN', 'QUEUED'), false);
});
