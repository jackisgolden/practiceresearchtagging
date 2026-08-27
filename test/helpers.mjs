import { createApp } from '../src/app.mjs';
import { createMemoryLedger } from '../src/ledger.mjs';
import { createAudit, createMemoryAuditSink } from '../src/audit.mjs';
import { nullLog, nullMetrics } from '../src/observability.mjs';
import { sign } from '../src/hmac.mjs';
import { readFileSync } from 'node:fs';

export const SECRET = 'test-secret';
export const config = { maxBodyBytes: 64 * 1024, replayWindowSec: 300 };
export const fixture = (p) => JSON.parse(readFileSync(new URL(`./fixtures/${p}`, import.meta.url), 'utf8'));

export function makeApp(over = {}) {
  const ledger = createMemoryLedger();
  const sink = createMemoryAuditSink();
  const metricsLog = [];
  const metrics = { count: (n, d) => metricsLog.push([n, d]), ms: () => {} };
  const audit = createAudit({ sink, env: 'test', log: nullLog, metrics });
  const handle = createApp({ config, secrets: { current: SECRET, previous: 'old-secret' }, ledger, audit, log: nullLog, metrics, ...over });
  return { handle, ledger, sink, metricsLog };
}

export function signed(method, path, body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const rawBody = Buffer.from(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  return { method, path, rawBody, headers: { 'x-ufm-timestamp': String(ts), 'x-ufm-signature': sign(secret, String(ts), rawBody) } };
}
export const parse = (res) => ({ ...res, json: JSON.parse(res.body) });
