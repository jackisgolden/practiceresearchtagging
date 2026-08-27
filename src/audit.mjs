// Append-only JSONL audit. S3 has no append, so one object per line at AUDIT_PREFIX/YYYY/MM/DD/<ulid>.jsonl.
// Written AFTER ledger success, BEFORE HTTP response. Failure never blocks the response.
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { validateAudit } from './validate.mjs';
import { ulid } from './ids.mjs';

export function createAudit({ sink, env, log, metrics }) {
  return {
    async write(fields) {
      const line = { ts: new Date().toISOString(), svc: 'ess-ufm-file-intake-service', env, ...fields };
      const v = validateAudit(line);
      if (!v.ok) { log.error({ msg: 'audit line invalid', errors: v.errors }); metrics.count('audit_write_failed'); return false; }
      try {
        await sink.put(line);
        return true;
      } catch (e) {
        log.error({ msg: 'audit write failed', err: e.message });
        metrics.count('audit_write_failed');
        return false;
      }
    },
  };
}

export function createS3AuditSink({ region, bucket, prefix, client }) {
  const s3 = client || new S3Client({ region });
  return {
    async put(line) {
      const d = line.ts.slice(0, 10).replaceAll('-', '/');
      const key = `${prefix}${d}/${ulid()}.jsonl`;
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(line) + '\n', ContentType: 'application/x-ndjson' }));
    },
  };
}

export function createMemoryAuditSink() {
  const lines = [];
  return { lines, failNext: null, async put(line) { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } lines.push(line); } };
}
