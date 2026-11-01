/**
 * Every deletion of a record that the server makes on its own is audited by the act that makes it (bundle-40, Q-207).
 *
 * ## The finding
 *
 * A request's deletion is one audit row, written by the middleware (`audit-route-coverage` holds that). A deletion nobody
 * asked for is the other kind: an interval job, a cron job or a worker removes a record, issues a tombstone, and every peer
 * removes it too — and the only trace is a log line. The dupe scanner's auto-merge absorbed an entity into its survivor and
 * the TTL sweep deleted expired records on every instance of a network, and neither left an audit row. `logInternalAudit`
 * exists for exactly this and nothing checked that a job's deletion reaches it.
 *
 * ## The derivation, and nothing here is a list of roots
 *
 * - **The sinks are read from the repository's own table of delete operations**: the methods `COLLECTION_METHOD_EFFECT`
 *   (`db/record-write-observer.ts`) classifies as deleting, plus the `bulkWrite` forms that delete (`{ deleteMany: { … } }`,
 *   `files/tombstones.ts`). A function is a SINK when it makes such a delete on a collection of a record family (the families
 *   `RECORD_COLLECTION` names: facts, entities, edges, chrono, files; or a family handed in as a parameter) and issues a
 *   tombstone in the same body, because a tombstone is what makes the deletion every peer's. A delete that leaves no tombstone
 *   (a queue row, a cursor, a cache, a candidate) removes nothing a peer holds and is not a subject.
 * - **The callers are derived in reverse**: every way work starts without a request (`_housekeeping-walks.mjs`
 *   `housekeepingRoots`: each interval and cron job, boot, `afterListening`, a slot pool) is walked, following what a call causes,
 *   and a computed dispatch (`DELETERS[c](…)`, the table the TTL sweep deletes through) is followed to the functions its table
 *   names. A root is a JOB (interval, cron), a WORKER (boot, after-listening, slot pool) or a ROUTE (`mountedRoutes()` — written
 *   by the audit middleware, so asked of nobody here); a job or worker that reaches a sink is either audited or EXEMPT with a reason.
 * - **"Audited" is the act's own row.** A function on the path from the root to the sink writes `logInternalAudit(…)`, directly
 *   or through a helper in the same file. A row some OTHER function of the same job writes (the TTL sweep's legacy-spill row,
 *   the leaked-rows row) is not this deletion's row, and the first version of this reading, "the job reaches `logInternalAudit`
 *   anywhere", passed the TTL sweep for the wrong one.
 *
 * ## Seen red
 *
 * On 6c64a7112 the dupe scanner's `tryAutoMerge` (`mergeEntities`) and the TTL sweep's expiry (`DELETERS` → `removeRecords`)
 * reach a sink on a path that writes no internal audit row. The fixture cases below show the reading itself is not a pass for a
 * sibling's row (a mutation that misses): they run the same function over a built index.
 *
 * Run: node --test testing/standalone/every-server-deleter-writes-an-internal-audit.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, indexSources, walkFrom, intervalJobRuns, intervalJobEdges, callsIn, callSitesIn, pathTo } from './_call-graph.mjs';
import { argumentsOf } from './_structural-window.mjs';
import { scheduledJobs } from './_scheduled-jobs.mjs';
import { walkEntryNames, walkCallbackEdges, housekeepingRoots } from './_housekeeping-walks.mjs';
import { mountedRoutes } from './_routes.mjs';

const observer = await import('../../server/dist/db/record-write-observer.js');
const { RECORD_COLLECTION } = await import('../../server/dist/config/types-knowledge.js');

/**
 * Roots that reach a sink and are NOT audited by a row of their own, each with the reason — the whole argument. Keyed
 * `form|file` (a job or a slot pool is one per file), `boot|<label>` for a boot call. An entry that no root matches fails (a
 * licence for a root that is gone), and so does one whose root no longer reaches a sink.
 */
const EXEMPT = new Map([
  ['cron|server/src/sync/scheduler.ts', 'peer-driven: the scheduled sync applies the deletions peers made, each judged by the deletion '
    + 'authority and carried by the peer\'s own tombstone; the deletion was made, and is recorded, on the instance that issued it'],
]);

/** The delete methods of the repository's table, and the `bulkWrite` forms, as sink matchers. */
function deleteMatchers() {
  const methods = Object.entries(observer.COLLECTION_METHOD_EFFECT)
    .filter(([name, e]) => e !== 'read' && e.delete && !/bulk/i.test(name))
    .map(([name]) => name);
  assert.ok(methods.length >= 3 && methods.includes('deleteMany') && methods.includes('deleteOne'),
    `the delete table yielded ${JSON.stringify(methods)}: the derivation is broken (it must name deleteOne and deleteMany)`);
  return {
    methods,
    call: new RegExp(String.raw`\.(?:${methods.join('|')})\s*\(`),
    bulk: /\b(?:deleteOne|deleteMany)\s*:\s*\{/,
  };
}

/**
 * The sinks of an index: the keys of the functions that delete a record family's rows and issue their tombstones.
 *
 * - A function that deletes from a collection of a record family named by a literal (`spaceCollection(s, 'entities')`) and issues
 *   a tombstone in the same body is a sink (the merge's absorbed entity).
 * - A function that does the same on a collection handed in as a PARAMETER (`removeWithTombstones(space, part, …)`) is not itself
 *   a sink: its CALL SITES are, when the part they hand is a record family's literal or is not a literal at all (`removeRecords`
 *   hands it the kind's family). A call that hands `'links'` is the link reconcile, a consequence of a record's own write, and is
 *   not a record deletion.
 */
export function recordDeleters(index) {
  const del = deleteMatchers();
  const families = [...new Set(Object.values(RECORD_COLLECTION))];
  assert.ok(families.length >= 5, `RECORD_COLLECTION yielded ${JSON.stringify(families)}`);
  const literal = new RegExp(String.raw`spaceCollection\(\s*[^,()]+,\s*'(?:${families.join('|')})'`);
  const parametric = /spaceCollection\(\s*[^,()]+,\s*[A-Za-z_$][\w$.]*\s*\)/;

  const direct = new Set();
  const deleters = new Set();
  for (const [key, e] of index.bodies) {
    if (e.alias || !(del.call.test(e.body) || del.bulk.test(e.body)) || !/tombstone/i.test(e.body)) continue;
    if (literal.test(e.body)) direct.add(key);
    else if (parametric.test(e.body)) deleters.add(key);
  }

  const sinks = new Set(direct);
  for (const [key, e] of index.bodies) {
    if (e.alias || e.synthetic) continue;
    for (const site of callSitesIn(e.body, { closures: true })) {
      const target = index.resolve(e.file, site.name);
      if (!target || !deleters.has(target) || target === key) continue;
      const part = argumentsOf(e.body, site.paren, `the call of ${site.name} in ${key}`)[1]?.trim() ?? '';
      const quoted = /^'([^']*)'$/.exec(part);
      if (!quoted || families.includes(quoted[1])) sinks.add(key);
    }
  }
  return [...sinks].sort();
}

/**
 * The edges a computed dispatch hides: `TABLE[c](…)` reaches every function the same file's `const TABLE … = { … }` names.
 * Without it the TTL sweep's deleters (`DELETERS[c]`) are read as unreached and its expiry as clean.
 */
export function dispatchEdges(index) {
  return (entry) => {
    const out = [];
    const src = index.sources.get(entry.file);
    for (const m of entry.body.matchAll(/\b([A-Z][A-Z0-9_]*)\s*\[[^\]]+\]\s*\(/g)) {
      // Lazy up to the first `= {` (a `=>` in the type annotation is `=` then `>`, never `=` then `{`).
      const decl = new RegExp(String.raw`\bconst\s+${m[1]}\b[\s\S]*?=\s*\{`).exec(src);
      if (!decl) continue;
      let depth = 0, i = decl.index + decl[0].length - 1;
      for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
      for (const name of new Set(src.slice(decl.index, i).match(/[A-Za-z_$][\w$]*/g) ?? [])) {
        const key = index.resolve(entry.file, name);
        if (key) out.push(key);
      }
    }
    return out;
  };
}

/** Whether `body` writes an internal audit row itself. */
const writesAudit = (body) => /\blogInternalAudit\s*\(/.test(body);

/** The functions that write the row: their own body, or a helper declared in their own file. */
export function auditWriters(index) {
  const out = new Set();
  for (const [key, entry] of index.bodies) {
    if (entry.alias) continue;
    if (writesAudit(entry.body)) { out.add(key); continue; }
    for (const name of callsIn(entry.body, { closures: true })) {
      const helper = index.resolve(entry.file, name);
      const h = helper ? index.bodies.get(helper) : null;
      if (h && h.file === entry.file && writesAudit(h.body)) { out.add(key); break; }
    }
  }
  return out;
}

/**
 * Every (root, sink) pair where the root reaches the sink along a path that no function writing the row sits on: `{ root, sink, path }`.
 *
 * The walk does not enter an audit writer's callees (its body is blanked in a copy of the index), so what it reaches is what runs
 * WITHOUT passing the row. A sink that is itself a writer, or a root whose own body writes, is audited. `edges` is the `walkFrom`
 * option; a root without a key (a run this cannot follow) is the caller's to name.
 */
export function unauditedPairs(index, roots, sinks, edges) {
  const writers = auditWriters(index);
  const cut = { ...index, bodies: new Map([...index.bodies].map(([k, e]) => [k, writers.has(k) ? { ...e, body: '' } : e])) };
  const sinkSet = new Set(sinks);
  const out = [];
  for (const root of roots) {
    if (!root.key || writers.has(root.key)) continue;
    const { seen, parent } = walkFrom(cut, [root.key], { closures: root.closures, edges });
    for (const sink of [...seen].filter(k => sinkSet.has(k) && !writers.has(k)).sort()) out.push({ root, sink, path: pathTo(parent, sink) });
  }
  return out;
}

const fileOf = (key) => key.slice(0, key.indexOf(':'));
/** The exemption key of a root. */
const rootId = (r) => r.form === 'boot' ? `boot|${r.label}` : `${r.form}|${fileOf(r.key)}`;
const CLASS = { interval: 'job', cron: 'job', boot: 'worker', 'after-listening': 'worker', 'slot-pool': 'worker' };

describe('every deletion the server makes on its own is audited by the act that makes it', () => {
  const index = moduleIndex('server/src');
  const names = walkEntryNames(index);
  const { jobs } = scheduledJobs(index);
  const roots = housekeepingRoots(index, jobs);
  const sinks = recordDeleters(index);
  const edges = (entry) => [...walkCallbackEdges(index, names)(entry), ...intervalJobEdges(intervalJobRuns(index))(entry), ...dispatchEdges(index)(entry)];

  it('derives the sinks from the delete table with a floor, and the record deleters among them', () => {
    assert.ok(sinks.length >= 3, `only ${sinks.length} sinks derived: ${sinks.join(', ')}`);
    // The merge's absorbed entity is a direct delete of a literal family; `removeRecords` hands removeWithTombstones the kind's family
    // (a call site of the parametric deleter), and the link reconcile hands it 'links' and is therefore not among them.
    for (const k of ['server/src/brain/merge.ts:relinkAndAbsorb', 'server/src/brain/record-removal.ts:removeChunk']) {
      assert.ok(sinks.includes(k), `${k} is not derived as a sink: the sink derivation stopped reading the record deleters (${sinks.join(', ')})`);
    }
    assert.ok(!sinks.includes('server/src/brain/tombstones.ts:removeWithTombstones'), 'the parametric deleter is a sink in itself: every link reconcile would be a record deletion');
    assert.ok(!sinks.includes('server/src/brain/write-plan/commit.ts:reconcileLinkRows'), 'the link reconcile reads as a record deletion');
  });

  it('derives a job, a worker and a route class of roots, each with a floor', () => {
    const byClass = (c) => roots.filter(r => r.key && CLASS[r.form] === c).length;
    assert.ok(byClass('job') >= 20, `only ${byClass('job')} job roots`);
    assert.ok(byClass('worker') >= 20, `only ${byClass('worker')} worker roots`);
    const routes = mountedRoutes();
    assert.ok(routes.length >= 150, `only ${routes.length} routes`);
  });

  it('a computed dispatch is followed: the TTL sweep reaches the deleters its table names', () => {
    const ttl = roots.find(r => r.key && fileOf(r.key) === 'server/src/brain/ttl-sweep.ts');
    assert.ok(ttl, 'no root of the TTL sweep');
    const { seen } = walkFrom(index, [ttl.key], { closures: true, edges });
    for (const deleter of ['server/src/brain/fact.ts:deleteFact', 'server/src/brain/entities.ts:deleteEntity', 'server/src/files/delete-cascade.ts:deleteFileCascade']) {
      assert.ok(seen.has(deleter), `the TTL sweep does not reach ${deleter}: its DELETERS dispatch is read as no call`);
    }
  });

  it('every job or worker that reaches a record deleter writes the deletion\'s own audit row, or is exempt with a reason', () => {
    const unaudited = unauditedPairs(index, roots, sinks, edges)
      .filter(p => !EXEMPT.has(rootId(p.root)));
    const text = unaudited.map(p => `${CLASS[p.root.form]} ${rootId(p.root)} reaches ${p.sink.replace('server/src/', '')} with no logInternalAudit on `
      + `the path: ${p.path.map(k => k.replace('server/src/', '')).join(' > ')}`);
    assert.deepEqual(text, [],
      'these deletions are made by the server with nobody asking and leave no audit row; write logInternalAudit({ method: \'SWEEP\', … }) '
      + `from the act (or a helper of its file), or add an EXEMPT row with the reason:\n  ${text.join('\n  ')}`);
  });

  it('an exemption names a root that exists and still reaches a sink, and says why', () => {
    const reaching = new Set(unauditedPairs(index, roots, sinks, edges).map(p => rootId(p.root)));
    const known = new Set(roots.filter(r => r.key).map(rootId));
    for (const [id, reason] of EXEMPT) {
      assert.ok(known.has(id), `the exemption ${id} names no root of this tree: delete it`);
      assert.ok(reaching.has(id), `the exemption ${id} no longer covers a root that reaches a sink: delete it`);
      assert.ok(reason.length >= 60, `the exemption ${id} has no real reason`);
    }
  });
});

describe('the reading of "audited" is the deletion\'s own row, not a sibling\'s', () => {
  const files = new Map([
    ['server/src/deleter.ts', `export function removeAll(spaceId: string) { return col(spaceCollection(spaceId, 'facts')).deleteMany({}).then(() => writeTombstones(spaceId)); }`],
    ['server/src/sibling.ts', `import { logInternalAudit } from './audit.js';\nexport function siblingSweep(spaceId: string) { logInternalAudit({ operation: 'x' }); return spaceId; }`],
    ['server/src/audit.ts', `export function logInternalAudit(i: unknown) { return i; }`],
    ['server/src/job.ts', [
      `import { removeAll } from './deleter.js';`,
      `import { siblingSweep } from './sibling.js';`,
      `import { logInternalAudit } from './audit.js';`,
      `export function jobSilent(s: string) { return removeAll(s); }`,
      `export function jobWithSibling(s: string) { siblingSweep(s); return removeAll(s); }`,
      `export function jobAudited(s: string) { logInternalAudit({ operation: 'a' }); return removeAll(s); }`,
      `export function jobHelper(s: string) { removeAll(s); return note(s); }`,
      `function note(s: string) { logInternalAudit({ operation: 'b' }); return s; }`,
    ].join('\n')],
  ]);
  const fixture = indexSources(files, { functionFloor: 1, label: 'the fixture' });
  const sinksOfFixture = recordDeleters(fixture);
  const rootOf = (name) => ({ form: 'interval', label: name, key: `server/src/job.ts:${name}`, closures: true });

  it('derives the fixture\'s deleter from the delete table', () => {
    assert.deepEqual(sinksOfFixture, ['server/src/deleter.ts:removeAll']);
  });

  it('a job whose deletion writes no row of its own is a finding, even when a sibling of the job writes one', () => {
    const found = unauditedPairs(fixture, ['jobSilent', 'jobWithSibling'].map(rootOf), sinksOfFixture).map(p => p.root.label);
    assert.deepEqual(found, ['jobSilent', 'jobWithSibling']);
  });

  it('a job whose path writes the row, itself or through a helper of its file, is not', () => {
    assert.deepEqual(unauditedPairs(fixture, ['jobAudited', 'jobHelper'].map(rootOf), sinksOfFixture), []);
  });

  it('a delete that leaves no tombstone is no sink', () => {
    const quiet = indexSources(new Map([['server/src/q.ts', `export function pruneCache(s: string) { return col(spaceCollection(s, 'facts')).deleteMany({}); }`]]),
      { functionFloor: 1, label: 'the fixture' });
    assert.deepEqual(recordDeleters(quiet), []);
  });

  it('a deleter that takes the family as a parameter makes its callers the sinks, unless they hand it the link family', () => {
    const parametric = indexSources(new Map([
      ['server/src/p.ts', `export function removeParts(s: string, part: string) { return col(spaceCollection(s, part)).deleteMany({}).then(() => writeTombstones(s)); }`],
      ['server/src/c.ts', [
        `import { removeParts } from './p.js';`,
        `export function removeKind(s: string, family: string) { return removeParts(s, family); }`,
        `export function removeFacts(s: string) { return removeParts(s, 'facts'); }`,
        `export function reconcile(s: string) { return removeParts(s, 'links'); }`,
      ].join('\n')],
    ]), { functionFloor: 1, label: 'the fixture' });
    assert.deepEqual(recordDeleters(parametric), ['server/src/c.ts:removeFacts', 'server/src/c.ts:removeKind']);
  });

  it('a computed dispatch hides nothing: TABLE[c](…) reaches what the table names', () => {
    const dispatch = indexSources(new Map([
      ['server/src/d.ts', `export function removeAll(s: string) { return col(spaceCollection(s, 'facts')).deleteMany({}).then(() => writeTombstones(s)); }`],
      ['server/src/j.ts', [
        `import { removeAll } from './d.js';`,
        `const TABLE: Record<string, (s: string) => unknown> = { facts: removeAll };`,
        `export function run(c: string) { return TABLE[c]('s'); }`,
      ].join('\n')],
    ]), { functionFloor: 1, label: 'the fixture' });
    const found = unauditedPairs(dispatch, [{ form: 'interval', label: 'run', key: 'server/src/j.ts:run', closures: true }], recordDeleters(dispatch), dispatchEdges(dispatch));
    assert.deepEqual(found.map(p => p.sink), ['server/src/d.ts:removeAll']);
  });
});
