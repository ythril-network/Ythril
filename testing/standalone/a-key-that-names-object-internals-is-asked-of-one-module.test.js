/**
 * Whether a caller's key names an object's internals is asked of ONE module, `util/object-internal-keys.ts` (bundle-23
 * wave 0, extraction 1).
 *
 * ## The defect it prevents
 *
 * `{ '__proto__', 'constructor', 'prototype' }` was written three times in `server/src`: `PROTO_KEYS` in
 * `brain/delete-fields.ts` and `brain/merge.ts`, `UNSAFE_FILTER_KEYS` in `brain/filter-sanitizer.ts`. Identical, and that is
 * the dangerous moment for a copy: the next person to widen one (a fourth key) leaves the other two refusing less, and a
 * `deleteFields` path, a merged property or a filter key that slips past the narrower copy writes to a prototype instead of
 * a record, answering 200. Bundle-23 was about to add a fourth set (reserved rule names).
 *
 * ## What it holds
 *
 * - The module answers yes for each of the three and no for near misses (case, a prefix, a dotted path — a caller splits).
 * - No other tracked source under `server/src` spells `__proto__` as a string in code (comments stripped): every such
 *   literal is a set, a comparison or a list of the keys, which is a second copy of the answer. The marker is `__proto__`
 *   because no set of these keys can leave it out; `constructor` and `prototype` alone are ordinary words.
 * - The three callers it came from still ask the module (the set of askers is derived and has a floor, so a caller that
 *   quietly went back to a copy shows up as a missing asker AND as a literal).
 *
 * ## Seen red
 *
 * By hand: `const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);` put back into `brain/merge.ts`, run,
 * red naming that file; removed by hand, green.
 *
 * Run: node --test testing/standalone/a-key-that-names-object-internals-is-asked-of-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/util/object-internal-keys.ts';
/** `__proto__` as a quoted string in code: the one member no copy of the set can omit. */
const PROTO_LITERAL = /(['"`])__proto__\1/;

describe('a key that names object internals is asked of one module', () => {
  it('the module answers for each internal key and for nothing else', async () => {
    const { isObjectInternalKey } = await import('../../server/dist/util/object-internal-keys.js');
    for (const key of ['__proto__', 'constructor', 'prototype']) assert.equal(isObjectInternalKey(key), true, key);
    for (const key of ['', 'title', '__proto', 'Constructor', 'PROTOTYPE', 'properties.__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(isObjectInternalKey(key), false, `'${key}' is a field name, not an internal key`);
    }
  });

  const sources = readTrackedSources('server/src', { untracked: true })
    .map(({ file, text }) => ({ file, code: stripComments(text) }));

  it('reads a tree worth reading, and the module has askers (the floors)', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} server sources were read`);
    const askers = sources.filter(s => s.file !== MODULE && /\bisObjectInternalKey\s*\(/.test(s.code)).map(s => s.file);
    assert.ok(askers.length >= 3, `only ${askers.length} file(s) ask isObjectInternalKey: ${askers.join(', ')}`);
    for (const f of ['server/src/brain/delete-fields.ts', 'server/src/brain/merge.ts', 'server/src/brain/filter-sanitizer.ts']) {
      assert.ok(askers.includes(f), `${f} no longer asks isObjectInternalKey — it has its own answer again`);
    }
  });

  it('the module also answers the wider question — a name every object answers to — for the prototype\'s names and `prototype`', async () => {
    const { isObjectPrototypeName } = await import('../../server/dist/util/object-internal-keys.js');
    for (const name of ['toString', 'hasOwnProperty', 'valueOf', 'constructor', '__proto__', 'prototype']) {
      assert.equal(isObjectPrototypeName(name), true, name);
    }
    for (const name of ['', 'title', 'minAge', 'tostring', 'Prototype']) assert.equal(isObjectPrototypeName(name), false, name);
  });

  it('no other server source asks `in Object.prototype` itself (G2: the rule-name check asks the module, as the editor mirrors it)', () => {
    const copies = sources.filter(s => s.file !== MODULE && /\bin\s+Object\.prototype\b/.test(s.code)).map(s => s.file);
    assert.deepEqual(copies, [],
      `a second spelling of "a name every object answers to" — ask isObjectPrototypeName (${MODULE}) instead:\n  ${copies.join('\n  ')}`);
  });

  it('no other server source spells the internal keys itself', () => {
    const copies = sources.filter(s => s.file !== MODULE && PROTO_LITERAL.test(s.code)).map(s => s.file);
    assert.deepEqual(copies, [],
      `a second copy of the object-internal keys — ask isObjectInternalKey (${MODULE}) instead:\n  ${copies.join('\n  ')}`);
  });
});
