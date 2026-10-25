/**
 * The canonical JSON text of a value — keys sorted at every level — is made in one module, `util/canonical-json.ts`, and it
 * is byte for byte the text the space hash has always been computed over (bundle-23 wave 0, extraction 3).
 *
 * ## The defect it prevents
 *
 * `brain/merkle.ts` (`canonicalize`, the space hash two instances compare) and `spaces/library-ref-expansion.ts`
 * (`canonical`, whether a type beside its `$ref` is the library entry) each sorted keys their own way, and bundle-23 was
 * about to add a third for a content hash. A canonical text written twice is two answers to "are these the same"; for the
 * space hash a second answer is a `MERKLE_DIVERGENCE` warning every cycle between builds for data that is identical.
 *
 * ## What it holds
 *
 * - **The merkle bytes did not move.** `docLeaf` and `fileContentHash` over `_canonical-json-corpus.mjs` equal the hashes the
 *   build BEFORE the extraction produced (pinned below, computed from that build's dist), and `canonicalJsonHash` equals the
 *   replaced `canonicalize` (kept below verbatim as a fixture) over the same corpus, with the derived fields omitted.
 * - **The library comparison did not move for anything a door can send.** It only asks whether two texts are equal, and
 *   over the JSON round trip of the corpus (what a body or a stored library entry can hold) every pair gets the verdict
 *   the replaced `canonical` gave — except an own `__proto__` key, which the old text wrote and the shared one leaves out
 *   (the merkle rule, and the bytes the hash depends on). That difference is pinned, so a change to it is a decision
 *   rather than a drift.
 * - **No other server source sorts an object's keys** — `Object.keys(…).sort(`, `Object.entries(…).sort(`,
 *   `getOwnPropertyNames`, `Reflect.ownKeys` — which is the shape of a canonical text written by hand (comments stripped,
 *   arguments balanced structurally). The two askers it came from still ask it.
 *
 * ## Seen red
 *
 * By hand: the old `canonical` put back into `spaces/library-ref-expansion.ts`, run, red naming that file; removed by hand,
 * green. And the module's `omitKeys` applied at the top level only (a one-line change, put back by hand): the derived-fields
 * pin went red.
 *
 * Run: node --test testing/standalone/canonical-json-is-made-once-and-keeps-the-merkle-bytes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';
import { CORPUS, FILE_DOC } from './_canonical-json-corpus.mjs';

const MODULE = 'server/src/util/canonical-json.ts';

/** `docLeaf` per corpus entry and `fileContentHash(FILE_DOC)`, from the dist built at the second wave-0 commit (0b7d818c). */
const PINNED = {
  'an entity': '8c72e1eb6bbf62d181f0236d79f7ce70ebbef9aafc555b613f56d6e9566e9818',
  'the same entity, keys written in reverse': '8c72e1eb6bbf62d181f0236d79f7ce70ebbef9aafc555b613f56d6e9566e9818',
  'unicode keys and values': 'ca731e837cd92637f93a874b58a71af89cb36c138ab807aaf1f905ba3f106d6f',
  'numbers': '9b7734bd9c1d73f21ca882426de5a954ba89278d4c5b33a2bc7abe6eff836335',
  'null everywhere': '06a996cb1854fddf9ed6c66b8c02d3f02a786e0750c1e93ffd179ff6ce00e272',
  'undefined fields and slots': 'd3f421a5fe53cea61d9cf0a4f03d20fb459035f2235326ecfea7dae2c82599de',
  'derived fields at the top and nested': '99e780eaad895127609df25bfa952abe6e1f9f07d3493e212556f03231ce3dd5',
  'a Date and empty containers': 'c779426e38795b96961a750b2c42ff97c54ad670970b8bf7dae6d87f82e9c309',
  'deep nesting': '6155df28095f0b7cc7168381e16c1f7a4cd988f8c694998ab25578bb34db5849',
  'object-internal names as keys': 'e327ac6b6863c68cc7175750dce3387c4069e2e471eba176e4119ac38f02c20f',
  'booleans and strings that look like other things': '2c91d958841877e3b7ff7fdd7f2249e9722c99bcf1bd63c52b84c2990345d3d3',
  file: 'b86040cb82c65be79116fe01d479dec38fadbaf1cc05dbf675cac8402f06c5dd',
};

/** `brain/merkle.ts`'s `canonicalize` as it stood before the extraction, verbatim but for the derived set as a parameter. */
function oldMerkleCanonicalize(value, derived) {
  if (Array.isArray(value)) return value.map(v => oldMerkleCanonicalize(v, derived));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (derived.has(key)) continue;
      out[key] = oldMerkleCanonicalize(value[key], derived);
    }
    return out;
  }
  return value;
}

/** `spaces/library-ref-expansion.ts`'s `canonical` as it stood before the extraction, verbatim. */
function oldLibraryCanonical(v) {
  if (Array.isArray(v)) return `[${v.map(oldLibraryCanonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${oldLibraryCanonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

/*
 * Q-624 (design rev 4 section 2, probe correction 1): the space hash leaves a derived field out at the TOP LEVEL of a record only,
 * so a nested key spelled like one is content (`merkle-hashes-a-nested-key-whatever-its-name.test.js`). The rule this file holds is
 * therefore not "the bytes never change" but "the bytes change only for a document with a nested derived-named key": every other
 * pin below stays, and the one corpus entry that carries such keys is held to the NEW bytes, computed by an oracle written here
 * (top-level omission, then the replaced canonicalize with nothing omitted), and to not being its old pin.
 */
const { LOCAL_ONLY_FIELDS } = await import('../../server/dist/sync/local-only-fields.js');
const { RETAGGED_FIELDS } = await import('../../server/dist/sync/retagged-fields.js');
const DERIVED = new Set([...LOCAL_ONLY_FIELDS, ...RETAGGED_FIELDS]);

/** Does a document carry a key spelled like a derived field BELOW its top level, in an object or in an array? */
function hasNestedDerivedKey(value, top = true) {
  if (Array.isArray(value)) return value.some(v => hasNestedDerivedKey(v, false));
  if (value && typeof value === 'object') {
    return Object.keys(value).some(k => (!top && DERIVED.has(k)) || hasNestedDerivedKey(value[k], false));
  }
  return false;
}
/** The derived fields dropped at the top level alone. */
const withoutTopLevel = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !DERIVED.has(k)));
/** The leaf the 6.0 rule produces, written independently of the module under test. */
const leafOf = (coll, doc) => sha(`doc:${coll}:${String(doc._id)}:${String(doc.seq)}:${sha(JSON.stringify(oldMerkleCanonicalize(withoutTopLevel(doc), new Set())))}`);

describe('the canonical JSON text keeps the bytes the space hash was computed over, but for a nested derived-named key', () => {
  it('the corpus is the one the pins were computed from, and some of it carries a nested derived-named key', () => {
    assert.deepEqual([...CORPUS.map(([name]) => name), 'file'].sort(), Object.keys(PINNED).sort());
    assert.ok(DERIVED.size >= 5, `only ${DERIVED.size} derived fields: the set did not load`);
    assert.ok(CORPUS.filter(([, , doc]) => hasNestedDerivedKey(doc)).length >= 1, 'no corpus entry carries a nested derived-named key: the change this file allows is never exercised');
    assert.ok(CORPUS.filter(([, , doc]) => !hasNestedDerivedKey(doc)).length >= 8, 'too few corpus entries are held to the old pins');
  });

  it('docLeaf answers the pinned hash of every document with no nested derived-named key, and fileContentHash its pin', async () => {
    const { docLeaf, fileContentHash } = await import('../../server/dist/brain/merkle.js');
    for (const [name, coll, doc] of CORPUS) {
      if (!hasNestedDerivedKey(doc)) assert.equal(docLeaf(coll, doc), PINNED[name], `docLeaf moved for: ${name}`);
    }
    assert.equal(fileContentHash(FILE_DOC), PINNED.file, 'fileContentHash moved');
  });

  it('a document with a nested derived-named key answers the top-level-only bytes, and no longer its old pin', async () => {
    const { docLeaf } = await import('../../server/dist/brain/merkle.js');
    for (const [name, coll, doc] of CORPUS) {
      if (!hasNestedDerivedKey(doc)) continue;
      assert.equal(docLeaf(coll, doc), leafOf(coll, doc), `docLeaf is not the top-level-only leaf for: ${name}`);
      assert.notEqual(docLeaf(coll, doc), PINNED[name], `docLeaf still answers the every-level pin for: ${name}`);
    }
  });

  it('canonicalJson omits nothing: the every-level omitKeys is gone with its only caller, and the text is the replaced canonicalize with nothing omitted', async () => {
    const { canonicalJsonHash, canonicalJson } = await import('../../server/dist/util/canonical-json.js');
    const sample = { a: 1, b: { a: 2, c: 3 } };
    assert.equal(canonicalJson(sample, { omitKeys: new Set(['a']) }), canonicalJson(sample),
      'canonicalJson still drops the keys it is asked to omit, at every level: nothing needs it and a nested key is content');
    assert.ok(!/omitKeys/.test(readFileSync('server/src/util/canonical-json.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
      'util/canonical-json.ts still has an omitKeys option');
    for (const [name, , doc] of CORPUS) {
      const text = JSON.stringify(oldMerkleCanonicalize(doc, new Set()));
      assert.equal(canonicalJson(doc), text, `the unomitted text moved for: ${name}`);
      assert.equal(canonicalJsonHash(doc), sha(text), `the unomitted hash moved for: ${name}`);
    }
  });

  /*
   * The library caller only ever asks whether two texts are EQUAL, so what must not move is the verdict, not the text — and
   * the text does differ: an integer-like key (`"2"`, `"10"`) is written in ascending numeric order before the others,
   * because `JSON.stringify` enumerates an object that way, where the old library copy wrote `"10"` before `"2"`. Both
   * are deterministic, so equal values still give equal texts in each.
   */
  it('the library comparison gives the same verdict as before for everything JSON can carry, and the one difference is pinned', async () => {
    const { canonicalJson } = await import('../../server/dist/util/canonical-json.js');
    const internal = 'object-internal names as keys';
    const values = CORPUS.filter(([name]) => name !== internal)
      .map(([, , doc]) => JSON.parse(JSON.stringify(doc)))
      .flatMap(wire => [wire, ...Object.values(wire)]);
    assert.ok(values.length >= 50, `only ${values.length} values to compare`);
    let equalPairs = 0;
    for (const a of values) {
      for (const b of values) {
        const before = oldLibraryCanonical(a) === oldLibraryCanonical(b);
        assert.equal(canonicalJson(a) === canonicalJson(b), before,
          `the verdict moved for ${JSON.stringify(a)} against ${JSON.stringify(b)}`);
        if (before && a !== b) equalPairs++;
      }
    }
    assert.ok(equalPairs >= 2, 'no two distinct values compared equal, so key order was never exercised');
    assert.equal(canonicalJson(undefined), oldLibraryCanonical(undefined), 'a missing key no longer compares unequal to a present one');

    const withInternal = JSON.parse('{"b":1,"__proto__":{"x":1}}');
    assert.notEqual(oldLibraryCanonical(withInternal), oldLibraryCanonical({ b: 1 }));
    assert.equal(canonicalJson(withInternal), canonicalJson({ b: 1 }),
      'an own __proto__ key is left out of the text, as the space hash always left it');
  });
});

describe('no other server source writes a canonical text by hand', () => {
  /** A list of an object's keys that is then sorted: the first line of every hand-written canonical text. */
  const KEY_LISTERS = /\b(?:Object\.(?:keys|entries|getOwnPropertyNames)|Reflect\.ownKeys)\s*\(/g;
  const sortedKeyListsIn = code => [...code.matchAll(KEY_LISTERS)]
    .filter(m => /^\s*\.sort\s*\(/.test(code.slice(m.index + m[0].length - 1 + balancedFrom(code, m.index + m[0].length - 1, 'a key list').length)))
    .map(m => m.index);

  it('the reader finds both spellings it replaced, and not a sort of something else', () => {
    assert.equal(sortedKeyListsIn(oldMerkleCanonicalize.toString()).length, 1);
    assert.equal(sortedKeyListsIn(oldLibraryCanonical.toString()).length, 1);
    assert.equal(sortedKeyListsIn('const e = Object.entries(o).sort((a, b) => a[0] < b[0] ? -1 : 1);').length, 1);
    assert.equal(sortedKeyListsIn('const names = files.map(f => f.name).sort(); Object.keys(o).length;').length, 0);
  });

  const sources = readTrackedSources('server/src', { untracked: true })
    .map(({ file, text }) => ({ file, code: stripComments(text) }));

  it('reads a tree worth reading, and the askers still ask (the floors)', () => {
    assert.ok(sources.length >= 300, `only ${sources.length} server sources were read`);
    const askers = sources.filter(s => s.file !== MODULE && /\bcanonicalJson(?:Hash)?\s*\(/.test(s.code)).map(s => s.file);
    assert.ok(askers.length >= 2, `only ${askers.length} file(s) ask the module: ${askers.join(', ')}`);
    assert.ok(sortedKeyListsIn(sources.find(s => s.file === MODULE)?.code ?? '').length >= 1,
      `${MODULE} no longer sorts keys the way this reader recognises, so the reader proves nothing about the other files`);
  });

  it('no other server source sorts an object\'s keys', () => {
    const copies = sources.filter(s => s.file !== MODULE && sortedKeyListsIn(s.code).length > 0).map(s => s.file);
    assert.deepEqual(copies, [],
      `a canonical text written by hand — use canonicalJson / canonicalJsonHash (${MODULE}):\n  ${copies.join('\n  ')}`);
  });
});
