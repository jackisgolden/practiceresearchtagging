import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign, verify } from '../src/hmac.mjs';
const body = Buffer.from('{"a":1}'); const now = 1_700_000_000; const secrets = { current: 'cur', previous: 'prev' };
const h = (secret, ts = now) => ({ 'x-ufm-timestamp': String(ts), 'x-ufm-signature': sign(secret, String(ts), body) });

test('valid signature passes', () => assert.equal(verify({ secrets, headers: h('cur'), rawBody: body, now, windowSec: 300 }), true));
test('previous secret accepted', () => assert.equal(verify({ secrets, headers: h('prev'), rawBody: body, now, windowSec: 300 }), true));
test('wrong secret fails', () => assert.equal(verify({ secrets, headers: h('nope'), rawBody: body, now, windowSec: 300 }), false));
test('timestamp outside window fails', () => assert.equal(verify({ secrets, headers: h('cur', now - 301), rawBody: body, now, windowSec: 300 }), false));
test('missing headers fail', () => assert.equal(verify({ secrets, headers: {}, rawBody: body, now, windowSec: 300 }), false));
test('length mismatch fails without throwing', () => assert.equal(verify({ secrets, headers: { 'x-ufm-timestamp': String(now), 'x-ufm-signature': 'v1=abc' }, rawBody: body, now, windowSec: 300 }), false));
test('tampered body fails', () => assert.equal(verify({ secrets, headers: h('cur'), rawBody: Buffer.from('{"a":2}'), now, windowSec: 300 }), false));
