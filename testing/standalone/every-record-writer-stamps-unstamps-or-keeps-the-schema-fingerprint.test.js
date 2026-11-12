/**
 * Every function that writes a record collection says what it does with `schemaFingerprint`: it STAMPS (validates and spreads the
 * op `stampOp` / `stampOpIfUnmoved` returns), UNSTAMPS (changes schema-relevant content without a conforming validation and spreads
 * `UNSTAMP`), KEEPS (changes no schema-relevant content and never names the field), or is an ARRIVAL (keeps the sender's stamp)
 * (Q-736, bundle-265 design revision 4, sections 2 and 4.1).
 *
 * ## The rule
 *
 * A stamp means the record conforms AS STORED to the schema with that fingerprint (D-N2/D-N3; owner D-77: "stamp on next update of
 * the record so strict schema adherence is guaranteed"). So the fingerprint a writer stamps must come from the very meta its
 * classification read, read ONCE (`readMetaForWrite(spaceId)` = `{meta, stamp}`), and the op is computed from that pair and the
 * check (`stampOp(write, check)`: `$set` when `check.all` is empty, `UNSTAMP` otherwise). A second meta read inside the same write
 * (`getSpaceMeta`, `isFunctionalLabel(spaceId…)`, `guardFor(spaceId…)`) can see another schema than the one stamped, which is the
 * defect this gate exists to refuse (T2, Q1: `plan-edge.ts` read meta three times in one write). Inside a `writeAtReadVersion`
 * closure the row may have moved since it was validated, so only `stampOpIfUnmoved` may be spread there (DI-4).
 *
 * ## What is derived
 *
 * The WRITERS: `recordWrites` (`_record-writes.mjs`) over `BRAIN_COLLECTIONS` minus `files` and `links` (T3, R4-14: a link row has no
 * schema and carries no stamp field), grouped by enclosing function. Every one of them must sit in exactly one class below, and an
 * entry naming a function that no longer writes fails (a stale entry outlives nothing it describes). The STAMP entries name the
 * functions that hold the validation (`stampers`) and the named hand-offs the pair travels through (`HAND_OFFS`: `finishInsert`,
 * `edgeRefusal`, `classifyKeep`); everything else is read from the source with comments stripped.
 *
 * ## Mutation runs (T1)
 *
 * The gate is proven on planted defects: the index is rebuilt from in-memory sources (`indexSources`) with one `stampOp(` removed
 * from `plan-fact.ts`, with a `getSpaceMeta(` added to `planEdge`, and with the `UNSTAMP` spread removed from `chrono-redaction.ts`,
 * and each copy must fail the classification.
 *
 * ## Red on the unchanged code (ce37b83a)
 *
 * `spaces/schema-stamp.ts` does not exist, so no stamper reads `readMetaForWrite` and none spreads an op; `planEdge` reads meta at
 * `:350` and through `guardFor` at `:418`, `edgeRefusal` at `:334`/`:336`, `classifyKeep` at `fork-keep.ts:44`; redaction and relink
 * spread no `UNSTAMP`. The mutation cases are red because the code they would mutate holds no op to remove (their precondition).
 *
 * Run: node --test testing/standalone/every-record-writer-stamps-unstamps-or-keeps-the-schema-fingerprint.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexSources } from './_call-graph.mjs';
import { recordWrites } from './_record-writes.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { moduleOrNull } from './_b81c-door.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types.js');
/** The collections this rule governs: every record collection but the two that carry no schema of their own. */
const GOVERNED = BRAIN_COLLECTIONS.filter(c => c !== 'files' && c !== 'links');

const S = (k) => `server/src/${k}`;
const STAMP_MODULE = 'server/src/spaces/schema-stamp.ts';
/** The stamp module's surface: a KEEP or ARRIVAL writer reaches none of it, and only it spells the field. */
const STAMP_API = ['readMetaForWrite', 'stampOp', 'stampOpIfUnmoved', 'UNSTAMP'];
/** A second meta read inside a write: each can see another schema than the one the write stamps (T2, Q1). */
const SECOND_READS = ['getSpaceMeta', 'isFunctionalLabel', 'guardFor'];
/** A classification or validation call: its first argument is the meta it judged with, and that must be the write's own. */
const VALIDATES = /(?<![.\w$])(classify\w*|validate(?:Entity|Fact|Chrono|Edge)\w*)\s*\(/g;

/**
 * The named hand-offs (T1): the pair `{meta, stamp}` and the check travel through these, so they are read as part of the write.
 * `param` is the name the hand-off receives the pair under; `op` says the hand-off itself spreads the op.
 */
const HAND_OFFS = {
  [S('brain/write-plan/plan-steps.ts:finishInsert')]: { param: 'write', op: 'stampOp', why: 'an insert gets the field or nothing from the pair its planner validated with' },
  [S('brain/write-plan/plan-edge.ts:edgeRefusal')]: { param: 'write', op: null, why: 'classifies an edge with the pair its planner read and returns it with the check' },
  [S('brain/fork-keep.ts:classifyKeep')]: { param: 'write', op: null, why: 'classifies the keep with the pair the keep-writer read and returns it with the check' },
};

const HAND_OFF_NAMES = new Set(Object.keys(HAND_OFFS).map(k => k.slice(k.lastIndexOf(':') + 1)));

/**
 * STAMP writers:`stampers` hold the one `readMetaForWrite` read and the classification; `ops` spread the op (`IfUnmoved` where the
 * row may have moved since it was validated). A writer whose plans are built elsewhere names the builders.
 */
const STAMP = {
  [S('brain/write-plan/commit.ts:writeStage')]: {
    why: 'writes the plans the four planners built: each planner validates, puts the op in its converge set/unset, and hands the pair to finishInsert',
    stampers: ['plan-fact.ts:planFact', 'plan-entity.ts:planEntity', 'plan-chrono.ts:planChrono', 'plan-edge.ts:planEdge'].map(k => S(`brain/write-plan/${k}`)),
    ops: { form: 'stampOp' },
  },
  [S('brain/fact.ts:updateFact')]: { why: 'the fact update', stampers: [S('brain/fact.ts:updateFact')], ops: { form: 'stampOpIfUnmoved' } },
  [S('brain/entities.ts:updateEntityById')]: { why: 'the entity update', stampers: [S('brain/entities.ts:updateEntityById')], ops: { form: 'stampOpIfUnmoved' } },
  [S('brain/chrono.ts:updateChrono')]: { why: 'the chrono update', stampers: [S('brain/chrono.ts:updateChrono')], ops: { form: 'stampOpIfUnmoved' } },
  [S('brain/edges.ts:updateEdgeById')]: { why: 'the edge update, its relabel included (the op rides rekeyEdge\'s alsoSet/alsoUnset)', stampers: [S('brain/edges.ts:updateEdgeById')], ops: { form: 'stampOpIfUnmoved' } },
  [S('brain/fork-keep.ts:writeKeptBody')]: { why: 'Review\'s keep writes the parent through writeAtReadVersion after classifyKeep', stampers: [S('brain/fork-keep.ts:writeKeptBody')], ops: { form: 'stampOpIfUnmoved' } },
  [S('brain/merge.ts:relinkAndAbsorb')]: {
    why: 'the merge survivor: executeMerge validates, relinkAndAbsorb writes on the version it read in the transaction (survivorVersion)',
    stampers: [S('brain/merge.ts:executeMerge')], ops: { form: 'stampOpIfUnmoved', in: [S('brain/merge.ts:relinkAndAbsorb')], names: 'survivorVersion' },
  },
};

/** UNSTAMP writers (D-N1..D-N4): each changes schema-relevant content and validates nothing, so it removes the stamp. */
const UNSTAMP = {
  [S('brain/chrono-redaction.ts:redactLapsedChronoContent')]: 'redaction removes `description` (REDACTED_CHRONO_FIELDS), which a space or type rule may read (`self.description`)',
  [S('brain/relink-references.ts:relinkEdgesOfRecord')]: 'relink moves an edge onto new ends (re-keyed or in place), which an endpoint-kind rule or a functional label may forbid there',
};

const keep = (reason, keys) => Object.fromEntries(keys.map(k => [S(k), reason]));
/** KEEP writers: none changes schema-relevant content, so none may name the field or reach the stamp module. */
const KEEP = {
  ...keep('removes rows (a delete, a tombstone\'s row, a whole collection): no row is left whose stamp could be wrong', [
    'brain/candidate-prune.ts:pruneCandidateCollection', 'brain/tombstones.ts:removeWithTombstones', 'spaces/lifecycle.ts:wipeSpaceUnqueued',
    'sync/tombstone-apply.ts:applyPeerTombstones', 'sync/tombstone-apply.ts:cascadeToForks', 'sync/positions-rollback.ts:rollBackForks',
  ]),
  ...keep('writes a retention stamp, a local-only date no schema declares', [
    'brain/chrono-redaction.ts:backfillTypedExpiry', 'brain/retention-stamp-heal.ts:healStoredStamps',
  ]),
  ...keep('copies the stored row to the id its identity derives; what a caller changes rides alsoSet/alsoUnset and is checked at that caller', [
    'brain/edge-rekey.ts:rekeyEdges',
  ]),
  ...keep('a fork re-mint or an orphan resolve copies the stored row as it is, stamp or none', [
    'brain/forks.ts:remintForks', 'brain/forks.ts:resolveOrphan',
  ]),
  ...keep('writes derived local fields (a vector, matchedText, embedding state): no schema reads them', [
    'brain/suppression-sweep.ts:sweepSuppressedVectors', 'files/derived-fields.ts:writeDerivedFields',
  ]),
  ...keep('writes or clears the write guard marker, a local-only lock', ['brain/write-plan/commit.ts:clearStaleWriteGuard']),
  ...keep('re-keys ids or space ids, or drops a retired array no schema declares: the content a rule reads is unchanged', [
    'db/drop-link-arrays.ts:dropLinkArrays', 'db/rekey-memory-kind-to-fact.ts:rekeyMemoryKindToFact', 'files/rekey-rows.ts:rekeyRows',
    'spaces/_shared.ts:repairStaleSpaceIds',
  ]),
  ...keep('writes landing positions, a decline mark or who delivered a row: local stamps, never body', [
    'sync/delivered-by-backfill.ts:stampCollection', 'sync/positions-owed.ts:carryRows', 'sync/positions-owed.ts:repairRows',
    'sync/positions-rollback.ts:rollBackPositions', 'sync/resolved-elsewhere.ts:writeResolvedElsewhere',
  ]),
};

/** ARRIVAL writers: an arrival keeps the writer's stamp, the writer's claim (D-N5); a restore keeps the backup's. */
const ARRIVAL = {
  [S('sync/arrivals.ts:writeArrivals')]: 'every sync, import and restore arrival lands here and keeps the sender\'s stamp',
  [S('db/restore.ts:backupLoader')]: 'a database restore keeps every stored stamp of the backup',
};

// ── the reading ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server's sources as `moduleIndex` reads them, in hand, so a mutation run can change one file in memory. */
function serverSources() {
  const files = trackedSources(['server/src', 'schema/src'], { untracked: true });
  return new Map(files.map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
}

/** The argument text of the call whose `(` is at `paren` in `body`, split at its top-level commas. */
function argsAt(body, paren) {
  const out = [];
  let depth = 0; let cur = '';
  for (let i = paren + 1; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { out.push(cur.trim()); return { args: out, end: i }; }
      depth--;
    }
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  return { args: out, end: body.length };
}

/** Every call of `name(` in `body`, with its arguments and its offsets. */
function callsOf(body, name) {
  const re = new RegExp(`(?<![.\\w$])${name}\\s*(?:<[^>(;]*>)?\\s*\\(`, 'g');
  return [...body.matchAll(re)].map(m => {
    const paren = m.index + m[0].length - 1;
    return { at: m.index, paren, ...argsAt(body, paren) };
  });
}

/**
 * The findings of the whole classification over one index: one line per broken rule, naming the function. Empty = the rule holds.
 * Built once per index, so the mutation runs ask exactly the question the real run asks.
 */
function classify(index) {
  const findings = [];
  const say = (key, what) => findings.push(`${key.replace('server/src/', '')}: ${what}`);
  const body = (key) => index.bodies.get(key)?.body;

  const records = recordWrites(index, { collections: GOVERNED, floors: { space: 150 }, recordFloor: 5 });
  const writers = [...records.byKey.keys()].sort();

  // Every writer in exactly one class; every entry still a writer.
  const classes = { STAMP, UNSTAMP, KEEP, ARRIVAL };
  for (const w of writers) {
    const in_ = Object.entries(classes).filter(([, m]) => w in m).map(([n]) => n);
    if (in_.length === 0) say(w, 'writes a record collection and is in no class: STAMP, UNSTAMP, KEEP or ARRIVAL, with its reason');
    if (in_.length > 1) say(w, `is in more than one class: ${in_.join(', ')}`);
  }
  for (const [name, map] of Object.entries(classes)) {
    for (const k of Object.keys(map)) if (!writers.includes(k)) say(k, `is a stale ${name} entry: it no longer writes a record collection`);
  }

  // The stamp module exists and spells the field; nothing else in a writer does.
  for (const fn of ['readMetaForWrite', 'stampOp', 'stampOpIfUnmoved']) {
    if (!index.bodies.has(`${STAMP_MODULE}:${fn}`)) say(`${STAMP_MODULE}:${fn}`, 'is not written: there is no one place the pair is read and the op computed');
  }
  if (!/\bUNSTAMP\b/.test(index.sources.get(STAMP_MODULE) ?? '')) say(STAMP_MODULE, 'declares no UNSTAMP: the field is not spelled once');

  const secondReads = (key, text) => {
    for (const r of SECOND_READS) if (callsOf(text, r).length > 0) say(key, `reads meta a second time through ${r}( inside a stamping write (T2, Q1): use the pair's write.meta`);
  };
  const judgesWith = (key, text, meta) => {
    for (const m of text.matchAll(VALIDATES)) {
      // A hand-off is handed the pair (checked below), and a local closure called with nothing (`await classify()`) judges inside itself.
      if (HAND_OFF_NAMES.has(m[1])) continue;
      const { args } = argsAt(text, m.index + m[0].length - 1);
      const first = (args[0] ?? '').replace(/\s+/g, '');
      if (first === '') continue;
      if (!(first === meta || first.startsWith(`${meta}??`))) {
        say(key, `${m[1]}( judges with \`${args[0]}\`, not with \`${meta}\`: the stamp would name a schema the classification did not read`);
      }
    }
  };

  for (const [writer, spec] of Object.entries(STAMP)) {
    for (const st of spec.stampers) {
      const text = body(st);
      if (!text) { say(st, 'is not a function of the tree: a stamper this gate relies on is gone or renamed'); continue; }
      if (/schemaFingerprint/.test(text)) say(st, 'spells schemaFingerprint itself: the stamp is written only through the op the stamp module returns');
      const reads = [...text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*readMetaForWrite\s*\(/g)];
      const allReads = callsOf(text, 'readMetaForWrite');
      if (reads.length !== 1 || allReads.length !== 1) {
        say(st, `reads the pair ${allReads.length} time(s) (bound ${reads.length}): one write reads readMetaForWrite exactly once, into one binding`);
        secondReads(st, text);
        continue;
      }
      const w = reads[0][1];
      secondReads(st, text);
      judgesWith(st, text, `${w}.meta`);
      // A hand-off receives the pair itself, never a meta of another provenance.
      for (const [ho, hs] of Object.entries(HAND_OFFS)) {
        const name = ho.slice(ho.lastIndexOf(':') + 1);
        for (const c of callsOf(text, name)) {
          if (!c.args.some(a => new RegExp(`(?<![\\w$.])${w}(?![\\w$])`).test(a) && !new RegExp(`${w}\\.meta`).test(a))) {
            say(st, `hands ${name}( no \`${w}\` (the pair): ${hs.why}`);
          }
        }
      }
      // The op: spread from the same binding.
      const ownOps = spec.ops.in ? [] : [...callsOf(text, 'stampOp'), ...callsOf(text, 'stampOpIfUnmoved')];
      if (!spec.ops.in) {
        if (ownOps.length === 0) say(st, `spreads no ${spec.ops.form}(: a conforming write lands unstamped and a non-conforming one keeps a stamp that no longer holds`);
        for (const c of callsOf(text, 'stampOp')) if (c.args[0]?.replace(/\s+/g, '') !== w) say(st, `stampOp( is handed \`${c.args[0]}\`, not the pair \`${w}\``);
        for (const c of callsOf(text, 'stampOpIfUnmoved')) if (c.args[2]?.replace(/\s+/g, '') !== w) say(st, `stampOpIfUnmoved( is handed \`${c.args[2]}\` as its pair, not \`${w}\``);
        if (spec.ops.form === 'stampOpIfUnmoved') {
          const closures = callsOf(text, 'writeAtReadVersion');
          if (closures.length === 0) say(st, 'writes through no writeAtReadVersion: the DI-4 rule has nothing to hold');
          for (const c of closures) {
            const inside = text.slice(c.paren, c.end);
            if (callsOf(inside, 'stampOp').length > 0) say(st, 'spreads stampOp( inside a writeAtReadVersion closure: a moved row is written stamped without a validation of what it lands on (DI-4); use stampOpIfUnmoved');
            if (callsOf(inside, 'stampOpIfUnmoved').length === 0) say(st, 'spreads no stampOpIfUnmoved( inside its writeAtReadVersion closure (DI-4)');
          }
          // A relabel re-keys the edge: the op rides the re-key (alsoSet / alsoUnset), or the moved row keeps a stamp of another label.
          for (const c of [...callsOf(text, 'rekeyEdge'), ...callsOf(text, 'rekeyEdges')]) {
            if (!/stampOp|[Ss]tamp/.test(c.args.join(','))) say(st, 'hands the re-key no stamp op: a relabelled edge keeps the stamp of its old label');
          }
        }
        // The op is used: spread, or bound and read again.
        for (const c of ownOps) {
          const before = text.slice(Math.max(0, c.at - 3), c.at);
          const bound = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(text.slice(Math.max(0, c.at - 80), c.at));
          const used = before.endsWith('...') || (bound && new RegExp(`(?<![\\w$])${bound[1]}(?![\\w$])`).test(text.slice(c.end)));
          if (!used) say(st, 'computes the stamp op and never spreads it into the write');
        }
      }
      if (st.includes('/write-plan/plan-') && callsOf(text, 'finishInsert').length === 0) say(st, 'builds no insert through finishInsert: the insert path is not checked');
    }
    if (spec.ops.in) {
      for (const k of spec.ops.in) {
        const text = body(k) ?? '';
        const calls = callsOf(text, spec.ops.form);
        if (calls.length === 0) say(k, `spreads no ${spec.ops.form}(: ${spec.why.split(':')[0]} lands unstamped`);
        for (const c of calls) if (spec.ops.names && !c.args[0]?.includes(spec.ops.names)) say(k, `${spec.ops.form}( is not asked about ${spec.ops.names}, the version the write lands on`);
        if (callsOf(text, 'stampOp').length > 0) say(k, 'spreads stampOp( on a version read after the validation (DI-4)');
      }
    }
  }

  for (const [ho, hs] of Object.entries(HAND_OFFS)) {
    const text = body(ho);
    if (!text) { say(ho, 'is not a function of the tree: a named hand-off is gone or renamed'); continue; }
    secondReads(ho, text);
    if (callsOf(text, 'readMetaForWrite').length > 0) say(ho, 'reads the pair itself: a hand-off takes the pair its caller read');
    if (!new RegExp(`(?<![\\w$])${hs.param}(?![\\w$])`).test(text)) say(ho, `takes no \`${hs.param}\` (the pair): ${hs.why}`);
    if (hs.op === 'stampOp' && callsOf(text, 'stampOp').length === 0) say(ho, 'spreads no stampOp(: an insert lands unstamped');
    if (hs.op === null) judgesWith(ho, text, `${hs.param}.meta`);
  }

  for (const [k, why] of Object.entries(UNSTAMP)) {
    const text = body(k) ?? '';
    if (!/\.\.\.\s*UNSTAMP\b|\bUNSTAMP\s*\.\s*\$unset\b/.test(text)) say(k, `spreads no UNSTAMP: ${why}, so the stamp would claim a conformance nobody checked`);
    for (const fn of ['readMetaForWrite', 'stampOp', 'stampOpIfUnmoved']) if (callsOf(text, fn).length > 0) say(k, `calls ${fn}( but validates nothing: an UNSTAMP writer only removes`);
    for (const c of callsOf(text, 'rekeyEdges')) {
      if (!/UNSTAMP|schemaFingerprint/.test(c.args[3] ?? '')) say(k, 'hands rekeyEdges an alsoUnset without the stamp: a re-keyed edge keeps a stamp its new ends were never checked against');
    }
  }

  for (const [name, map] of [['KEEP', KEEP], ['ARRIVAL', ARRIVAL]]) {
    for (const k of Object.keys(map)) {
      const text = body(k) ?? '';
      if (/schemaFingerprint/.test(text)) say(k, `is ${name} and names schemaFingerprint`);
      for (const fn of STAMP_API) if (new RegExp(`(?<![.\\w$])${fn}(?![\\w$])`).test(text)) say(k, `is ${name} and reaches the stamp module (${fn})`);
    }
  }
  return { findings, writers };
}

const RAW = serverSources();
const INDEX = indexSources(RAW, { label: 'server/src, schema/src' });
const REAL = classify(INDEX);

/**
 * A copy of the sources with one change made to one file, and the classification of it. `target` (`file:function` without the
 * `server/src/` prefix) must be clean in the real tree first: a defect the repository already has proves nothing when it is planted.
 */
function mutant(file, change, target) {
  const already = REAL.findings.filter(f => f.startsWith(`${target}:`));
  assert.deepEqual(already, [], `${target} already fails the gate in the repository, so planting a defect in it proves nothing`);
  const text = RAW.get(file);
  assert.ok(text !== undefined, `${file} is not a tracked source: re-anchor the mutation`);
  const changed = change(text);
  assert.notEqual(changed, text, `the mutation of ${file} changed nothing: the code it plants a defect in is not there`);
  const copy = new Map(RAW);
  copy.set(file, changed);
  return classify(indexSources(copy, { label: `mutant of ${file}` })).findings;
}

describe('the derivation finds the writers, so the rule cannot pass by finding none', () => {
  it('found the record writers, the four updates and the commit among them, and no file or link writer', () => {
    assert.ok(REAL.writers.length >= 25, `only ${REAL.writers.length} writing function(s): ${REAL.writers.join(', ')}`);
    for (const k of Object.keys(STAMP)) assert.ok(REAL.writers.includes(k), `${k} writes a record collection and the derivation did not find it`);
    assert.ok(!GOVERNED.includes('links') && !GOVERNED.includes('files') && GOVERNED.length === BRAIN_COLLECTIONS.length - 2,
      `the governed set is not BRAIN_COLLECTIONS minus files and links: ${GOVERNED.join(', ')}`);
  });
});

describe('every record writer stamps, unstamps, keeps or is an arrival (Q-736)', () => {
  it('the classification holds on the repository', () => {
    assert.deepEqual(REAL.findings, [],
      'a record writer that does not say what it does with the schema fingerprint can leave a stamp that claims a conformance nobody checked, '
      + 'or a conforming record unstamped (D-77, D-N2/D-N3)');
  });
});

describe('the gate fails on a planted defect (T1 mutation runs)', () => {
  it('one stampOp( removed from plan-fact.ts fails it', () => {
    const findings = mutant('server/src/brain/write-plan/plan-fact.ts', t => t.replace(/(?<![.\w$])stampOp\s*\(/, 'notTheStampOp('), 'brain/write-plan/plan-fact.ts:planFact');
    assert.ok(findings.some(f => f.startsWith('brain/write-plan/plan-fact.ts:planFact')),
      `a planner that spreads no op passed the gate: ${findings.join(' | ')}`);
  });

  it('one getSpaceMeta( added to planEdge fails it', () => {
    const findings = mutant('server/src/brain/write-plan/plan-edge.ts',
      t => t.replace(/(export\s+async\s+function\s+planEdge\s*\([^)]*\)\s*:\s*Promise<EdgePlanned>\s*\{)/, '$1\n  const second = getSpaceMeta(spaceId); void second;'), 'brain/write-plan/plan-edge.ts:planEdge');
    assert.ok(findings.some(f => f.startsWith('brain/write-plan/plan-edge.ts:planEdge') && /getSpaceMeta/.test(f)),
      `a second meta read in planEdge passed the gate: ${findings.join(' | ')}`);
  });

  it('the UNSTAMP spread removed from chrono-redaction.ts fails it', () => {
    const findings = mutant('server/src/brain/chrono-redaction.ts', t => t.replace(/\.\.\.\s*UNSTAMP\b|\bUNSTAMP\s*\.\s*\$unset\b/g, '...{}'), 'brain/chrono-redaction.ts:redactLapsedChronoContent');
    assert.ok(findings.some(f => f.startsWith('brain/chrono-redaction.ts:redactLapsedChronoContent')),
      `a redaction that keeps the stamp passed the gate: ${findings.join(' | ')}`);
  });
});

describe('the op the stamp module returns (Q-736 stampOp / stampOpIfUnmoved)', () => {
  const load = async () => {
    const m = await moduleOrNull('spaces/schema-stamp.js');
    assert.ok(m, 'server/src/spaces/schema-stamp.ts is not built: there is no stampOp, so no write can stamp');
    return m;
  };
  const META = { validationMode: 'strict', typeSchemas: { fact: { claim: { propertySchemas: { n: { type: 'number' } } } } } };
  const pair = () => ({ meta: META, stamp: { fp: 'a'.repeat(64), text: '{}' } });

  it('a conforming check sets the pair\'s fingerprint; any violation (warn or off, refused or not) unsets it', async () => {
    const m = await load();
    const w = pair();
    assert.deepEqual(m.stampOp(w, { all: [], warnings: [], blocked: false }), { $set: { schemaFingerprint: w.stamp.fp } });
    const unset = m.stampOp(w, { all: [{ field: 'properties.n', reason: 'x' }], warnings: [], blocked: false });
    assert.ok(unset.$unset && 'schemaFingerprint' in unset.$unset && !unset.$set, `a non-conforming write is not unstamped: ${JSON.stringify(unset)}`);
    assert.deepEqual(unset, m.UNSTAMP, 'the unstamp is not the one constant every UNSTAMP writer spreads');
  });

  it('a pair without a stamp throws (a hand-built pair cannot pass a meta of another provenance)', async () => {
    const m = await load();
    assert.throws(() => m.stampOp({ meta: META }, { all: [] }));
  });

  it('stampOpIfUnmoved stamps only when the row it lands on is the row that was validated', async () => {
    const m = await load();
    const w = pair();
    assert.deepEqual(m.stampOpIfUnmoved({ readSeq: 7 }, 7, w, { all: [] }), { $set: { schemaFingerprint: w.stamp.fp } });
    assert.deepEqual(m.stampOpIfUnmoved({ readSeq: 9 }, 7, w, { all: [] }), m.UNSTAMP, 'a moved row is written stamped (DI-4)');
  });
});
