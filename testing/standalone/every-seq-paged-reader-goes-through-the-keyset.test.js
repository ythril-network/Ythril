/**
 * Every place server code orders or ranges by `seq` builds its position through ONE module, `util/seq-keyset.ts`
 * (bundle-52, Q-277), or is named here with the reason it is not a position reader (Q-435, bundle-157).
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
 * ## How the set is found (and why it is not a list of shapes)
 *
 * This gate's title said "every" and its body read four regular expressions. It missed a ternary
 * (`brain/edges.ts`: `.sort(sort ? toMongoSort(sort) : { seq: -1, ... })`) and a constant that reaches `.sort` through a default
 * parameter (`DEFAULT_QUERY_SORT`, declared in `brain/query.ts`, defaulted into `queryBrain`, imported by `mcp/tools/filter.ts`
 * and passed on) — both seq orderings, neither a shape. Bundle 81 moves paging from seq to a holder position, and a gate that
 * cannot see a reader cannot hold it to the move (CLAUDE.md, "A gate concludes about MORE than it checks").
 *
 * So the set is read from the TYPE-CHECKED program (`_seq-orderings.mjs`, over `_shared/server-program.mjs`): every SLOT a value
 * is ordered by (a `.sort` argument on a non-array, a `sort` / `$sort` / `sortBy` property, a parameter declared `sort`, its default
 * and the argument at each call it is bound at), each resolved back to the literal it came from; plus every range on seq.
 * What it cannot resolve it reports as `unresolved`, and an unresolved slot FAILS unless it is named below. Nothing is dropped.
 *
 * ## What is allowed, by ORIGIN and not by file
 *
 * An ordering or range is allowed when its literal is DECLARED in `util/seq-keyset.ts` (the checker's resolution of the value says
 * where it was written, not which file imports the module: `tombstone-store.ts` imports the module for `isoKeysetSort`, and that must
 * not excuse a hand-written seq sort beside it). Anything else is a named exemption below, keyed by file and enclosing function,
 * each with a reason and, where the reason is checkable, a check that holds the code to it.
 *
 * ## Exemptions, each with its reason
 *
 * - `highestStoredSeq`: `sort({ seq: -1 }).limit(1)`, the MAXIMUM. The check asks for the `limit(1)` on the chain itself, not for
 *   "a limit somewhere in the statement" (which a hand-written position read also has).
 * - `matchFreshWrites`: `$sort { seq: -1 }` followed by `$limit`, a newest window. The check asks for the `$limit` stage after it.
 * - the listings (`listEdges`, `queryBrain`, the query tool's `handle`, `compareQueryOrder`): the default order is a TOTAL order that
 *   ends in `_id` and is paged by `skip`, so no page is a position and a tie cannot lose a row. The check asks that the literal ends
 *   in `_id`, and that a read's chain has the `skip`.
 * - `toMongoSort`: the sort key is the caller's field, a computed key. It is safe while `SORTABLE_FIELDS` has no `seq`, which a
 *   sibling test asserts, so the key can never be one.
 * - ranges that are not pages: the write guard (`seqGuard`) and three deletes below a bound (`deleteSupersededTombstones`,
 *   `applyPeerTombstones`, `pruneTombstonesToFloor`). The check asks that the three are arguments of a `deleteMany`.
 *
 * Run: node --test testing/standalone/every-seq-paged-reader-goes-through-the-keyset.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { KEYSET_FILE, seqOrderings } from './_seq-orderings.mjs';
import { serverProgram } from '../_shared/server-program.mjs';
import { ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const KEYSET = KEYSET_FILE;
const SEQ_UTIL = 'server/src/util/seq.ts';

const sources = readTrackedSources('server/src', { specs: false }).map(s => ({ file: s.file, text: stripComments(s.text) }));
const byFile = new Map(sources.map(s => [s.file, s]));

const { entries, slotCount } = seqOrderings();
const byKind = (kind) => entries.filter(e => e.kind === kind);

/** A literal that ends in `_id` orders totally: no two rows tie, so a page by `skip` cannot lose or repeat one. */
const endsInId = (e) => (e.keys.at(-1) === '_id' ? null : `its literal (${e.literalAt}) ends in \`${e.keys.at(-1)}\`, not \`_id\`: the order is not total`);
const pagedBySkip = (e) => (e.slot === '.sort(argument)' && !e.after.some(a => a.startsWith('skip(')) ? 'the read it sorts is not paged by `skip`' : null);
/** The ordering is the one named constant, so a second, hand-written ordering in the same function is not excused by it. */
const viaConstant = (name) => (e) => (e.via.includes(name) ? null : `the ordering is not ${name} (it is the literal at ${e.literalAt}): the exemption is for that one value`);
const exactly = (...keys) => (e) => (e.keys.join(',') === keys.join(',') ? null : `the literal at ${e.literalAt} is [${e.keys.join(', ')}], not [${keys.join(', ')}]: the exemption is for that one order`);
const allOf = (...checks) => (e) => checks.reduce((failure, c) => failure ?? c(e), null);
const inDelete = (e) => (e.inCalls.includes('deleteMany') ? null : `the range is not an argument of a \`deleteMany\` (inside ${e.inCalls.join(', ') || 'nothing'})`);

/**
 * Orderings, ranges and unresolved slots that are not the keyset module's, each with why it is not a position reader.
 *
 * `by: 'slot'` keys on where the value is ORDERED by, `by: 'origin'` on where the literal or the unresolvable thing is written (one
 * `toMongoSort` is the origin of six slots, and naming it once is the honest count). `holds` returns a failure sentence, or `null`.
 */
const EXEMPT = [
  {
    file: SEQ_UTIL, fn: 'highestStoredSeq', kind: 'ordering', by: 'slot',
    why: 'the maximum stored seq: a newest-first sort capped at one row, so there is no next page and a tie cannot lose a record a later page would serve',
    holds: (e) => (e.after.includes('limit(1)') ? null : `the chain after the sort is [${e.after.join(', ')}], with no limit(1): it is a read, not a maximum`),
  },
  {
    file: 'server/src/brain/fresh-writes.ts', fn: 'matchFreshWrites', kind: 'ordering', by: 'slot',
    why: 'the newest-writes window: `$sort { seq: -1 }` then `$limit`, a bounded window, not a position, so there is no next page',
    holds: (e) => (e.after.includes('$limit') ? null : `the stages after the $sort are [${e.after.join(', ')}], with no $limit`),
  },
  {
    file: 'server/src/brain/edges.ts', fn: 'listEdges', kind: 'ordering', by: 'slot',
    why: 'the edges listing\'s default order: a total order (ends in `_id`) paged by `skip`, for a user listing, not a position',
    holds: allOf(exactly('seq', 'createdAt', '_id'), endsInId, pagedBySkip),
  },
  {
    file: 'server/src/brain/query.ts', fn: 'queryBrain', kind: 'ordering', by: 'slot',
    why: 'the structured query\'s default order, DEFAULT_QUERY_SORT: a total order (ends in `_id`) paged by `skip`, for a user listing, not a position',
    holds: allOf(viaConstant('DEFAULT_QUERY_SORT'), endsInId, pagedBySkip),
  },
  {
    file: 'server/src/brain/query.ts', fn: '<module>', kind: 'ordering', by: 'slot',
    why: 'compareQueryOrder: the same default order as an in-memory comparator for merging a proxy space\'s members; a total order, not a read',
    holds: allOf(viaConstant('DEFAULT_QUERY_SORT'), endsInId),
  },
  {
    file: 'server/src/mcp/tools/filter.ts', fn: 'handle', kind: 'ordering', by: 'slot',
    why: 'the query tool hands DEFAULT_QUERY_SORT to queryBrain and to the merge comparator: the same total order, paged by `skip`',
    holds: allOf(viaConstant('DEFAULT_QUERY_SORT'), endsInId),
  },
  {
    file: 'server/src/brain/list-sort.ts', fn: 'toMongoSort', kind: 'unresolved', by: 'origin',
    why: 'the key is the caller\'s `sort.field`, validated by `parseSortParam` against `SORTABLE_FIELDS`, which names no `seq` (asserted below), and `_id` is appended so the order is total',
    holds: (e) => (e.keys.at(-1) === '_id' ? null : 'toMongoSort no longer ends its sort in `_id`'),
  },
  {
    file: 'server/src/sync/upsert-plan.ts', fn: 'seqGuard', kind: 'range', by: 'slot',
    why: 'the write guard: a stored copy BELOW the arriving seq may be replaced. A condition on a write, not a read that pages',
  },
  {
    file: 'server/src/sync/push-reads.ts', fn: 'deleteSupersededTombstones', kind: 'range', by: 'slot',
    why: 'a delete of the tombstones a record has superseded, each below its own seq: no read is paged by it',
    holds: inDelete,
  },
  {
    file: 'server/src/sync/tombstone-apply.ts', fn: 'applyPeerTombstones', kind: 'range', by: 'slot',
    why: 'a delete of rows at or below the seq the peer tombstone carries, row by row: no read is paged by it',
    holds: inDelete,
  },
  {
    file: 'server/src/brain/tombstone-prune.ts', fn: 'pruneTombstonesToFloor', kind: 'range', by: 'slot',
    why: 'the prune: delete every tombstone at or below the floor every peer has acknowledged. A delete by bound, not a read',
    holds: inDelete,
  },
];

const exemptionFor = (e) => EXEMPT.find(x => x.kind === e.kind
  && (x.by === 'slot' ? x.file === e.file && x.fn === e.function : x.file === e.origin && x.fn === e.originFunction));

/** The verdict on one entry: `{ ok: true, why }`, or `{ ok: false, problem }`. */
function verdict(e) {
  if (e.kind !== 'unresolved' && e.origin === KEYSET) return { ok: true, why: 'declared in the keyset module' };
  const x = exemptionFor(e);
  if (!x) return { ok: false, problem: `${e.kind} at ${e.file}:${e.line} in ${e.function} (${e.slot ?? e.why}); the literal is at ${e.literalAt}${e.via.length ? ` via ${e.via.join(' > ')}` : ''}${e.kind === 'unresolved' ? ` — ${e.why}` : ''}` };
  const failure = x.holds?.(e) ?? null;
  return failure ? { ok: false, problem: `${e.file}:${e.line} in ${e.function} is exempt as "${x.why}", and ${failure}` } : { ok: true, why: x.why };
}

describe('the orderings are derived from the type-checked program, and the derivation sees what it claims to', () => {
  it('finds slots, orderings and ranges above a floor, so a broken checker cannot pass by finding none', () => {
    // Today: 62 slots, 10 orderings, 6 ranges (and 6 unresolved, all `toMongoSort`). The floors sit under them with room for a cleanup.
    assert.ok(slotCount >= 40, `only ${slotCount} ordering slots found: the slot walk has stopped matching`);
    assert.ok(byKind('ordering').length >= 8, `only ${byKind('ordering').length} seq orderings resolved: a resolver step broke`);
    assert.ok(byKind('range').length >= 5, `only ${byKind('range').length} seq ranges found: the range walk broke`);
    assert.ok(byKind('ordering').some(e => e.origin === KEYSET), 'no ordering resolves to a literal in the keyset module (SEQ_KEYSET_SORT is one)');
  });

  it('sees the three spellings the regex gate missed: the edges ternary, DEFAULT_QUERY_SORT through the default parameter, and its use in the query tool', () => {
    const ternary = entries.find(e => e.kind === 'ordering' && e.file === 'server/src/brain/edges.ts' && e.function === 'listEdges');
    assert.ok(ternary, 'the `sort ? toMongoSort(sort) : { seq: -1, ... }` ternary in listEdges is not found');
    const viaDefault = entries.filter(e => e.kind === 'ordering' && e.file === 'server/src/brain/query.ts' && e.function === 'queryBrain' && e.via.includes('DEFAULT_QUERY_SORT'));
    assert.ok(viaDefault.some(e => e.slot.startsWith('the default of parameter')), 'DEFAULT_QUERY_SORT as the default of queryBrain\'s `sort` parameter is not found');
    assert.ok(viaDefault.some(e => e.slot === '.sort(argument)'), 'the `.sort(sort)` in queryBrain is not traced back to DEFAULT_QUERY_SORT through the default parameter');
    const imported = entries.filter(e => e.kind === 'ordering' && e.file === 'server/src/mcp/tools/filter.ts' && e.via.includes('DEFAULT_QUERY_SORT'));
    assert.ok(imported.length >= 1, 'the query tool\'s use of the imported DEFAULT_QUERY_SORT is not found');
    assert.ok(imported.every(e => e.origin === 'server/src/brain/query.ts'), 'the imported constant is not resolved to its declaration in brain/query.ts');
  });

  it('resolves a computed key to `unresolved` rather than dropping it (toMongoSort is the one today)', () => {
    const unresolved = byKind('unresolved');
    assert.ok(unresolved.length >= 1, 'no unresolved slot: toMongoSort\'s computed `[sort.field]` key is no longer reported, so the fail-closed path is not exercised');
    assert.ok(unresolved.every(e => e.origin === 'server/src/brain/list-sort.ts' && e.originFunction === 'toMongoSort'),
      `an unresolved slot that is not toMongoSort: ${unresolved.filter(e => e.originFunction !== 'toMongoSort').map(e => `${e.file}:${e.line}`).join(', ')}`);
  });
});

describe('every ordering and range on seq is the keyset module\'s, or named with its reason', () => {
  it('each one resolves to a literal declared in util/seq-keyset.ts, or to a named exemption whose check holds', () => {
    const problems = entries.map(verdict).filter(v => !v.ok).map(v => v.problem);
    assert.deepEqual(problems, [],
      'these order or range by seq without the keyset module. A position is the pair (seq, _id) built by `seqKeysetFilters` and `SEQ_KEYSET_SORT`; '
      + 'a sort on seq alone orders a tie by whatever the storage engine likes, so the next page cannot continue it. If it is a maximum, a window, '
      + 'a total order paged by skip, or a delete by bound, name it in EXEMPT with the reason and the check that holds the code to it:');
  });

  it('every exemption still names a real site (a stale exemption exempts nothing and says so)', () => {
    const stale = EXEMPT.filter(x => !entries.some(e => exemptionFor(e) === x)).map(x => `${x.file}:${x.fn} (${x.kind})`);
    assert.deepEqual(stale, [], 'these exemptions match no ordering, range or unresolved slot any more: delete them, or the code moved');
  });

  it('toMongoSort\'s computed key can never be seq: SORTABLE_FIELDS names no `seq`', () => {
    const sf = serverProgram().sourceOf.get('server/src/brain/list-sort.ts');
    assert.ok(sf, 'brain/list-sort.ts is not in the server program');
    const names = [];
    walkEveryNode(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'SORTABLE_FIELDS' && n.initializer) {
        walkEveryNode(n.initializer, (m) => { if (ts.isStringLiteralLike(m)) names.push(m.text); });
      }
    });
    assert.ok(names.length >= 15, `only ${names.length} sortable field names read from SORTABLE_FIELDS: the declaration moved or changed shape`);
    assert.ok(names.includes('createdAt'), 'SORTABLE_FIELDS does not name createdAt: the read found something else');
    assert.ok(!names.includes('seq'), 'SORTABLE_FIELDS names `seq`: toMongoSort would then order a user listing by seq alone, and its exemption is gone');
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
    for (const s of sources) {
      const spread = s.text.match(/seqKeysetFilters\s*\([^;]*\.\.\./);
      assert.equal(spread, null, `${s.file} spreads into a seqKeysetFilters call`);
    }
  });
});

describe('the horizon and the filters have one caller', () => {
  it('`settledSeqRange` has no caller outside the keyset module: the horizon is applied in one place', () => {
    const callers = [];
    for (const s of sources.filter(x => x.file !== KEYSET)) {
      for (const m of s.text.matchAll(/\bsettledSeqRange\b/g)) {
        const definition = s.file === SEQ_UTIL && /function\s+$/.test(s.text.slice(0, m.index));
        if (!definition) callers.push(`${s.file}:${s.text.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.deepEqual(callers, [], 'the definition in util/seq.ts is the only mention outside the keyset module');
  });

  it('every file that asks the module for a filter also sorts with SEQ_KEYSET_SORT; one that asks for the READ gets the sort inside it', () => {
    // `readAfterSeq` is the module's read: both finds, the horizon, the readiness fallback and the sort live inside it, so a caller
    // of it cannot drop the sort. A file that builds its own finds from `seqKeysetFilters` has to bring the sort itself.
    const askers = sources.filter(s => s.file !== KEYSET && /\b(?:seqKeysetFilters|readAfterSeq)\b/.test(s.text));
    assert.ok(askers.length >= 1, 'no file calls seqKeysetFilters or readAfterSeq yet');
    for (const r of askers.filter(a => /\bseqKeysetFilters\b/.test(a.text))) {
      assert.match(r.text, /\bSEQ_KEYSET_SORT\b/, `${r.file} asks for the keyset filter and does not use its sort`);
    }
  });

  it('at least five files import the keyset module (floor), so the rules above are over something', () => {
    const importers = sources.filter(s => s.file !== KEYSET && /\bfrom\s+['"][^'"]*\bseq-keyset\.js['"]/.test(s.text)).map(s => s.file);
    assert.ok(importers.length >= 5, `${importers.length} importer(s): ${importers.join(', ')}`);
  });
});

describe('the keyset indexes have one declaration', () => {
  /** An index declaration on seq alone, or on type and seq, by either spelling this repo uses. */
  const BARE = /(?:\bcreateIndex\(\s*|\bkeys\s*:\s*)\{\s*(?:type\s*:\s*1\s*,\s*)?seq\s*:\s*1\s*\}/g;
  const locate = (file, index) => `${file}:${byFile.get(file).text.slice(0, index).split('\n').length}`;

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
