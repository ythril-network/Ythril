/**
 * An id DERIVED from what it names — sha256 over its parts, shaped as a v4 UUID — is built in one module, with the
 * length-prefixed encoding inside it (Q-361 item 17; ported from main's gate of the same name, bundle-30 I13).
 *
 * ## The defect
 *
 * `forkIdFor` (`sync/upsert-plan.ts`) derived a fork's id with `idPart`'s length-prefixed encoding and set the version
 * and variant bits on the bytes; its docblock warned that a second spelling of the encoding is a second place for the
 * separator to become forgeable. A strict-linkage violation's id (`recordLinkViolation`, `api/sync/_shared.ts`) is that
 * second derivation, and its target id is a peer's text: a crafted `(docId, field, target)` joined with a separator could
 * collide two violations into one record.
 *
 * ## What is asserted
 *
 * - `derivedV4Id` is injective over its parts (a separator inside a part cannot move a boundary), shapes a valid v4
 *   UUID, and refuses an empty namespace.
 * - `forkIdFor` still answers byte-for-byte what 5.6.3 answered (values computed on 5.6.3) — a changed fork id would
 *   fork every record again on a mixed-version network.
 * - No other server source shapes a v4 id from a hash: the shaping (`| 0x40`, a `'89ab'[…]` variant patch) is found
 *   nowhere but the module, and both derivations call it.
 *
 * Seen red by hand: a `| 0x40` written back into `forkIdFor`'s body fails the third case; restored by hand.
 *
 * Run: node --test testing/standalone/a-derived-id-is-shaped-in-one-place.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/util/derived-id.ts';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('a derived id is shaped in one place', () => {
  it('derivedV4Id is injective over its parts and shapes a v4 UUID', async () => {
    assert.ok(existsSync(MODULE), `${MODULE} does not exist — there is no one place a derived id is shaped`);
    const { derivedV4Id } = await import('../../server/dist/util/derived-id.js');
    const NUL = String.fromCharCode(0);
    const pairs = [
      [['edge', `a${NUL}b`, 'c'], ['edge', 'a', `b${NUL}c`]],
      [['edge', '1:a', 'b'], ['edge', '1', ':ab']],
      [['ab', 'c'], ['a', 'bc']],
    ];
    for (const [x, y] of pairs) {
      assert.notEqual(derivedV4Id('ythril.test', ...x), derivedV4Id('ythril.test', ...y),
        `two different part lists derive one id: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
    }
    assert.equal(derivedV4Id('ythril.test', 'a', 'b'), derivedV4Id('ythril.test', 'a', 'b'), 'not deterministic');
    assert.notEqual(derivedV4Id('ythril.one', 'a'), derivedV4Id('ythril.two', 'a'), 'the namespace is not part of the id');
    assert.match(derivedV4Id('ythril.test', 'x'), V4);
    assert.throws(() => derivedV4Id('', 'x'), 'an empty namespace would let two derivations share an id space');
  });

  it('forkIdFor answers what it answered before the move', async () => {
    const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
    assert.equal(forkIdFor('cccccccc-0000-4000-8000-000000000001', 7, 'diverging text'), 'f1c4bfcb-fc60-405b-90da-1ed27e28aa50');
    assert.equal(forkIdFor('a', 1, ''), '6d2f8506-bc2d-4354-945d-dcb95089125c');
  });

  it('no other server source shapes a v4 id from a hash, and both derivations use the module', () => {
    const shaping = [/\|\s*0x40\b/, /'89ab'\[/];
    const found = [];
    const sources = readTrackedSources('server/src');
    assert.ok(sources.length >= 200, `only ${sources.length} server source(s) read — the scan is looking in the wrong place`);
    for (const { file, text } of sources) {
      if (file === MODULE) continue;
      const code = stripComments(text);
      for (const re of shaping) if (re.test(code)) found.push(`${file}: ${re}`);
    }
    assert.deepEqual(found, [], `a second copy of the v4 shaping — derive the id through ${MODULE}`);
    for (const f of ['server/src/sync/upsert-plan.ts', 'server/src/api/sync/_shared.ts']) {
      assert.match(stripComments(readFileSync(f, 'utf8')), /derivedV4Id\(/, `${f} derives its id without the shared module`);
    }
  });
});
