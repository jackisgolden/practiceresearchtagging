// The x-ufm-signature header carries v1=<hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))>.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function sign(secret, timestamp, rawBody) {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

// secrets is { current, previous? }. Returns true or false, never throws.
export function verify({ secrets, headers, rawBody, now = Math.floor(Date.now() / 1000), windowSec }) {
  try {
    const tsRaw = headers['x-ufm-timestamp'];
    const sig = headers['x-ufm-signature'];
    if (typeof tsRaw !== 'string' || typeof sig !== 'string') return false;
    if (!/^\d{1,12}$/.test(tsRaw)) return false;
    const ts = Number(tsRaw);
    if (Math.abs(now - ts) > windowSec) return false;
    const got = Buffer.from(sig, 'utf8');
    for (const secret of [secrets.current, secrets.previous].filter(Boolean)) {
      const want = Buffer.from(sign(secret, tsRaw, rawBody), 'utf8');
      if (want.length === got.length && timingSafeEqual(want, got)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
