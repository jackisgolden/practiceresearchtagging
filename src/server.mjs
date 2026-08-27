// Wires real clients and listens. Everything testable lives in app.mjs.
import http from 'node:http';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createDynamoLedger } from './ledger.mjs';
import { createAudit, createS3AuditSink } from './audit.mjs';
import { createLog, createMetrics } from './observability.mjs';
import { createSweeper, createS3Inventory } from './sweeper.mjs';

async function loadSecrets(cfg) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: cfg.region });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: cfg.hmacSecretArn }));
  let v; try { v = JSON.parse(r.SecretString); } catch { v = { current: r.SecretString }; }
  if (!v.current) throw new Error('secrets: HMAC secret must be a string or {"current":..., "previous":...}');
  return v;
}

export function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    let over = false;
    req.on('data', (c) => { if (over) return; n += c.length; if (n > max) { over = true; chunks.length = 0; reject(Object.assign(new Error('too large'), { code: 413 })); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHttpServer(handle, { maxBodyBytes, log }) {
  return http.createServer(async (req, res) => {
    let rawBody;
    try { rawBody = await readBody(req, maxBodyBytes); }
    catch (e) { req.resume(); res.writeHead(e.code === 413 ? 413 : 400, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: e.code === 413 ? 'payload_too_large' : 'bad_request' })); return; }
    const path = new URL(req.url, 'http://x').pathname;
    try {
      const out = await handle({ method: req.method, path, headers: req.headers, rawBody });
      res.writeHead(out.status, out.headers); res.end(out.body);
    } catch (e) {
      log.error({ msg: 'unhandled in handler', err: e.message, stack: e.stack });
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'internal' }));
    }
  });
}

async function main() {
  const config = loadConfig();
  const log = createLog({ level: config.logLevel });
  const metrics = createMetrics({ env: config.environment });
  const secrets = await loadSecrets(config);
  const ledger = createDynamoLedger({ region: config.region, table: config.ledgerTable });
  const audit = createAudit({ sink: createS3AuditSink({ region: config.region, bucket: config.auditBucket, prefix: config.auditPrefix }), env: config.environment, log, metrics });
  const handle = createApp({ config, secrets, ledger, audit, log, metrics });
  const server = createHttpServer(handle, { maxBodyBytes: config.maxBodyBytes, log });

  let sweeper = null;
  if (config.sweeperEnabled) {
    sweeper = createSweeper({ inventory: createS3Inventory({ region: config.region, bucket: config.sweeperInventoryBucket, prefix: config.sweeperInventoryPrefix }), ledger, audit, log, metrics, ignorePrefixes: config.sweeperIgnorePrefixes });
    sweeper.start();
  }

  server.listen(config.port, '0.0.0.0', () => log.info({ msg: 'listening', port: config.port, env: config.environment, sweeper: config.sweeperEnabled }));

  const shutdown = (sig) => {
    log.info({ msg: 'shutdown', sig });
    sweeper?.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => { log.error({ msg: 'unhandledRejection', err: String(e?.message || e) }); process.exit(1); });
  process.on('uncaughtException', (e) => { log.error({ msg: 'uncaughtException', err: e.message }); process.exit(1); });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { process.stderr.write(`fatal: ${e.message}\n`); process.exit(1); });
}
