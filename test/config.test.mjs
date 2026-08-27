import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
const base = { ENVIRONMENT: 'sbx', AWS_REGION: 'us-gov-west-1', LEDGER_TABLE: 't', AUDIT_BUCKET: 'b', AUDIT_PREFIX: 'p/', HMAC_SECRET_ARN: 'arn' };

test('missing required var throws and names it', () => {
  const { LEDGER_TABLE, ...env } = base;
  assert.throws(() => loadConfig(env), /LEDGER_TABLE/);
});
test('bad ENVIRONMENT throws', () => assert.throws(() => loadConfig({ ...base, ENVIRONMENT: 'staging' }), /ENVIRONMENT/));
test('defaults applied', () => {
  const c = loadConfig(base);
  assert.equal(c.replayWindowSec, 300); assert.equal(c.port, 8080); assert.equal(c.sweeperEnabled, false); assert.equal(c.logLevel, 'info');
});
test('sweeper enabled requires inventory vars', () => assert.throws(() => loadConfig({ ...base, SWEEPER_ENABLED: 'true' }), /SWEEPER_INVENTORY/));
test('non-integer numeric throws', () => assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT/));
