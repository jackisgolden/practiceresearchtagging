# ess-ufm-file-intake-service

Internal ECS service. GoAnywhere calls it after a client file lands in S3 and passes AV. It writes one `QUEUED` row to the registration ledger and returns `202`. The scheduled processing Lambda reads `QUEUED` rows. This service owns only the ledger's edges into `QUEUED`. Full spec in `INTAKE-HANDOFF.md`.

## Run
```
npm ci
npm test                                  # 48 asserts, in-memory ledger/audit, no AWS needed
ENVIRONMENT=sbx AWS_REGION=us-gov-west-1 LEDGER_TABLE=... AUDIT_BUCKET=... AUDIT_PREFIX=intake/audit/ HMAC_SECRET_ARN=... npm start
```
Missing required env crashes at boot naming the variable. Same image every environment, only `task-def.json` env differs.

## Call it
```
TS=$(date +%s); BODY='{"gaFileId":"ga-1","bucket":"ess-client-acme-sbx","key":"inbound/x.csv","etag":"d41d8cd98f00b204e9800998ecf8427e","size":10,"uploader":"u@example.gov","uploadedAt":"2026-08-25T14:00:00Z"}'
SIG=v1=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -s -X POST http://intake.internal:8080/registrations -H "content-type: application/json" -H "x-ufm-timestamp: $TS" -H "x-ufm-signature: $SIG" -d "$BODY"
```
Routes are `POST /registrations` · `POST /registrations/{id}/reprocess` · `GET /registrations/{id}` · `GET /healthz` · `GET /readyz`.

## Layout
`src/app.mjs` pure handler, all I/O injected · `src/server.mjs` wiring + http · `src/ledger.mjs` Dynamo + in-memory twin · `src/audit.mjs` JSONL to S3 · `src/sweeper.mjs` daily S3 Inventory diff · `contracts/` frozen, sha256-pinned in `test/pins.json` (changing a contract means updating the pin in the same PR).

## Fixtures
`test/fixtures/valid/*.synthetic.json` are hand-written. Replace each with a captured GA payload from `sbx` (redact `uploader`) and drop the `.synthetic` suffix.

## Open items
`TTL_DAYS` in `src/app.mjs` is exported but never used. The spec puts `ttl` stamping on terminal states, which the Lambda owns, so the constant probably belongs in that repo. Decide with the Lambda team, then wire it there or delete it here.
