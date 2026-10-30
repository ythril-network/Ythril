/**
 * Every place server code orders or ranges by `pos` builds its position through ONE module, `util/position-keyset.ts` (bundle-81, design rev 8 §6),
 * or is named here with the reason it is not a position reader. The successor of `every-seq-paged-reader-goes-through-the-keyset` (bundle-52, Q-277,
 * Q-435): paging moved from the seq a record carries to the position it landed at, and the rule moved with it.
 *
 * ## The rule, and the defect it ends
 *
 * A position read needs three things and each is the one a hand-written reader drops: the CAP (`settledPositionCap`: a position a write has taken and
 * not yet committed must stop every reader below it, or a puller stores the highest `through` it was handed and never comes back for the held record),
 * the TIE (the legacy band shares a position between a relayed record and its author's, so a cursor is the pair `(pos, _id)` and a read of `pos > last`
 * loses the tail of a run at every page boundary) and the caller's extra filter composed with `$and` (never spread beside the guard). They live in
 * `readAfterPosition` / `positionKeysetFilters`, with the sort `POSITION_KEYSET_SORT`; the index is one declaration in `spaces/space-indexes.ts`.
 *
 * ## How the set is found (and why it is not a list of shapes)
 *
 * From the TYPE-CHECKED program (`_field-orderings.mjs`, asked about `pos`): every SLOT a value is ordered by, each resolved back to the literal it came
 * from, plus every range on `pos`. What it cannot resolve it reports as `unresolved`, and an unresolved slot FAILS unless it is named below. Nothing is
 * dropped, and every number asserted is a floor.
 *
 * ## What is allowed, by ORIGIN and not by file
 *
 * An ordering or range is allowed when its literal is DECLARED in `util/position-keyset.ts`. Anything else is a named exemption below, each with a reason
 * and, where the reason is checkable, a check that holds the code to it.
 *
 * ## Exemptions, each with its reason
 *
 * - `highestStored` (`util/index-top.ts`): `sort({ [field]: -1 }).limit(1)`, the MAXIMUM, which seeds the position clock. The check asks for the `limit(1)`.
 * - `matchFreshWrites`: `$sort { pos: -1 }` followed by `$limit`, a newest window. The check asks for the `$limit` stage after it.
 * - the Brain listings: `LANDING_ORDER` (`brain/list-sort.ts`), a TOTAL order that ends in `_id`, paged by `skip`, so no page is a position and a tie
 *   cannot lose a row. The check asks that the literal ends in `_id`, that it is that constant, and that a read's chain has the `skip`.
 * - `toMongoSort`: the sort key is the caller's field, a computed key. It is safe while `SORTABLE_FIELDS` has no `pos`, which is asserted below.
 * - `pruneTombstonesToFloor`: a delete by bound, not a read. The check asks that the range is an argument of a `deleteMany`.
 *
 * Run: node --test testing/standalone/every-position-paged-reader-goes-through-readAfterPosition.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import { fieldOrderings } from './_field-orderings.mjs';
import { serverProgram } from '../_shared/server-program.mjs';
import { ts, walkEveryNode } from '../_shared/syntax-tree.mjs';

const KEYSET = 'server/src/util/position-keyset.ts';
const CLOCK = 'server/src/util/position-clock.ts';
const INDEXES = 'server/src/spaces/space-indexes.ts';

const raw = readTrackedSources('server/src', { specs: false });
const sources = raw.map(s => ({ file: s.file, text: stripComments(s.text) }));
/** The original text: the checker's line numbers are against it, and `stripComments` drops whole comment lines. */
const rawByFile = new Map(raw.map(s => [s.file, s.text]));
const byFile = new Map(sources.map(s => [s.file, s]));

const { entries, slotCount } = fieldOrderings('pos', KEYSET);
const byKind = (kind) => entries.filter(e => e.kind === kind);

/** A literal that ends in `_id` orders totally: no two rows tie, so a page by `skip` cannot lose or repeat one. */
const endsInId = (e) => (e.keys.at(-1) === '_id' ? null : `its literal (${e.literalAt}) ends in \`${e.keys.at(-1)}\`, not \`_id\`: the order is not total`);
/** The read the ordering belongs to is paged by `skip`: a `.skip(` on the chain, or in the function (a cursor sorted in one statement, paged in the next). */
const pagedBySkip = (e) => {
  if (e.slot !== '.sort(argument)' || e.after.some(a => a.startsWith('skip('))) return null;
  return /\.skip\(/.test(bodyOf(rawByFile.get(e.file) ?? '', e.function)) ? null : 'the read it sorts is not paged by `skip`';
};
/** The ordering is the one named constant, so a second, hand-written ordering in the same function is not excused by it. */
const viaConstant = (name) => (e) => (e.via.includes(name) ? null : `the ordering is not ${name} (it is the literal at ${e.literalAt}): the exemption is for that one value`);
/** The literal is written as a spread of the named constant (`{ ...LANDING_ORDER }`), read from the line the checker names. */
const spreadsConstant = (name) => (e) => {
  const [file, line] = e.literalAt.split(/:(?=\d+$)/);
  const text = rawByFile.get(file)?.split('\n')[Number(line) - 1] ?? '';
  return new RegExp(`\\.\\.\\.\\s*${name}\\b`).test(text) ? null : `the literal at ${e.literalAt} is not a spread of ${name}`;
};
const allOf = (...checks) => (e) => checks.reduce((failure, c) => failure ?? c(e), null);
const inDelete = (e) => (e.inCalls.includes('deleteMany') ? null : `the range is not an argument of a \`deleteMany\` (inside ${e.inCalls.join(', ') || 'nothing'})`);
const LISTING = 'a Brain list\'s default order, `{ ...LANDING_ORDER }`: a total order (ends in `_id`) paged by `skip`, for a user listing, not a position';

/**
 * Orderings, ranges and unresolved slots that are not the keyset module's, each with why it is not a position reader.
 *
 * `by: 'slot'` keys on where the value is ORDERED by, `by: 'origin'` on where the literal or the unresolvable thing is written (one `toMongoSort` is
 * the origin of every listing's unresolved slot, and naming it once is the honest count). `holds` returns a failure sentence, or `null`.
 */
const EXEMPT = [
  {
    file: 'server/src/util/index-top.ts', fn: 'highestStored', kind: 'unresolved', by: 'origin',
    why: 'the maximum of a field across collections (the highest position, which seeds the clock): a descending sort capped at one row, so there is no next page and a tie cannot lose a record a later page would serve',
    holds: (e) => (e.after === undefined || e.after.includes('limit(1)') ? null : `the chain after the sort is [${e.after.join(', ')}], with no limit(1): it is a read, not a maximum`),
  },
  {
    file: 'server/src/brain/fresh-writes.ts', fn: 'matchFreshWrites', kind: 'ordering', by: 'slot',
    why: 'the newest-writes window: `$sort { pos: -1 }` then `$limit`, a bounded window, not a position, so there is no next page',
    holds: (e) => (e.after.includes('$limit') ? null : `the stages after the $sort are [${e.after.join(', ')}], with no $limit`),
  },
  ...['listChrono', 'listEdges', 'listEntities', 'listFacts'].map((fn) => ({
    file: `server/src/brain/${{ listChrono: 'chrono', listEdges: 'edges', listEntities: 'entities', listFacts: 'fact' }[fn]}.ts`, fn, kind: 'ordering', by: 'slot',
    why: LISTING, holds: allOf(spreadsConstant('LANDING_ORDER'), endsInId, pagedBySkip),
  })),
  {
    // Review's list of forks (bundle-81 slice I4): a user listing in landing order, as the Brain lists are, paged by `$skip` inside one `$facet` with its total.
    file: 'server/src/brain/forks.ts', fn: 'forksOfSpace', kind: 'ordering', by: 'slot',
    why: 'Review\'s list of forks: `{ ...LANDING_ORDER }`, a total order (ends in `_id`) paged by `$skip`, for a user listing, not a position',
    holds: allOf(spreadsConstant('LANDING_ORDER'), endsInId,
      (e) => (/\$skip:/.test(bodyOf(rawByFile.get(e.file) ?? '', e.function)) ? null : 'the list is not paged by `$skip`')),
  },
  {
    file: 'server/src/brain/list-sort.ts', fn: '<module>', kind: 'ordering', by: 'origin',
    why: 'LANDING_ORDER itself, reached through DEFAULT_QUERY_SORT by `queryBrain`, the query tool and the cross-space comparator: one total order (ends in `_id`) paged by `skip`',
    holds: allOf(viaConstant('LANDING_ORDER'), endsInId),
  },
  {
    file: 'server/src/brain/list-sort.ts', fn: 'toMongoSort', kind: 'unresolved', by: 'origin',
    why: 'the key is the caller\'s `sort.field`, validated by `parseSortParam` against `SORTABLE_FIELDS`, which names no `pos` (asserted below), and `_id` is appended so the order is total',
    holds: (e) => (e.keys.at(-1) === '_id' ? null : 'toMongoSort no longer ends its sort in `_id`'),
  },
  {
    file: 'server/src/brain/tombstone-prune.ts', fn: 'pruneTombstonesToFloor', kind: 'range', by: 'slot',
    why: 'the prune: delete every tombstone below the position every peer has acknowledged. A delete by bound, not a read',
    holds: inDelete,
  },
  {
    file: 'server/src/brain/gone-entity-references.ts', fn: 'takeBackReferencesWrittenHere', kind: 'range', by: 'slot',
    why: 'the delete\'s settle: rows THIS instance landed at or after the position the removal began (less a lookback), to take back as stragglers. A one-off bound on what is deleted, not a page of positions a reader continues',
    holds: (e) => (/removalBegan\s*-\s*SETTLE_LOOKBACK_MICROS/.test(bodyOf(rawByFile.get(e.file) ?? '', e.function)) ? null : 'the range is not the removal\'s start position less the lookback'),
  },
];

const exemptionFor = (e) => EXEMPT.find(x => x.kind === e.kind
  && (x.by === 'slot' ? x.file === e.file && x.fn === e.function : x.file === e.origin && x.fn === e.originFunction));

/** The verdict on one entry: `{ ok: true, why }`, or `{ ok: false, problem }`. */
function verdict(e) {
  if (e.kind !== 'unresolved' && e.origin === KEYSET) return { ok: true, why: 'declared in the keyset module' };
  const x = exemptionFor(e);
  if (!x) return { ok: false, problem: `${e.kind} at ${e.file}:${e.line} in ${e.function} (${e.slot ?? e.why}); the literal is at ${e.literalAt}${e.via.length ? ` via ${e.via.join(' > ')}` : ''}${e.kind === 'unresolved' ? ` - ${e.why}` : ''}` };
  const failure = x.holds?.(e) ?? null;
  return failure ? { ok: false, problem: `${e.file}:${e.line} in ${e.function} is exempt as "${x.why}", and ${failure}` } : { ok: true, why: x.why };
}

describe('the orderings are derived from the type-checked program, and the derivation sees what it claims to', () => {
  it('finds slots, orderings and ranges above a floor, so a broken checker cannot pass by finding none', () => {
    assert.ok(slotCount >= 40, `only ${slotCount} ordering slots found: the slot walk has stopped matching`);
    assert.ok(byKind('ordering').length >= 8, `only ${byKind('ordering').length} pos orderings resolved: a resolver step broke`);
    assert.ok(byKind('range').length >= 3, `only ${byKind('range').length} pos ranges found: the range walk broke`);
    assert.ok(byKind('ordering').some(e => e.origin === KEYSET), 'no ordering resolves to a literal in the keyset module (the sort in readAfterPosition is one)');
    assert.ok(byKind('range').some(e => e.origin === KEYSET), 'no range resolves into the keyset module (positionKeysetFilters has two)');
  });

  it('sees the spellings a regex would miss: LANDING_ORDER spread in a ternary, DEFAULT_QUERY_SORT through the default parameter, and its use in the query tool', () => {
    const ternary = entries.find(e => e.kind === 'ordering' && e.file === 'server/src/brain/edges.ts' && e.function === 'listEdges');
    assert.ok(ternary, 'the `sort ? toMongoSort(sort) : { ...LANDING_ORDER }` ternary in listEdges is not found');
    const viaDefault = entries.filter(e => e.kind === 'ordering' && e.file === 'server/src/brain/query.ts' && e.function === 'queryBrain' && e.via.includes('DEFAULT_QUERY_SORT'));
    assert.ok(viaDefault.some(e => e.slot.startsWith('the default of parameter')), 'DEFAULT_QUERY_SORT as the default of queryBrain\'s `sort` parameter is not found');
    assert.ok(viaDefault.some(e => e.slot === '.sort(argument)'), 'the `.sort(sort)` in queryBrain is not traced back to DEFAULT_QUERY_SORT through the default parameter');
    assert.ok(viaDefault.every(e => e.via.includes('LANDING_ORDER')), 'DEFAULT_QUERY_SORT is not resolved through to LANDING_ORDER');
    const imported = entries.filter(e => e.kind === 'ordering' && e.file === 'server/src/mcp/tools/filter.ts' && e.via.includes('DEFAULT_QUERY_SORT'));
    assert.ok(imported.length >= 1, 'the query tool\'s use of the imported DEFAULT_QUERY_SORT is not found');
    assert.ok(imported.every(e => e.origin === 'server/src/brain/list-sort.ts'), 'the imported constant is not resolved to its declaration in brain/list-sort.ts');
  });

  it('resolves a computed key to `unresolved` rather than dropping it (toMongoSort and highestStored are the two today)', () => {
    const unresolved = byKind('unresolved');
    assert.ok(unresolved.length >= 1, 'no unresolved slot: toMongoSort\'s computed `[sort.field]` key is no longer reported, so the fail-closed path is not exercised');
    const NAMED = [['server/src/brain/list-sort.ts', 'toMongoSort'], ['server/src/util/index-top.ts', 'highestStored']];
    assert.ok(unresolved.every(e => NAMED.some(([file, fn]) => e.origin === file && e.originFunction === fn)),
      `an unresolved slot that is neither toMongoSort nor highestStored: ${unresolved.filter(e => !NAMED.some(([, fn]) => e.originFunction === fn)).map(e => `${e.file}:${e.line}`).join(', ')}`);
  });
});

describe('every ordering and range on pos is the keyset module\'s, or named with its reason', () => {
  it('each one resolves to a literal declared in util/position-keyset.ts, or to a named exemption whose check holds', () => {
    const problems = entries.map(verdict).filter(v => !v.ok).map(v => v.problem);
    assert.deepEqual(problems, [],
      'these order or range by pos without the keyset module. A position is the pair (pos, _id) read by `readAfterPosition` (cap, tie and the caller\'s filter inside it); '
      + 'a sort on pos alone orders a tie of the legacy band by whatever the storage engine likes, so the next page cannot continue it. If it is a maximum, a window, '
      + 'a total order paged by skip, or a delete by bound, name it in EXEMPT with the reason and the check that holds the code to it:');
  });

  it('every exemption still names a real site (a stale exemption exempts nothing and says so)', () => {
    const stale = EXEMPT.filter(x => !entries.some(e => exemptionFor(e) === x)).map(x => `${x.file}:${x.fn} (${x.kind})`);
    assert.deepEqual(stale, [], 'these exemptions match no ordering, range or unresolved slot any more: delete them, or the code moved');
  });

  it('toMongoSort\'s computed key can never be pos: SORTABLE_FIELDS names no `pos`', () => {
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
    assert.ok(!names.includes('pos'), 'SORTABLE_FIELDS names `pos`: toMongoSort would then let a caller order a listing by pos alone, which no answer may reveal (ORDER_ONLY_FIELDS)');
    assert.ok(!names.includes('seq'), 'SORTABLE_FIELDS names `seq`: a listing ordered by version alone is not the landing order, and a tie of the legacy band is ordered by the engine');
  });
});

describe('the keyset module is the one place a position is built', () => {
  it('server/src/util/position-keyset.ts declares the sort, the filters, the read and the cursor codec', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} is not tracked`);
    for (const name of ['positionKeysetFilters', 'POSITION_KEYSET_SORT', 'readAfterPosition', 'encodePositionCursor', 'decodePositionCursor']) {
      assert.match(a.text, new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`), `${KEYSET} does not export ${name}`);
    }
  });

  it('the extra filter is never spread into the position filter (a spread lets a future key overwrite the guard)', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} does not exist`);
    assert.doesNotMatch(a.text, /\.\.\.\s*(?:extra|extraFilter|ownedFilter|pushFilter)\b/, `${KEYSET} spreads the extra filter`);
    // The RULE is "an intersection, never a spread", not one spelling of it: a literal `$and`, or `andPredicates` - which is then itself held to the rule.
    const viaAnd = /\$and\b/.test(a.text);
    const viaHelper = /\bandPredicates\s*\(/.test(a.text) && /from\s+['"][^'"]*\band-predicates\.js['"]/.test(a.text);
    assert.ok(viaAnd || viaHelper, `${KEYSET} must compose the extra filter by $and, directly or through andPredicates`);
    if (viaHelper) {
      const helper = byFile.get('server/src/db/and-predicates.ts');
      assert.ok(helper, 'db/and-predicates.ts is not tracked: the keyset module delegates the intersection to it');
      assert.match(helper.text, /\{\s*\$and\s*:/, 'andPredicates no longer builds an $and, so the keyset filters are no longer an intersection');
    }
    for (const s of sources) {
      const spread = s.text.match(/positionKeysetFilters\s*\([^;]*\.\.\./);
      assert.equal(spread, null, `${s.file} spreads into a positionKeysetFilters call`);
    }
  });

  it('readAfterPosition asks the space\'s readiness and takes the cap before either find, inside itself', () => {
    const a = byFile.get(KEYSET);
    assert.ok(a, `${KEYSET} does not exist`);
    const body = a.text.slice(a.text.indexOf('export async function readAfterPosition'));
    assert.ok(body.length > 100, 'readAfterPosition is not found in the keyset module');
    const ready = body.search(/\bassertPositionsReady\s*\(/);
    const cap = body.search(/\bsettledPositionCap\s*\(/);
    const find = body.search(/\.find\s*\(/);
    assert.ok(ready >= 0 && cap >= 0 && find >= 0, 'readAfterPosition lost its readiness check, its cap or its find');
    assert.ok(ready < cap && cap < find, 'the order is not readiness, then the cap, then the finds: a position stamped between them would be skipped');
  });
});

describe('the horizon and the filters have named callers', () => {
  /** Every use of `settledPositionCap` outside its definition, by file: the cap is applied in the places below and nowhere else. */
  const CAP_CALLERS = new Map([
    [KEYSET, 'the position reader: one cap for both finds, taken before either'],
    ['server/src/sync/served-watermark.ts', 'the served mark cannot exceed the cap (`ownPositionMark`), so a restart cannot seed a clock below what was served'],
    ['server/src/files/tombstones.ts', 'the file-tombstone stream\'s own cap (`settledPositionCap(spaceId)`), the one reader of that stream'],
  ]);
  const callers = () => sources.filter(s => s.file !== CLOCK && /\bsettledPositionCap\b/.test(s.text)).map(s => s.file);

  it('`settledPositionCap` has no caller outside the ones named, each with its reason', () => {
    const strangers = callers().filter(f => !CAP_CALLERS.has(f));
    assert.deepEqual(strangers, [], 'a reader that bounds itself by its own cap reads straight through an open hold: take the cap in readAfterPosition, or name the file here with why');
  });

  it('every named cap caller still calls it (a stale entry excuses nothing)', () => {
    const live = new Set(callers());
    assert.deepEqual([...CAP_CALLERS.keys()].filter(f => !live.has(f)), [], 'these files no longer use settledPositionCap: delete their entries');
  });

  it('every file that asks the module for a filter also sorts with POSITION_KEYSET_SORT; one that asks for the READ gets the sort inside it', () => {
    const askers = sources.filter(s => s.file !== KEYSET && /\b(?:positionKeysetFilters|readAfterPosition)\b/.test(s.text));
    assert.ok(askers.length >= 1, 'no file calls positionKeysetFilters or readAfterPosition');
    for (const r of askers.filter(a => /\bpositionKeysetFilters\b/.test(a.text))) {
      assert.match(r.text, /\bPOSITION_KEYSET_SORT\b/, `${r.file} asks for the keyset filter and does not use its sort`);
    }
  });

  it('at least five files call readAfterPosition (floor), so the rules above are over something', () => {
    const readers = sources.filter(s => s.file !== KEYSET && /\breadAfterPosition\s*[<(]/.test(s.text)).map(s => s.file);
    assert.ok(readers.length >= 5, `${readers.length} reader(s): ${readers.join(', ')}`);
  });
});

describe('the position index has one declaration', () => {
  /** An index declaration on pos by either spelling this repo uses. */
  const DECLARATION = /(?:\bcreateIndex\(\s*|\bkeys\s*:\s*)\{\s*(?:type\s*:\s*1\s*,\s*)?pos\s*:\s*1[^}]*\}/g;
  const locate = (file, index) => `${file}:${byFile.get(file).text.slice(0, index).split('\n').length}`;

  it('the scan sees index declarations at all (floor)', () => {
    const declarations = sources.reduce((n, s) => n + (s.text.match(/\bcreateIndex\(|\bkeys\s*:\s*\{/g) ?? []).length, 0);
    assert.ok(declarations >= 10, `only ${declarations} index declaration(s) found: the scan broke`);
  });

  it('{ pos: 1, _id: 1 } is declared once, for every record collection, and not as a partial index', () => {
    const found = sources.flatMap(s => [...s.text.matchAll(DECLARATION)].map(m => ({ at: locate(s.file, m.index), file: s.file, text: m[0] })));
    assert.deepEqual(found.map(f => f.file), [INDEXES], `the position index is declared in: ${found.map(f => f.at).join(', ')}`);
    assert.match(found[0].text, /pos\s*:\s*1\s*,\s*_id\s*:\s*1/, 'the declared index is not the compound { pos: 1, _id: 1 }');
    const line = byFile.get(INDEXES).text.split('\n').find(l => DECLARATION.test(l) || /pos\s*:\s*1\s*,\s*_id\s*:\s*1/.test(l)) ?? '';
    assert.doesNotMatch(line, /partialFilterExpression/, 'the position index is partial: a sort that names no predicate ignores it, and a landing-order list would sort in memory');
    assert.match(byFile.get(INDEXES).text, /SEQ_CARRYING\s*\.map\(/, 'the declaration is no longer made for every record collection (SEQ_CARRYING)');
  });
});
