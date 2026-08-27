// Reads env once. A missing required var throws naming it. No silent defaults for required vars.
const REQUIRED = ['ENVIRONMENT', 'AWS_REGION', 'LEDGER_TABLE', 'AUDIT_BUCKET', 'AUDIT_PREFIX', 'HMAC_SECRET_ARN'];
const ENVS = new Set(['sbx', 'test', 'impl', 'prod']);

export function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((k) => !env[k] || env[k].trim() === '');
  if (missing.length) throw new Error(`config: required env not set: ${missing.join(', ')}`);
  if (!ENVS.has(env.ENVIRONMENT)) throw new Error(`config: ENVIRONMENT must be one of ${[...ENVS].join('|')}, got "${env.ENVIRONMENT}"`);

  const int = (k, d) => {
    if (env[k] === undefined || env[k] === '') return d;
    const n = Number(env[k]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${k} must be a non-negative integer, got "${env[k]}"`);
    return n;
  };
  const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : env[k] === 'true');

  const cfg = {
    environment: env.ENVIRONMENT,
    region: env.AWS_REGION,
    ledgerTable: env.LEDGER_TABLE,
    auditBucket: env.AUDIT_BUCKET,
    auditPrefix: env.AUDIT_PREFIX,
    hmacSecretArn: env.HMAC_SECRET_ARN,
    replayWindowSec: int('REPLAY_WINDOW_SEC', 300),
    port: int('PORT', 8080),
    logLevel: env.LOG_LEVEL || 'info',
    sweeperEnabled: bool('SWEEPER_ENABLED', false),
    sweeperInventoryBucket: env.SWEEPER_INVENTORY_BUCKET || null,
    sweeperInventoryPrefix: env.SWEEPER_INVENTORY_PREFIX || null,
    sweeperIgnorePrefixes: (env.SWEEPER_IGNORE_PREFIXES || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxBodyBytes: 64 * 1024,
  };
  if (cfg.sweeperEnabled && (!cfg.sweeperInventoryBucket || !cfg.sweeperInventoryPrefix)) {
    throw new Error('config: SWEEPER_ENABLED=true requires SWEEPER_INVENTORY_BUCKET and SWEEPER_INVENTORY_PREFIX');
  }
  return Object.freeze(cfg);
}
