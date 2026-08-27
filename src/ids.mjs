// ULID. 10 chars of time (ms) plus 16 chars of randomness, Crockford base32.
import { randomBytes } from 'node:crypto';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[rnd[i] % 32];
  return time + rand;
}
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
