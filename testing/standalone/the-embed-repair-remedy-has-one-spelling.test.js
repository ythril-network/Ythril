/**
 * The sentence that tells an operator how to repair records an embed job never covered has ONE spelling (Q-261).
 *
 * ## What it prevents
 *
 * Two warnings said how to repair a record whose embed job was not queued, in different words and with different promises:
 * "POST /api/spaces/:id/reembed queues every record that has no vector" (false for an updated record, which keeps its vector)
 * and "a reindex queues them" (a reindex is a different, heavier operation). The reader who follows the wrong one finds nothing
 * repaired. The remedy is `EMBED_REPAIR_HINT` (`brain/embed-queue.ts`), and every warning that names the repair uses it.
 *
 * ## What is asked, with the comments stripped
 *
 * - the constant exists, and at least two sites use it (the write lane's warning and the arrival writer's);
 * - no other string in `server/src` says that a reembed or a reindex "queues" something: that sentence is the constant's.
 *
 * Run: node --test testing/standalone/the-embed-repair-remedy-has-one-spelling.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SOURCES = trackedSources('server/src', { floor: 200 });
const code = new Map(SOURCES.map(f => [f, stripComments(readFileSync(f, 'utf8'))]));

// To the `';` that ends the statement: the sentence itself holds semicolons.
const DEFINITION = /export const EMBED_REPAIR_HINT\b[\s\S]*?'\s*;/;
const SAYS_QUEUES = /\bre-?(?:embed|index)\b[^'"`\n]{0,40}\bqueues\b/i;

describe('the embed repair remedy has one spelling', () => {
  it('the constant exists once and is used by at least two sites', () => {
    const definers = [...code].filter(([, src]) => DEFINITION.test(src)).map(([f]) => f);
    assert.deepEqual(definers, ['server/src/brain/embed-queue.ts'], 'EMBED_REPAIR_HINT is not defined exactly once, in the embed queue');
    const users = [...code].filter(([f, src]) => !definers.includes(f) ? /\bEMBED_REPAIR_HINT\b/.test(src) : (src.match(/\bEMBED_REPAIR_HINT\b/g) ?? []).length > 1)
      .map(([f]) => f);
    assert.ok(users.length >= 2, `only ${users.length} site(s) use EMBED_REPAIR_HINT: ${users}`);
    assert.ok(users.includes('server/src/sync/arrivals.ts'), 'the arrival writer names its own remedy instead of the constant');
  });

  it('no string outside the constant says that a reembed or a reindex queues records', () => {
    const wrong = [];
    for (const [file, src] of code) {
      const without = src.replace(DEFINITION, '');
      const hit = without.match(SAYS_QUEUES);
      if (hit) wrong.push(`${file}: ${hit[0]}`);
    }
    assert.deepEqual(wrong, [], 'a warning spells the repair itself instead of using EMBED_REPAIR_HINT');
  });
});
