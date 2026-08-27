# ess-ufm-file-intake-service Implementation Handoff

Written for the model or engineer building the service. Build exactly what is written here. Where this document is silent, choose the simplest option and leave a `// DECISION:` comment.
Owned by Jack Golden (Cadmus / CMS ESS UFM). Version 1.0, 2026-08-25.

---

## 0. One-paragraph summary

A continuously running internal Node.js HTTP service on ECS Fargate. GoAnywhere (GA) calls it after a client file has landed in the client's S3 bucket and passed antivirus. The service validates the call, assigns a unique registration id, writes one row to DynamoDB with status `QUEUED`, appends one audit line, and returns `202`. A separate scheduled Lambda (not in this repo) reads `QUEUED` rows and scans them. This service owns **only** the registration ledger and its two transitions (`→ QUEUED`, `FAILED|UNPROCESSABLE → QUEUED`). It never reads file contents, never calls Comprehend, never tags S3 objects.

---

## 1. Non-goals (do not build)

- Virus scanning (already done before the call reaches us)
- Reading, downloading, segmenting, or tagging S3 objects
- Any Comprehend / Comprehend Medical / Step Functions call
- A public endpoint, UI, or auth beyond HMAC
- Retry loops toward GA (GA is the caller; we only answer)

---

## 2. Repo layout

```
ess-ufm-file-intake-service/
  package.json
  src/
    server.mjs          # http listener, routing, graceful shutdown
    config.mjs          # env parsing, fail-loud
    hmac.mjs            # signature verify + replay window
    validate.mjs        # JSON-schema validation (hand-written checks, see §5)
    ledger.mjs          # DynamoDB read/write, conditional transitions
    audit.mjs           # append-only JSONL audit line to S3
    sweeper.mjs         # daily S3 Inventory diff (see §10)
    ids.mjs             # ULID generation
  contracts/
    intake-event.schema.json
    registration.schema.json
    registration-states.json
    audit.schema.json
  test/
    fixtures/           # captured GA payloads, one JSON per case
    *.test.mjs          # node:test suites (see §11)
  Dockerfile
  task-def.json         # ECS task definition template (env at this layer)
  README.md
```

Allowed runtime dependencies are `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`. Nothing else. HTTP server is `node:http`. HMAC is `node:crypto`. Tests are `node:test`. Node 20 LTS.

---

## 3. Configuration (task-definition layer, fail-loud)

Every variable is read once at boot in `config.mjs`. A missing required variable **must** crash the process at startup with a message naming the variable. Do not default silently.

| Variable | Required | Meaning |
|---|---|---|
| `ENVIRONMENT` | yes | `sbx` \| `test` \| `impl` \| `prod` |
| `AWS_REGION` | yes | e.g. `us-gov-west-1` |
| `LEDGER_TABLE` | yes | DynamoDB table name |
| `AUDIT_BUCKET` | yes | S3 bucket for audit JSONL |
| `AUDIT_PREFIX` | yes | e.g. `intake/audit/` |
| `HMAC_SECRET_ARN` | yes | Secrets Manager ARN; resolved at boot |
| `REPLAY_WINDOW_SEC` | no | default `300` |
| `PORT` | no | default `8080` |
| `LOG_LEVEL` | no | default `info` |
| `SWEEPER_ENABLED` | no | default `false` |
| `SWEEPER_INVENTORY_BUCKET` | if sweeper | S3 Inventory destination bucket |
| `SWEEPER_INVENTORY_PREFIX` | if sweeper | prefix of inventory manifests |

Identical container image in every environment; only these values vary.

---

## 4. Contracts (freeze these first; CI fails on drift)

### 4.1 `contracts/intake-event.schema.json` (what GA sends)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "intake-event.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["gaFileId", "bucket", "key", "etag", "size", "uploader", "uploadedAt"],
  "properties": {
    "gaFileId":   { "type": "string", "minLength": 1, "maxLength": 128 },
    "bucket":     { "type": "string", "minLength": 3, "maxLength": 63 },
    "key":        { "type": "string", "minLength": 1, "maxLength": 1024 },
    "versionId":  { "type": "string", "maxLength": 1024 },
    "etag":       { "type": "string", "pattern": "^[A-Fa-f0-9]{32}(-[0-9]+)?$" },
    "size":       { "type": "integer", "minimum": 0 },
    "uploader":   { "type": "string", "minLength": 1, "maxLength": 256 },
    "uploadedAt": { "type": "string", "format": "date-time" },
    "params":     { "type": "object", "additionalProperties": true }
  }
}
```

`params` is an opaque bag passed through to the processing Lambda. Intake stores it; it does not interpret it.

### 4.2 `contracts/registration.schema.json` (the ledger row)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "registration.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["id", "idemKey", "status", "attempt", "gaFileId", "bucket", "key",
               "etag", "size", "uploader", "uploadedAt", "registeredAt", "updatedAt"],
  "properties": {
    "id":           { "type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$" },
    "idemKey":      { "type": "string" },
    "status":       { "enum": ["QUEUED","PROCESSING","CLEAN","FLAGGED","UNPROCESSABLE","FAILED"] },
    "attempt":      { "type": "integer", "minimum": 1 },
    "gaFileId":     { "type": "string" },
    "bucket":       { "type": "string" },
    "key":          { "type": "string" },
    "versionId":    { "type": "string" },
    "etag":         { "type": "string" },
    "size":         { "type": "integer" },
    "uploader":     { "type": "string" },
    "uploadedAt":   { "type": "string", "format": "date-time" },
    "params":       { "type": "object" },
    "registeredAt": { "type": "string", "format": "date-time" },
    "updatedAt":    { "type": "string", "format": "date-time" },
    "lastError":    { "type": "string" },
    "ttl":          { "type": "integer" }
  }
}
```

- `id` = ULID (26 chars, Crockford base32). Generate in `ids.mjs` from `crypto.randomBytes` + timestamp.
- `idemKey` = `${bucket}|${key}|${etag}` exactly, no normalization.
- `ttl` is set only when status is terminal (`CLEAN`, `FLAGGED`, `UNPROCESSABLE`), now + 90 days as epoch seconds. `FAILED` rows have no TTL (they await reprocess).

### 4.3 `contracts/registration-states.json` (the state machine)

```json
{
  "states": ["QUEUED","PROCESSING","CLEAN","FLAGGED","UNPROCESSABLE","FAILED"],
  "initial": "QUEUED",
  "terminal": ["CLEAN","FLAGGED","UNPROCESSABLE"],
  "transitions": [
    { "from": null,            "to": "QUEUED",        "owner": "intake",  "via": "POST /registrations" },
    { "from": "FAILED",        "to": "QUEUED",        "owner": "intake",  "via": "POST /registrations/{id}/reprocess" },
    { "from": "UNPROCESSABLE", "to": "QUEUED",        "owner": "intake",  "via": "POST /registrations/{id}/reprocess" },
    { "from": "QUEUED",        "to": "PROCESSING",    "owner": "lambda" },
    { "from": "PROCESSING",    "to": "CLEAN",         "owner": "lambda" },
    { "from": "PROCESSING",    "to": "FLAGGED",       "owner": "lambda" },
    { "from": "PROCESSING",    "to": "UNPROCESSABLE", "owner": "lambda" },
    { "from": "PROCESSING",    "to": "FAILED",        "owner": "lambda" }
  ]
}
```

Intake code **must** load this file and refuse any transition not listed with `owner: "intake"`. Do not hard-code the allowed set in JavaScript.

### 4.4 `contracts/audit.schema.json` (one JSONL line per event)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "audit.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["ts", "svc", "env", "event", "outcome", "reqId"],
  "properties": {
    "ts":       { "type": "string", "format": "date-time" },
    "svc":      { "const": "ess-ufm-file-intake-service" },
    "env":      { "type": "string" },
    "event":    { "enum": ["REGISTER","DUPLICATE","REPROCESS","REJECT","SWEEP_FOUND"] },
    "outcome":  { "enum": ["OK","DENIED","INVALID","CONFLICT","ERROR"] },
    "reqId":    { "type": "string" },
    "regId":    { "type": "string" },
    "idemKey":  { "type": "string" },
    "uploader": { "type": "string" },
    "detail":   { "type": "string", "maxLength": 512 }
  }
}
```

Audit lines never contain file contents, secrets, or the raw request body. Audit is written **after** the ledger write succeeds and **before** the HTTP response is sent. If the audit write fails, log at `error`, increment `audit_write_failed`, and still return the response (the ledger is the truth; audit is the trail).

---

## 5. Validation rules (`validate.mjs`)

Implement as plain functions, no library. For each schema above, write `validateX(obj) → { ok: true } | { ok: false, errors: [string] }`. Check required keys present, no extra keys, types, string lengths, the `etag` regex, `size >= 0`, and that `uploadedAt` parses via `Date.parse`. Return **all** errors, not just the first.

---

## 6. HTTP API

All routes take `Content-Type: application/json`. Max body 64 KB; larger → `413`. Every response includes header `x-request-id` (ULID, generated per request, also used as `reqId` in audit).

### 6.1 `POST /registrations`

HMAC auth (§7). Body is `intake-event` (§4.1).

Steps, in order.
1. Verify HMAC. Failure → `401 {"error":"unauthorized"}` + audit `REJECT/DENIED`. Do not reveal which check failed.
2. Parse JSON. Failure → `400 {"error":"invalid_json"}` + audit `REJECT/INVALID`.
3. Validate schema. Failure → `400 {"error":"invalid","errors":[...]}` + audit `REJECT/INVALID`.
4. Build `idemKey`. Generate `id`. Build row with `status: "QUEUED"`, `attempt: 1`, `registeredAt = updatedAt = now`.
5. `PutItem` with a condition on a GSI is not possible; therefore the table's **primary key is `idemKey`** and `id` is a GSI (see §8). The condition is `attribute_not_exists(idemKey)`.
   - Success → audit `REGISTER/OK` → `202 {"id": "<ulid>", "status": "QUEUED"}`.
   - `ConditionalCheckFailedException` → `GetItem` existing row → audit `DUPLICATE/OK` → `200 {"id": "<existing id>", "status": "<existing status>", "duplicate": true}`. A duplicate is **not** an error; GA may retry.
   - Any other error → `503 {"error":"ledger_unavailable"}` + audit `REGISTER/ERROR`. Never return `202` unless the write succeeded.

### 6.2 `POST /registrations/{id}/reprocess`

HMAC auth. Body is `{ "params": { ... } }`, an optional object, with `additionalProperties: false` at top level.

1. HMAC, JSON, validate as above.
2. Look up by `id` (GSI). Not found → `404 {"error":"not_found"}`.
3. Check `registration-states.json` allows `current.status → QUEUED` with `owner: "intake"`. Not allowed → `409 {"error":"invalid_transition","from":"<status>"}` + audit `REPROCESS/CONFLICT`.
4. `UpdateItem` with `ConditionExpression: #status = :expected` (the status read in step 2). Set `status = QUEUED`, `attempt = attempt + 1`, `updatedAt = now`, `params` = merged (new keys overwrite old), remove `ttl` and `lastError`.
   - Success → audit `REPROCESS/OK` → `200 {"id","status":"QUEUED","attempt"}`.
   - Condition failed (someone else moved it) → `409 {"error":"stale"}` + audit `REPROCESS/CONFLICT`.

### 6.3 `GET /registrations/{id}`

HMAC auth. Returns the full row (§4.2) as `200`, or `404`. No audit line.

### 6.4 `GET /healthz`

No auth. `200 {"ok":true}` if the process is up. Nothing else.

### 6.5 `GET /readyz`

No auth. `DescribeTable` on `LEDGER_TABLE` with a 2 s timeout. `200 {"ok":true}` or `503 {"ok":false,"reason":"ledger"}`. ECS/ALB health check points here.

### 6.6 Anything else

`404 {"error":"not_found"}`. Unsupported method → `405`.

---

## 7. HMAC (`hmac.mjs`)

Authenticated routes require two headers.

- `x-ufm-timestamp` holds Unix seconds as an integer
- `x-ufm-signature` holds `v1=<hex>`

The signature is `hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))` where `rawBody` is the exact bytes received, before JSON parsing.

Verify, in order.
1. Both headers present, timestamp is an integer.
2. `|now - timestamp| <= REPLAY_WINDOW_SEC`.
3. `crypto.timingSafeEqual` on the hex bytes (compare lengths first; unequal length → fail).

Any failure → `401`. Secret is loaded once at boot from Secrets Manager (`HMAC_SECRET_ARN`); support a JSON secret `{"current":"...","previous":"..."}` and accept either, so rotation is a two-step config change with no downtime.

---

## 8. DynamoDB table (`LEDGER_TABLE`)

- Partition key `idemKey` (S), no sort key.
- GSI `by-id` with partition key `id` (S), projection ALL.
- GSI `by-status` with partition key `status` (S), sort key `registeredAt` (S), projection ALL. The processing Lambda queries `status = QUEUED` ordered by `registeredAt` ascending. Intake never queries this index.
- TTL attribute `ttl`.
- On-demand billing, point-in-time recovery on, AWS-managed KMS encryption.

Every write from intake uses a `ConditionExpression`. No unconditional `PutItem`/`UpdateItem` anywhere in this service.

---

## 9. Server behavior (`server.mjs`)

- Listen on `PORT`, `0.0.0.0`.
- Structured JSON logs to stdout as `{ts, level, reqId, msg, ...fields}`. Never log request bodies or headers on authenticated routes.
- On `SIGTERM`, stop accepting, wait up to 10 s for in-flight requests, exit `0`. On unhandled rejection or exception, log and exit `1` (ECS restarts).
- Emit CloudWatch EMF metrics (single JSON log line format, no SDK call) with dimension `Environment`.
  `intake_received`, `intake_registered`, `intake_duplicate`, `intake_reprocessed`, `intake_rejected` (dimension `reason`), `intake_ledger_error`, `audit_write_failed`, `intake_latency_ms` (p50/p99 from ALB is fine; emit the raw value).

---

## 10. Sweeper (`sweeper.mjs`, build after §6 is green)

Runs in the same container on a `setInterval` of 24 h when `SWEEPER_ENABLED=true` (exactly one task should have it enabled; set via task-def env, not code).

1. Read the newest S3 Inventory manifest under `SWEEPER_INVENTORY_BUCKET/SWEEPER_INVENTORY_PREFIX`.
2. For each object row `(bucket, key, etag, size, lastModified)`: build `idemKey`; `GetItem`. If absent → register it exactly as §6.1 step 4–5 would, with `uploader = "sweeper"`, `gaFileId = "sweeper:<lastModified>"`, and audit `SWEEP_FOUND/OK`. Increment metric `intake_sweeper_found`.
3. Skip objects under prefixes listed in an optional `SWEEPER_IGNORE_PREFIXES` (comma-separated).

`intake_sweeper_found > 0` is an alarm condition for ops. It means GA missed a call. The sweeper closes the gap; the alarm reports it.

---

## 11. Tests (`node --test`, all must pass before first deploy)

Use an in-memory fake for the DynamoDB and S3 clients (a tiny class with the same method names returning promises). Do not mock the AWS SDK internals.

| Suite | Asserts |
|---|---|
| `config.test.mjs` | missing `LEDGER_TABLE` throws at boot naming it; defaults applied for optional vars |
| `hmac.test.mjs` | valid sig passes; wrong secret fails; timestamp outside window fails; `previous` secret accepted; length-mismatch fails without throwing |
| `validate.test.mjs` | each fixture in `test/fixtures/valid/*.json` passes; each in `test/fixtures/invalid/*.json` fails with the expected error list |
| `register.test.mjs` | happy path → 202 + row `QUEUED` attempt 1; same payload twice → second is 200 `duplicate:true` with same id; ledger throws → 503 and **no** audit `REGISTER/OK`; audit line matches `audit.schema.json` |
| `reprocess.test.mjs` | `FAILED → QUEUED` ok, attempt 2, `ttl` removed, params merged; `QUEUED → QUEUED` 409; `CLEAN → QUEUED` 409; stale condition → 409; unknown id → 404 |
| `states.test.mjs` | every transition intake performs exists in `registration-states.json` with `owner: "intake"` (load the file, do not restate the list) |
| `contracts.test.mjs` | each `contracts/*.json` parses and its `$id` matches its filename; snapshot hash of each file is pinned, and changing a contract requires updating the pin in the same PR |
| `server.test.mjs` | `/healthz` 200 without auth; `/readyz` 503 when ledger fake rejects; unknown route 404; body > 64 KB → 413; `SIGTERM` closes listener |
| `sweeper.test.mjs` | inventory with 3 objects, 1 already registered → 2 rows written, 2 audit `SWEEP_FOUND`, ignored prefix skipped |

Fixtures in `test/fixtures/valid/` are **captured** from a real GA call in `sbx` (redact `uploader` to `user@example.gov`). A fixture written by hand is named `*.synthetic.json` and counts as evidence only until a captured one replaces it.

---

## 12. Dockerfile

```
FROM public.ecr.aws/docker/library/node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY contracts ./contracts
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/server.mjs"]
```

Same image tag deployed to every environment. Task definition supplies §3.

---

## 13. Acceptance (definition of done)

1. `npm test` green; `contracts.test.mjs` pins present.
2. Deployed to `sbx`, 2 tasks, `/readyz` green from the ALB.
3. A real GA trigger in `sbx` produces a `QUEUED` row and an audit line within 1 s of upload-plus-AV.
4. Re-firing the same GA trigger returns `200 duplicate:true` and writes no second row.
5. Manually setting a row to `FAILED` and calling `/reprocess` returns it to `QUEUED` with `attempt: 2`.
6. The processing Lambda team confirms it can query `by-status` and read every field it needs from `registration.schema.json` without asking intake for anything else.

---

## 14. Handoff to the Lambda team (what they get from us)

- `contracts/registration.schema.json` and `contracts/registration-states.json`, copied into their repo with the same pin test. Intake owns the `null → QUEUED` and `→ QUEUED` reprocess edges; they own everything from `QUEUED → PROCESSING` onward and must use conditional writes with the same discipline (§8).
- Table name and GSI names (§8).
- Nothing else. If they need a new field, it is a contract change, a PR to both repos with pins updated together.
