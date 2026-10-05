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
 * - Every caller hands the module its parts one by one (a part the caller joins first moves the boundary back to a
 *   separator), and the link violation's id is derived from exactly the parameters that identify the violation.
 *
 * Seen red by hand, each restored by hand: a plain `join('|')` in the module (the separator sweep), no namespace guard,
 * a changed version bit, a changed fork namespace (the pinned values), a `| 0x40` written back into `forkIdFor`, the
 * link violation's call losing `docId`, joining two parts in a template literal, or not calling the module at all.
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
    // Whatever single character, or short run, a hand-written join would put between parts: a part that carries it must
    // not be able to move the boundary. Every code point below 256 is tried, so a separator nobody thought of is found too.
    const separators = [...Array(256).keys()].map(c => String.fromCharCode(c)).concat(['::', '||', '\r\n', '->', ', ']);
    assert.ok(separators.length >= 256, 'the separator sweep is empty');
    for (const s of separators) pairs.push([[`a${s}b`, 'c'], ['a', `b${s}c`]]);
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

  it('every caller hands the module its parts one by one, and the link violation names every field that identifies it', () => {
    // The module's length-prefixed encoding only protects parts it is GIVEN: a caller that joins two of them into one
    // template literal first moves the boundary back to a separator the peer's text can forge.
    const calls = [];
    for (const { file, text } of readTrackedSources('server/src')) {
      if (file === MODULE) continue;
      const code = stripComments(text);
      for (const m of code.matchAll(/\bderivedV4Id\(/g)) {
        let depth = 1, i = m.index + m[0].length;
        const start = i;
        for (; i < code.length && depth > 0; i++) depth += code[i] === '(' ? 1 : code[i] === ')' ? -1 : 0;
        const args = code.slice(start, i - 1).split(',').map(s => s.trim());
        calls.push({ file, args });
      }
    }
    assert.ok(calls.length >= 2, `only ${calls.length} caller(s) of derivedV4Id found — the scan reads the wrong place`);
    for (const { file, args } of calls) {
      assert.match(args[0], /^'[a-z][\w.-]*'$/, `${file}: the namespace is not a plain string literal: ${args[0]}`);
      assert.ok(args.length >= 2, `${file}: a derived id with no parts is one id for everything`);
      for (const part of args.slice(1)) {
        assert.match(part, /^(String\()?[\w$.]+\)?$/, `${file}: a part is built by the caller (${part}) — pass the pieces, the module encodes them`);
      }
    }
    // The link violation's id is what a violation IS: every parameter that says WHICH record, field and target is
    // dangling. spaceId (the collection is per space), reason and peerInstanceId describe the sighting, not the violation.
    const sig = stripComments(readFileSync('server/src/api/sync/_shared.ts', 'utf8')).match(/function recordLinkViolation\(([^)]*)\)/);
    assert.ok(sig, 'recordLinkViolation was not found in api/sync/_shared.ts');
    const params = sig[1].split(',').map(p => p.split(':')[0].trim()).filter(Boolean);
    const identifying = params.filter(p => !['spaceId', 'reason', 'peerInstanceId'].includes(p));
    assert.ok(identifying.length >= 3, `only ${identifying.length} identifying parameter(s) read from recordLinkViolation`);
    const violation = calls.find(c => c.file === 'server/src/api/sync/_shared.ts' && c.args[0] === "'ythril.link-violation'");
    assert.ok(violation, 'recordLinkViolation no longer derives its id under ythril.link-violation');
    assert.deepEqual([...violation.args.slice(1)].sort(), [...identifying].sort(),
      'the violation id is not derived from exactly the parameters that identify it (a dropped field collapses two violations; an added one splits one)');
  });
});
