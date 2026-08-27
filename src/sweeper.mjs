// Daily S3 Inventory diff vs ledger. Registers unregistered objects; SWEEP_FOUND > 0 is an alarm for ops.
// inventory provides async latest() -> [{bucket,key,etag,size,lastModified}]. S3 impl below.
import { buildRow, idemKeyOf } from './app.mjs';
import { ulid } from './ids.mjs';

export function createSweeper({ inventory, ledger, audit, log, metrics, ignorePrefixes = [], now = () => new Date() }) {
  async function runOnce() {
    const reqId = ulid();
    const objects = await inventory.latest();
    let found = 0, seen = 0;
    for (const o of objects) {
      if (ignorePrefixes.some((p) => o.key.startsWith(p))) continue;
      seen++;
      const ev = { gaFileId: `sweeper:${o.lastModified}`, bucket: o.bucket, key: o.key, etag: o.etag, size: o.size, uploader: 'sweeper', uploadedAt: o.lastModified };
      if (await ledger.getByIdemKey(idemKeyOf(ev))) continue;
      const row = buildRow(ev, now().toISOString());
      const r = await ledger.register(row);
      if (!r.created) continue; // raced with a live registration; fine
      found++;
      metrics.count('intake_sweeper_found');
      await audit.write({ event: 'SWEEP_FOUND', outcome: 'OK', reqId, regId: row.id, idemKey: row.idemKey, uploader: 'sweeper' });
    }
    log.info({ reqId, msg: 'sweep complete', seen, found });
    return { seen, found };
  }
  let timer = null;
  return {
    runOnce,
    start(intervalMs = 24 * 60 * 60 * 1000) {
      const tick = () => runOnce().catch((e) => { log.error({ msg: 'sweep failed', err: e.message }); metrics.count('intake_sweeper_error'); });
      timer = setInterval(tick, intervalMs); timer.unref?.();
      tick();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

// S3 Inventory (CSV, gzip) reader. Expects the columns Bucket, Key, Size, LastModifiedDate, ETag as configured on the inventory.
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { gunzipSync } from 'node:zlib';

export function createS3Inventory({ region, bucket, prefix, client }) {
  const s3 = client || new S3Client({ region });
  const text = async (Key, gz = false) => {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
    const buf = Buffer.from(await r.Body.transformToByteArray());
    return (gz ? gunzipSync(buf) : buf).toString('utf8');
  };
  return {
    async latest() {
      const l = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const manifests = (l.Contents || []).filter((c) => c.Key.endsWith('/manifest.json')).sort((a, b) => b.LastModified - a.LastModified);
      if (!manifests.length) throw new Error(`sweeper: no manifest.json under s3://${bucket}/${prefix}`);
      const manifest = JSON.parse(await text(manifests[0].Key));
      const cols = manifest.fileSchema.split(',').map((s) => s.trim());
      const idx = (n) => { const i = cols.indexOf(n); if (i < 0) throw new Error(`sweeper: inventory schema missing ${n}`); return i; };
      const [iB, iK, iS, iM, iE] = ['Bucket', 'Key', 'Size', 'LastModifiedDate', 'ETag'].map(idx);
      const out = [];
      for (const f of manifest.files) {
        const csv = await text(f.key, true);
        for (const line of csv.split('\n')) {
          if (!line.trim()) continue;
          const c = line.split(',').map((s) => s.replace(/^"|"$/g, ''));
          out.push({ bucket: c[iB], key: decodeURIComponent(c[iK]), size: Number(c[iS]), lastModified: c[iM], etag: c[iE] });
        }
      }
      return out;
    },
  };
}
