// Pure request handler. All I/O arrives via deps { config, secrets, ledger, audit, log, metrics, now }.
import { ulid } from './ids.mjs';
import { verify } from './hmac.mjs';
import { validateIntakeEvent, validateReprocessBody } from './validate.mjs';
import { intakeMay, INITIAL } from './states.mjs';

const TTL_DAYS = 90;
const json = (status, body, reqId) => ({ status, headers: { 'content-type': 'application/json', 'x-request-id': reqId }, body: JSON.stringify(body) });
export const idemKeyOf = (e) => `${e.bucket}|${e.key}|${e.etag}`;

export function buildRow(ev, nowIso, id = ulid()) {
  const row = {
    id, idemKey: idemKeyOf(ev), status: INITIAL, attempt: 1,
    gaFileId: ev.gaFileId, bucket: ev.bucket, key: ev.key, etag: ev.etag, size: ev.size,
    uploader: ev.uploader, uploadedAt: ev.uploadedAt, registeredAt: nowIso, updatedAt: nowIso,
  };
  if (ev.versionId !== undefined) row.versionId = ev.versionId;
  if (ev.params !== undefined) row.params = ev.params;
  return row;
}

export function createApp(deps) {
  const { config, secrets, ledger, audit, log, metrics, now = () => new Date() } = deps;

  // req has method, path, lowercased headers, and rawBody (Buffer or string).
  return async function handle(req) {
    const reqId = ulid();
    const t0 = Date.now();
    const res = await route(req, reqId);
    metrics.ms('intake_latency_ms', Date.now() - t0, { route: req.method + ' ' + routeName(req.path) });
    return res;
  };

  function routeName(p) {
    if (p === '/registrations') return '/registrations';
    if (/^\/registrations\/[^/]+\/reprocess$/.test(p)) return '/registrations/{id}/reprocess';
    if (/^\/registrations\/[^/]+$/.test(p)) return '/registrations/{id}';
    return 'unmatched';
  }

  async function route(req, reqId) {
    const { method, path } = req;
    if (path === '/healthz') return method === 'GET' ? json(200, { ok: true }, reqId) : json(405, { error: 'method_not_allowed' }, reqId);
    if (path === '/readyz') {
      if (method !== 'GET') return json(405, { error: 'method_not_allowed' }, reqId);
      try { await ledger.ready(); return json(200, { ok: true }, reqId); }
      catch (e) { log.warn({ reqId, msg: 'readyz failed', err: e.message }); return json(503, { ok: false, reason: 'ledger' }, reqId); }
    }
    if (path === '/registrations') return method === 'POST' ? register(req, reqId) : json(405, { error: 'method_not_allowed' }, reqId);
    let m = path.match(/^\/registrations\/([^/]+)\/reprocess$/);
    if (m) return method === 'POST' ? reprocess(req, reqId, m[1]) : json(405, { error: 'method_not_allowed' }, reqId);
    m = path.match(/^\/registrations\/([^/]+)$/);
    if (m) return method === 'GET' ? get(req, reqId, m[1]) : json(405, { error: 'method_not_allowed' }, reqId);
    return json(404, { error: 'not_found' }, reqId);
  }

  // Returns a response on failure, or null when authenticated.
  async function gate(req, reqId) {
    if (Buffer.byteLength(req.rawBody) > config.maxBodyBytes) return json(413, { error: 'payload_too_large' }, reqId);
    const ok = verify({ secrets, headers: req.headers, rawBody: req.rawBody, windowSec: config.replayWindowSec, now: Math.floor(now().getTime() / 1000) });
    if (!ok) {
      metrics.count('intake_rejected', { reason: 'unauthorized' });
      await audit.write({ event: 'REJECT', outcome: 'DENIED', reqId });
      return json(401, { error: 'unauthorized' }, reqId);
    }
    return null;
  }

  function parse(req, reqId, event) {
    try { return { body: JSON.parse(req.rawBody.toString()) }; }
    catch {
      metrics.count('intake_rejected', { reason: 'invalid_json' });
      return { res: json(400, { error: 'invalid_json' }, reqId), auditFields: { event, outcome: 'INVALID', reqId, detail: 'invalid_json' } };
    }
  }

  async function register(req, reqId) {
    metrics.count('intake_received');
    const denied = await gate(req, reqId); if (denied) return denied;
    const p = parse(req, reqId, 'REJECT');
    if (p.res) { await audit.write(p.auditFields); return p.res; }
    const v = validateIntakeEvent(p.body);
    if (!v.ok) {
      metrics.count('intake_rejected', { reason: 'invalid' });
      await audit.write({ event: 'REJECT', outcome: 'INVALID', reqId, detail: v.errors.join('; ').slice(0, 512) });
      return json(400, { error: 'invalid', errors: v.errors }, reqId);
    }
    const ev = p.body;
    const row = buildRow(ev, now().toISOString());
    let r;
    try { r = await ledger.register(row); }
    catch (e) {
      log.error({ reqId, msg: 'ledger register failed', err: e.message });
      metrics.count('intake_ledger_error');
      await audit.write({ event: 'REGISTER', outcome: 'ERROR', reqId, idemKey: row.idemKey, uploader: ev.uploader, detail: e.message.slice(0, 512) });
      return json(503, { error: 'ledger_unavailable' }, reqId);
    }
    if (r.created) {
      metrics.count('intake_registered');
      await audit.write({ event: 'REGISTER', outcome: 'OK', reqId, regId: row.id, idemKey: row.idemKey, uploader: ev.uploader });
      return json(202, { id: row.id, status: row.status }, reqId);
    }
    metrics.count('intake_duplicate');
    await audit.write({ event: 'DUPLICATE', outcome: 'OK', reqId, regId: r.row.id, idemKey: row.idemKey, uploader: ev.uploader });
    return json(200, { id: r.row.id, status: r.row.status, duplicate: true }, reqId);
  }

  async function reprocess(req, reqId, id) {
    const denied = await gate(req, reqId); if (denied) return denied;
    const p = parse(req, reqId, 'REPROCESS');
    if (p.res) { await audit.write(p.auditFields); return p.res; }
    const v = validateReprocessBody(p.body);
    if (!v.ok) { await audit.write({ event: 'REPROCESS', outcome: 'INVALID', reqId, regId: id, detail: v.errors.join('; ').slice(0, 512) }); return json(400, { error: 'invalid', errors: v.errors }, reqId); }
    let cur;
    try { cur = await ledger.getById(id); }
    catch (e) { log.error({ reqId, msg: 'ledger read failed', err: e.message }); metrics.count('intake_ledger_error'); return json(503, { error: 'ledger_unavailable' }, reqId); }
    if (!cur) return json(404, { error: 'not_found' }, reqId);
    if (!intakeMay(cur.status, INITIAL)) {
      await audit.write({ event: 'REPROCESS', outcome: 'CONFLICT', reqId, regId: id, idemKey: cur.idemKey, detail: `invalid_transition from ${cur.status}` });
      return json(409, { error: 'invalid_transition', from: cur.status }, reqId);
    }
    const patch = { status: INITIAL, attempt: cur.attempt + 1, updatedAt: now().toISOString(), ttl: undefined, lastError: undefined };
    if (p.body.params || cur.params) patch.params = { ...(cur.params || {}), ...(p.body.params || {}) };
    let next;
    try { next = await ledger.transition(cur, patch, cur.status); }
    catch (e) { log.error({ reqId, msg: 'ledger transition failed', err: e.message }); metrics.count('intake_ledger_error'); return json(503, { error: 'ledger_unavailable' }, reqId); }
    if (!next) {
      await audit.write({ event: 'REPROCESS', outcome: 'CONFLICT', reqId, regId: id, idemKey: cur.idemKey, detail: 'stale' });
      return json(409, { error: 'stale' }, reqId);
    }
    metrics.count('intake_reprocessed');
    await audit.write({ event: 'REPROCESS', outcome: 'OK', reqId, regId: id, idemKey: cur.idemKey, uploader: cur.uploader });
    return json(200, { id, status: next.status, attempt: next.attempt }, reqId);
  }

  async function get(req, reqId, id) {
    const denied = await gate(req, reqId); if (denied) return denied;
    let row;
    try { row = await ledger.getById(id); }
    catch (e) { log.error({ reqId, msg: 'ledger read failed', err: e.message }); return json(503, { error: 'ledger_unavailable' }, reqId); }
    return row ? json(200, row, reqId) : json(404, { error: 'not_found' }, reqId);
  }
}

export { TTL_DAYS };
