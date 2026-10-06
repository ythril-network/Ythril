/**
 * Every reader that pages local records by seq builds its position through ONE module, `util/seq-keyset.ts`
 * (bundle-52, Q-277).
 *
 * ## The rule, and the defect it ends
 *
 * Records keep their author's seq, so several records can share one. A reader that asks `seq > last` and sorts
 * `{ seq: 1 }` loses the tail of a run of equal seqs at every page or batch boundary — and each reader had its own
 * copy of the filter, its own sort, and its own idea of where the cursor stops: the six record routes (`api/sync/docs.ts`),
 * the push (`sync/engine.ts`), the tombstone read (`brain/tombstones.ts`) and the two scanners. One rule written five
 * times, and the weakest copy wins silently (CLAUDE.md, "The defect class this repo produces most").
 *
 * The rule: a position is a PAIR `(seq, _id)`, the filter for "what comes after it" is `seqKeysetFilters`, the sort is
 * `SEQ_KEYSET_SORT`, the indexes are `SEQ_KEYSET_INDEXES`, and the horizon (`settledSeqRange`) is applied inside the
 * module and nowhere else.
 *
 * ## How the set of readers is found (and why it does not ask module A)
 *
 * A gate that asked "who imports the module" would never see the reader that did not. So the readers are found by the
 * SHAPES a seq-ordered read has always had, read out of every tracked source: a `.sort({ ... seq ...})`, a `seq: { $gt|$gte }`, a use
 * of `settledSeqRange`. (`$lt|$lte` on seq are not detectors: they are write guards and keyed lookups — `upsert-plan.ts`,
 * `push-reads.ts` — and a delete below an acknowledged floor, `tombstone-prune.ts`; none of them pages.) Those are the detectors; the import of the module is only the thing each found reader is then
 * asked to have. The union with the importers keeps the floor honest after the change, when the old shapes are gone and
 * the importers are what is left.
 *
 * ## Exemptions, each with its reason
 *
 * - a newest-first sort capped by a limit: `highestStoredSeq`'s `sort({ seq: -1 }).limit(1)` and the fresh-writes window
 *   (`$sort: { seq: -1 }, $limit`, `brain/fresh-writes.ts`). A maximum or a window, not a position: there is no next page.
 * - a sort whose LAST key is `_id`, in a file that does not import the module: a total order is not a position reader.
 *
 * Run: node --test testing/standalone/every-seq-paged-reader-goes-through-the-keyset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround } from './_structural-window.mjs';

const KEYSET = 'server/src/util/seq-keyset.ts';
const SEQ_UTIL = 'server/src/util/seq.ts';
/** A file the KEYSET module is imported by, however it spells the path. */
const IMPORTS_KEYSET = /\bfrom\s+['"][^'"]*\bseq-keyset\.js['"]/;

/**
 * The shapes of a seq-ordered read. Each is checked against a sample below, so a detector that rots into matching
 * nothing fails its own rule and not silently every rule that uses it.
 */
const DETECTORS = [
  { name: 'a sort that names seq', re: /\.sort\(\s*(\{[^}]*\bseq\s*:[^}]*\})/g, sample: 'x.find(f).sort({ seq: 1 }).limit(5)' },
  { name: 'a sort option that names seq', re: /\bsort\s*:\s*(\{[^}]*\bseq\s*:[^}]*\})/g, sample: 'find(f, { sort: { seq: 1, _id: 1 } })' },
  { name: 'a hand-built seq range', re: /\bseq\s*:\s*\{\s*\$(?:gt|gte)\b/g, sample: 'find({ seq: { $gt: n } })' },
  { name: 'the settled-seq horizon', re: /\bsettledSeqRange\b/g, sample: 'seq: await settledSeqRange(spaceId, since)' },
];

const sources = readTrackedSources('server/src', { specs: false }).map(s => ({ file: s.file, text: stripComments(s.text) }));
const byFile = new Map(sources.map(s => [s.file, s]));

/** Every site: where it is, which detector found it, and the object a sort names. */
function sitesOf({ file, text }) {
  const out = [];
  for (const d of DETECTORS) {
    for (const m of text.matchAll(d.re)) out.push({ file, detector: d.name, index: m.index, object: m[1] });
  }
  return out;
}

/** The reason a site is exempt, or `null`. The statements it asks about are bounded structurally (`_structural-window.mjs`). */
function exemption(site, importsKeyset) {
  const text = byFile.get(site.file).text;
  // Newest first and capped: `highestStoredSeq` (`.sort({ seq: -1 }).limit(1)`) and the fresh-writes window
  // (`$sort: { seq: -1 }, $limit`). There is no next page, so a tie at the cut cannot lose what a later page would serve.
  if (/\bseq\s*:\s*-1\b/.test(site.object)
    && /\$?\blimit\b/.test(statementAround(text, site.index, `${site.file} newest-first read`))) {
    return 'a newest-first read capped by a limit (highestStoredSeq, the fresh-writes window): a maximum, not a position, so a tie cannot lose a record a later page would serve';
  }
  if (site.file === SEQ_UTIL && site.detector === 'the settled-seq horizon' && /function\s+$/.test(text.slice(0, site.index))) {
    return 'the definition of the horizon; the keyset module is its only caller';
  }
  if (site.detector.startsWith('a sort') && !importsKeyset) {
    const keys = site.object.replace(/[{}]/g, '').split(',').map(k => k.trim()).filter(Boolean);
    if (keys.length > 1 && /^_id\b/.test(keys[keys.length - 1])) return 'a sort that ends in _id is a total order, not a position reader';
  }
  return null;
}

const readers = sources
  .filter(s => s.file !== KEYSET)
  .map(s => ({ ...s, importsKeyset: IMPORTS_KEYSET.test(s.text) }))
  .map(s => ({ ...s, sites: sitesOf(s).map(site => ({ ...site, exempt: exemption(site, s.importsKeyset) })) }))
  .filter(s => s.importsKeyset || s.sites.length > 0);

/** Files that are a reader at all: some site that is not exempt, or an importer of the module. */
const readerFiles = readers.filter(s => s.importsKeyset || s.sites.some(x => x.exempt === null));
const locate = (file, index) => {
  const text = byFile.get(file).text;
  return `${file}:${text.slice(0, index).split('\n').length}`;
};

describe('the readers are derived from the code, and the derivation sees what it claims to', () => {
  it('every detector matches its own sample, so a rotted pattern fails here and not as a silent pass everywhere', () => {
    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      assert.ok(d.re.test(d.sample), `the detector for ${d.name} matches nothing it was written for`);
      d.re.lastIndex = 0;
    }
    assert.ok(!/\bseq\s*:\s*\{\s*\$(?:gt|gte)\b/.test('originalSeq: { $gt: 1 }'), 'originalSeq is not seq');
  });

  it('finds at least five reader files (floor), and the tracked listing is a real one', () => {
    assert.ok(sources.length >= 100, `only ${sources.length} sources listed`);
    assert.ok(DETECTORS.length >= 4);
    assert.ok(readerFiles.length >= 5,
      `only ${readerFiles.length} seq-ordered reader file(s) found: ${readerFiles.map(r => r.file).join(', ')}. `
      + 'The record routes, the push, the tombstone read and the two scanners are all readers; fewer means the derivation broke.');
  });

  it('every exemption that was taken still names a real site (a stale exemption exempts nothing and says so)', () => {
    const used = readers.flatMap(r => r.sites).filter(s => s.exempt !== null);
    assert.ok(used.length >= 1, 'highestStoredSeq is an exempt site today; none found means the exemption or the code moved');
  });
});

describe('module A is the one place a seq position is built', () => {
  it('server/src/util/seq-keyset.ts exists and declares the sort, the filters, the codec and the indexes', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} is not tracked: the module this bundle introduces does not exist yet`);
    for (const name of ['seqKeysetFilters', 'SEQ_KEYSET_SORT', 'SEQ_KEYSET_INDEXES', 'encodeSeqCursor', 'decodeSeqCursor']) {
      assert.match(a.text, new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`), `${KEYSET} does not export ${name}`);
    }
  });

  it('the extra filter is never spread into the position filter (a spread lets a future key overwrite the guard)', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} does not exist yet`);
    assert.doesNotMatch(a.text, /\.\.\.\s*(?:extra|extraFilter|ownedFilter|pushFilter)\b/, `${KEYSET} spreads the extra filter`);
    // The RULE is "an intersection, never a spread", not one spelling of it: a literal `$and`, or `andPredicates`
    // (`db/and-predicates.ts`) — which is then itself held to the rule, so the delegation cannot hollow out unseen.
    const viaAnd = /\$and\b/.test(a.text);
    const viaHelper = /\bandPredicates\s*\(/.test(a.text) && /from\s+['"][^'"]*\band-predicates\.js['"]/.test(a.text);
    assert.ok(viaAnd || viaHelper, `${KEYSET} must compose the extra filter by $and, directly or through andPredicates`);
    if (viaHelper) {
      const helper = byFile.get('server/src/db/and-predicates.ts');
      assert.ok(helper, 'db/and-predicates.ts is not tracked: the keyset module delegates the intersection to it');
      assert.match(helper.text, /\{\s*\$and\s*:/, 'andPredicates no longer builds an $and, so the keyset filters are no longer an intersection');
    }
    for (const r of readers) {
      const spread = r.text.match(/seqKeysetFilters\s*\([^;]*\.\.\./);
      assert.equal(spread, null, `${r.file} spreads into a seqKeysetFilters call`);
    }
  });
});

describe('every seq-ordered reader goes through it', () => {
  it('each reader file imports the keyset module', () => {
    assert.ok(readerFiles.length >= 5, 'floor: see above');
    const without = readerFiles.filter(r => !r.importsKeyset)
      .map(r => `${r.file} (${[...new Set(r.sites.filter(s => s.exempt === null).map(s => s.detector))].join(', ')})`);
    assert.deepEqual(without, [], 'these read local records in seq order and build their own position:');
  });

  it('no reader builds a forward seq range by hand: not `seq: { $gt|$gte }`, anywhere in server/src (green at base: the shape arrives only by regression)', () => {
    const hand = readers.flatMap(r => r.sites)
      .filter(s => s.detector === 'a hand-built seq range' && s.exempt === null)
      .map(s => locate(s.file, s.index));
    assert.deepEqual(hand, [], 'a position written by hand is the defect: it is `>` where a tie needs the pair');
  });

  it('`settledSeqRange` has no caller outside the keyset module: the horizon is applied in one place', () => {
    const callers = readers.flatMap(r => r.sites)
      .filter(s => s.detector === 'the settled-seq horizon' && s.exempt === null)
      .map(s => locate(s.file, s.index));
    assert.deepEqual(callers, []);
  });

  it('no reader sorts by seq on its own: the sort is SEQ_KEYSET_SORT, which ends in _id', () => {
    const own = readers.flatMap(r => r.sites)
      .filter(s => s.detector.startsWith('a sort') && s.exempt === null)
      .map(s => `${locate(s.file, s.index)}  ${s.object.replace(/\s+/g, ' ')}`);
    assert.deepEqual(own, [], 'a sort on seq alone orders a tie by whatever the storage engine likes, so the next page cannot continue it');
  });

  it('every file that asks the module for a filter also sorts with SEQ_KEYSET_SORT; one that asks for the READ gets the sort inside it', () => {
    // `readAfterSeq` is the module's read: both finds, the horizon, the readiness fallback and the sort live inside it, so a caller
    // of it cannot drop the sort. A file that builds its own finds from `seqKeysetFilters` has to bring the sort itself.
    const askers = readers.filter(r => /\b(?:seqKeysetFilters|readAfterSeq)\b/.test(r.text));
    assert.ok(askers.length >= 1, 'no reader calls seqKeysetFilters or readAfterSeq yet');
    for (const r of askers.filter(a => /\bseqKeysetFilters\b/.test(a.text))) {
      assert.match(r.text, /\bSEQ_KEYSET_SORT\b/, `${r.file} asks for the keyset filter and does not use its sort`);
    }
  });

  it('at least five files import the keyset module (floor), so the rules above are over something', () => {
    const importers = sources.filter(s => s.file !== KEYSET && IMPORTS_KEYSET.test(s.text)).map(s => s.file);
    assert.ok(importers.length >= 5, `${importers.length} importer(s): ${importers.join(', ')}`);
  });
});

describe('the keyset indexes have one declaration', () => {
  /** An index declaration on seq alone, or on type and seq, by either spelling this repo uses. */
  const BARE = /(?:\bcreateIndex\(\s*|\bkeys\s*:\s*)\{\s*(?:type\s*:\s*1\s*,\s*)?seq\s*:\s*1\s*\}/g;

  it('the scan sees index declarations at all (floor)', () => {
    const declarations = sources.reduce((n, s) => n + (s.text.match(/\bcreateIndex\(|\bkeys\s*:\s*\{/g) ?? []).length, 0);
    assert.ok(declarations >= 10, `only ${declarations} index declaration(s) found: the scan broke`);
  });

  it('SEQ_KEYSET_INDEXES declares { seq: 1, _id: 1 } and { type: 1, seq: 1, _id: 1 }', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} does not exist yet`);
    const decl = a.text.match(/export\s+const\s+SEQ_KEYSET_INDEXES\b[\s\S]*?;\s*$/m)?.[0] ?? '';
    assert.ok(decl, 'SEQ_KEYSET_INDEXES is not declared');
    assert.match(decl, /seq\s*:\s*1\s*,\s*_id\s*:\s*1/, 'the compound { seq: 1, _id: 1 } is not declared');
    assert.match(decl, /type\s*:\s*1\s*,\s*seq\s*:\s*1\s*,\s*_id\s*:\s*1/, 'the tombstone compound { type: 1, seq: 1, _id: 1 } is not declared');
  });

  it('no other declaration of { seq: 1 } or { type: 1, seq: 1 } remains: the compound serves them, and a second index costs every write', () => {
    const left = sources.flatMap(s => [...s.text.matchAll(BARE)].map(m => locate(s.file, m.index)));
    assert.deepEqual(left, [], 'LINK_INDEXES and the lifecycle each still declare the index the keyset replaces');
  });
});
