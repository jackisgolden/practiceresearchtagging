// Changing any contract requires updating pins.json in the same PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dir = new URL('../contracts/', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('./pins.json', import.meta.url), 'utf8'));

for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  test(`contract ${f} parses, $id matches, hash pinned`, () => {
    const raw = readFileSync(new URL(f, dir), 'utf8');
    const j = JSON.parse(raw);
    if (j.$id) assert.equal(j.$id, f);
    const h = createHash('sha256').update(raw).digest('hex');
    assert.equal(pins[f], h, `contract ${f} changed; update test/pins.json (new sha256 ${h})`);
  });
}
test('no unpinned or stale pins', () => {
  assert.deepEqual(Object.keys(pins).sort(), readdirSync(dir).filter((f) => f.endsWith('.json')).sort());
});
