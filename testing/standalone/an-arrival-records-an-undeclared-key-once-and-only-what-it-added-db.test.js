/**
 * A document that ARRIVES (a peer's push, a peer's page, an admin import) is stored whatever it carries, and what it carries
 * that its type does not declare is RECORDED, once, for the documents that were stored and only for what the copy they
 * replaced did not already have (Q-93, plan R6-9). It is never refused: a peer validated the record against ITS schema, and a
 * restore of a backup taken before a schema change must still restore.
 *
 * ## The rule, per sentence of R6-9, and the door each is held on
 *
 * Four doors, one rule: the single push routes (`POST /api/sync/entities`, a page of one), `POST /api/sync/batch-upsert`, the
 * engine's PULL (a real sync cycle against a fake peer), and the admin import. A rule held on one door only is the weaker door
 * winning (CLAUDE.md, "the defect class this repo produces most").
 *
 *  1. **Stored in every mode, recorded in strict and warn.** A document of a type that declares `status` and carries a key it
 *     does not declare is stored in strict, warn and off alike (the control, green on the unchanged base), and recorded in
 *     strict and warn.
 *  2. **Only what the replaced copy lacked.** An arrival replacing a stored copy that has the same undeclared key records
 *     nothing for that key; one replacing a copy without the key records it; a new document records it; one that replaces a
 *     copy having `A` and arrives with `A` and `B` records `B` alone. Held by IDENTITY: every document carries its own key
 *     name, so what is recorded is a set of names that is compared, never a total.
 *  3. **Only stored documents.** An arrival that is not stored (older than the held copy, a replay of what is held, or an
 *     import the writer refuses for its shape) records nothing.
 *  4. **Once.** One arrival records each key once. The base had a per-document call and a recount on the push; the one
 *     recording site is held by what each sink says, never by how the code is arranged.
 *  5. **Off records nothing.**
 *  6. **Names and counts, never values.** The key's VALUE is a recognisable secret-looking string; the sinks built for the
 *     record (log lines, sync history, the import result's rows) must not carry it. The push response's rows are the
 *     existing `{ field, value, reason }` report and are left as they are.
 *
 * ## What the sinks are, and what each door can say
 *
 *  - push (single): the response's `schemaViolations` rows (`{ field, value, reason }`, per document, an existing field), and
 *    the log lines.
 *  - push (batch): the response's per-family COUNT of documents recorded (`entities.schemaViolations`, an existing field —
 *    the batch answers a number, not rows), and the log lines.
 *  - import: the result's `schemaViolations` rows (`{ _id, violations }`, existing), and the log lines.
 *  - pull: no structured answer exists. The sinks are the sync history row of the cycle that pulled it and every log line the
 *    cycle wrote; a key is recorded if its NAME appears in either, which is what R6-9 promises ("sync history per space
 *    {records with violations, top keys/rules by count}", "one line per (space, peer) per window"), without fixing the
 *    spelling. A pull's repeated arrival is in a fresh space per case, so a warn-once window never hides a recording.
 *
 * ## What the unchanged base does, stated so a green control is read as one
 *
 * The base validator does not see an undeclared key, so every "recorded" assertion is red; "stored" is green on every door.
 * The base DOES record a declared-property violation (`status` of the wrong type) on push and import, for a document that was
 * NOT stored (older seq) and for one whose replaced copy had the same violation, and in an `off` space (it ignores
 * `validationMode`): those cases are held with a declared violation too, and are red on the base for that reason. The pull door
 * has no recording of any kind on the base.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/an-arrival-records-an-undeclared-key-once-and-only-what-it-added-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { undeclaredKeySpaces, spaceOf, MODES, namesTheKey } from './_undeclared-key-doors.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

/** A value no honest log line would carry: if it shows in a sink, a VALUE was recorded where only a name belongs. */
const SECRET = 'SECRET-VALUE-9f3a';

/*
 * A space a case can start from. A recording said once per (space, peer) per window would hide a second recording from a case
 * that reuses a space with a peer, and the PULL door has one peer: so a pull case takes a space nobody used before (PULL_POOL,
 * one per use). The push doors name a new peer for every request and the import answers its rows, so those take a shared space
 * in turn (SHARED_POOL) and wipe it first. The schema of every space is the shared fixture's, mode by mode.
 */
const PULL_POOL_SIZE = { strict: 3, warn: 10, off: 4 };
const SHARED_SIZE = 3;
const SCHEMA_OF = Object.fromEntries(MODES.map(m => [m, undeclaredKeySpaces().find(s => s.id === spaceOf(m)).meta]));
const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const PULL_POOL = Object.fromEntries(MODES.map(m => [m, names(`ukpull${m}`, PULL_POOL_SIZE[m])]));
const SHARED_POOL = Object.fromEntries(MODES.map(m => [m, names(`ukshared${m}`, SHARED_SIZE)]));
const ALL_SPACES = MODES.flatMap(m => [...PULL_POOL[m], ...SHARED_POOL[m]]);
const META = Object.fromEntries(MODES.flatMap(m => [...PULL_POOL[m], ...SHARED_POOL[m]].map(id => [id, structuredClone(SCHEMA_OF[m])])));
const turn = { strict: 0, warn: 0, off: 0 };
const pulled = { strict: 0, warn: 0, off: 0 };
async function freshSpace(doorName, mode) {
  if (doorName === 'pull') {
    const id = PULL_POOL[mode][pulled[mode]++];
    assert.ok(id, `the pull pool of ${PULL_POOL_SIZE[mode]} ${mode} spaces ran out — enlarge PULL_POOL_SIZE`);
    return id;
  }
  const id = SHARED_POOL[mode][turn[mode]++ % SHARED_SIZE];
  await door.wipe(id);
  return id;
}

let door, engine, importMod, log, pusher = 0;

const nextPeer = () => peerToken(`ukrec-peer-${++pusher}`);

/** A `service` entity (the type declaring `status`), carrying `props` beside a declared `status`. */
const entity = (space, id, seq, props = {}) => build.entity(space, id, seq, { type: 'service', properties: { status: 'up', ...props } });
/** Undeclared keys, each holding the secret-looking value. */
const keys = (...names) => Object.fromEntries(names.map(k => [k, SECRET]));
const seed = (space, docs) => door.coll(space, 'entities').insertMany(docs.map(d => ({ ...d })));
const storedOf = async (space) => new Map((await door.coll(space, 'entities').find({}).toArray()).map(d => [d._id, d]));

/** Every log line the server writes while `fn` runs — the three levels a recorder or the cycle can speak at. */
async function capturing(fn) {
  const lines = [];
  const orig = { warn: log.warn, error: log.error, info: log.info };
  for (const k of Object.keys(orig)) log[k] = (...a) => { lines.push(a.join(' ')); };
  try { return { result: await fn(), lines }; } finally { Object.assign(log, orig); }
}

/** One sync cycle of the real engine, and the history row it wrote (written without the cycle awaiting it). */
async function cycle() {
  const since = new Date().toISOString();
  const { result, lines } = await capturing(async () => {
    const out = await engine.runSyncForNetwork(door.NET);
    await door.settled();
    return out;
  });
  let row;
  await waitFor(async () => {
    row = (await door.mongo.col('_sync_history').find({ networkId: door.NET, triggeredAt: { $gte: since } }).toArray())[0];
    return row !== undefined;
  }, 10_000, 100, undefined, { what: 'the sync history row of the cycle that pulled the page' });
  return { out: result, lines, history: JSON.stringify(row) };
}

/**
 * What one arrival left in every sink its door has.
 * @typedef {object} Observation
 * @property {Array<{ id: string, field: string, reason: string, value?: unknown }>} rows  per-document rows (push single, import)
 * @property {string[]} lines          every log line during the arrival
 * @property {string|null} history     the pull's sync history row, as text
 * @property {number|null} batchCount  the batch's count of documents recorded
 * @property {string} valueSinks       everything built FOR the record, as text: the lines, the history, and the import rows
 */

/**
 * The four doors, each as "these documents arrive in this space". `perDocRows` says the door answers WHICH documents were
 * recorded, `counted` that it answers HOW MANY (the pull answers neither, so a declared violation, whose name no log line can
 * tell from another property's, is not held there), `unstored` builds an arrival that is not stored on that door.
 */
const DOORS = {
  'push (single)': {
    perDocRows: true, counted: false,
    async arrive(space, docs) {
      const obs = { rows: [], lines: [], history: null, batchCount: null, valueSinks: '' };
      for (const d of docs) {
        const { result, lines } = await capturing(() => door.push('/entities', d, { spaceId: space, token: nextPeer() }));
        assert.equal(result.code, 200, `POST /entities for '${d._id}' answered ${result.code}: ${JSON.stringify(result.body)}`);
        for (const v of result.body.schemaViolations ?? []) obs.rows.push({ id: d._id, field: v.field, reason: v.reason, value: v.value });
        obs.lines.push(...lines);
      }
      obs.valueSinks = obs.lines.join('\n');   // the response's own rows echo the value today and stay as they are
      return obs;
    },
    unstored: (space, id, props) => ({ seed: [entity(space, id, 9)], doc: entity(space, id, 5, props) }),
  },
  'push (batch)': {
    perDocRows: false, counted: true,
    async arrive(space, docs) {
      const { result, lines } = await capturing(() => door.push('/batch-upsert', { entities: docs }, { spaceId: space, token: nextPeer() }));
      assert.equal(result.code, 200, `POST /batch-upsert answered ${result.code}: ${JSON.stringify(result.body)}`);
      return { rows: [], lines, history: null, batchCount: result.body.entities.schemaViolations, valueSinks: lines.join('\n') };
    },
    unstored: (space, id, props) => ({ seed: [entity(space, id, 9)], doc: entity(space, id, 5, props) }),
  },
  pull: {
    perDocRows: false, counted: false,
    async arrive(space, docs) {
      door.state.records = { [space]: { entities: docs } };
      const { out, lines, history } = await cycle();
      assert.equal(out.errors, 0, `the pull cycle failed: ${JSON.stringify(out)} ${lines.join(' | ')}`);
      return { rows: [], lines, history, batchCount: null, valueSinks: `${lines.join('\n')}\n${history}` };
    },
    unstored: (space, id, props) => ({ seed: [entity(space, id, 9)], doc: entity(space, id, 5, props) }),
  },
  import: {
    perDocRows: true, counted: true,
    async arrive(space, docs) {
      const { result, lines } = await capturing(() => importMod.importDocuments(space, { entities: docs }));
      const reported = result.results.entities.schemaViolations ?? [];
      const rows = reported.flatMap(r => r.violations.map(v => ({ id: r._id, field: v.field, reason: v.reason, value: v.value })));
      return { rows, lines, history: null, batchCount: reported.length, valueSinks: `${lines.join('\n')}\n${JSON.stringify(reported)}` };
    },
    // A restore replaces whatever is held, so "older" does not exist there; what the writer refuses is a document with no seq.
    unstored: (space, id, props) => { const doc = entity(space, id, 5, props); delete doc.seq; return { seed: [], doc }; },
  },
};

const rowsNaming = (obs, key) => obs.rows.filter(r => r.field === `properties.${key}`);
const linesNaming = (obs, key) => obs.lines.filter(l => l.includes(key));
const inHistory = (obs, key) => obs.history !== null && obs.history.includes(key);
/** Whether any sink the door has names `key`. */
const recorded = (obs, key) => rowsNaming(obs, key).length > 0 || linesNaming(obs, key).length > 0 || inHistory(obs, key);
const recordedOf = (obs, candidates) => candidates.filter(k => recorded(obs, k));

describe('an arrival records an undeclared key once, and only what it added', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'undeclkeysrecord', spaces: ALL_SPACES, meta: META });
    engine = await import('../../server/dist/sync/engine.js');
    importMod = await import('../../server/dist/api/admin-import.js');
    ({ log } = await import('../../server/dist/util/log.js'));
  });
  after(async () => { await door?.close(); });

  for (const [name, d] of Object.entries(DOORS)) {
    describe(name, () => {
      const fresh = (mode) => freshSpace(name, mode);
      it('the pool is in place, so the cases below do not pass over nothing', () => {
        assert.ok(ALL_SPACES.length >= MODES.length * 3, 'the fresh spaces were not derived');
        assert.ok(Object.values(META).every(m => m.typeSchemas.entity.service.propertySchemas.status), 'a pool space lacks the declared property');
      });

      it('(1, control) a document carrying an undeclared key is STORED in strict, warn and off: a recorder never refuses', async () => {
        for (const mode of MODES) {
          const space = await fresh(mode);
          await d.arrive(space, [entity(space, 'e1', 5, keys('zzStoredKey'))]);
          const held = (await storedOf(space)).get('e1');
          assert.ok(held, `the ${mode} space refused (did not store) an arriving document on the ${name} door`);
          assert.equal(held.properties?.zzStoredKey, SECRET, `the ${mode} space stored the document without its undeclared key`);
          assert.equal(held.properties?.status, 'up', `the ${mode} space lost the declared property`);
        }
      });

      for (const mode of ['strict', 'warn']) {
        it(`(1) a stored document carrying an undeclared key is RECORDED in a ${mode} space`, async () => {
          const space = await fresh(mode);
          const obs = await d.arrive(space, [entity(space, 'e1', 5, keys('zzRecordedKey'))]);
          assert.ok((await storedOf(space)).has('e1'), 'the document was not stored');
          assert.ok(recorded(obs, 'zzRecordedKey'),
            `the stored document's undeclared key was recorded nowhere on the ${name} door: rows ${JSON.stringify(obs.rows)}, `
            + `lines ${JSON.stringify(obs.lines.filter(l => !/Gossip|Vote|Schema from|File |sync cycle/i.test(l)))}, `
            + `history ${obs.history ?? '(none)'}`);
          if (d.perDocRows) {
            const [row, ...more] = rowsNaming(obs, 'zzRecordedKey');
            assert.ok(row && more.length === 0, `expected one row for the key, got ${JSON.stringify(obs.rows)}`);
            assert.equal(row.id, 'e1', 'the row does not name the document');
            assert.ok(namesTheKey(JSON.stringify(row), 'zzRecordedKey'), `the row does not say the key is not declared: ${JSON.stringify(row)}`);
          }
          if (d.counted) assert.equal(obs.batchCount, 1, 'the batch did not count the one recorded document');
        });
      }

      it('(2) only what the replaced copy lacked: a key it already held is not recorded, one it did not hold is', async () => {
        const space = await fresh('warn');
        // A held `zzKeepA`; B held none; D held `zzKeepD`. C is new.
        await seed(space, [entity(space, 'A', 3, keys('zzKeepA')), entity(space, 'B', 3), entity(space, 'D', 3, keys('zzKeepD'))]);
        const obs = await d.arrive(space, [
          entity(space, 'A', 5, keys('zzKeepA')),
          entity(space, 'B', 5, keys('zzAddedB')),
          entity(space, 'C', 5, keys('zzNewC')),
          entity(space, 'D', 5, keys('zzKeepD', 'zzAddedD')),
        ]);
        const held = await storedOf(space);
        assert.deepEqual(['A', 'B', 'C', 'D'].map(id => held.get(id)?.seq), [5, 5, 5, 5], 'an arrival was not stored (the case is not about stored documents)');
        assert.deepEqual(recordedOf(obs, ['zzKeepA', 'zzAddedB', 'zzNewC', 'zzKeepD', 'zzAddedD']), ['zzAddedB', 'zzNewC', 'zzAddedD'],
          'recorded the keys the replaced copies already held, or missed the ones the arrivals added '
          + `(rows ${JSON.stringify(obs.rows.map(r => r.field))}, history ${obs.history ?? '(none)'})`);
        if (d.perDocRows) {
          assert.deepEqual([...new Set(obs.rows.map(r => `${r.id}:${r.field}`))].sort(),
            ['B:properties.zzAddedB', 'C:properties.zzNewC', 'D:properties.zzAddedD']);
        }
        if (d.counted) assert.equal(obs.batchCount, 3, 'the count is of documents with something NEW: B, C and D');
      });

      if (d.perDocRows || d.counted) {
        it('(2) only what the replaced copy lacked holds for a DECLARED violation as well', async () => {
          // `status: 7` breaks the declared type. P held the same break and arrives with it; Q held a clean value and arrives with it.
          const space = await fresh('warn');
          await seed(space, [{ ...entity(space, 'P', 3), properties: { status: 7 } }, entity(space, 'Q', 3)]);
          const obs = await d.arrive(space, [
            { ...entity(space, 'P', 5), properties: { status: 7 } },
            { ...entity(space, 'Q', 5), properties: { status: 7 } },
          ]);
          const held = await storedOf(space);
          assert.deepEqual(['P', 'Q'].map(id => held.get(id)?.seq), [5, 5], 'an arrival was not stored');
          if (d.perDocRows) assert.deepEqual([...new Set(obs.rows.map(r => r.id))], ['Q'], 'recorded a violation the replaced copy already had (P), or missed the new one (Q)');
          else assert.equal(obs.batchCount, 1, 'the count is of documents with something NEW: Q alone');
        });
      }

      it('(3) only stored documents: an arrival that is not stored records nothing, and a stored one beside it still does', async () => {
        const space = await fresh('warn');
        const { seed: held, doc: stale } = d.unstored(space, 'S', keys('zzStaleKey'));
        if (held.length > 0) await seed(space, held);
        const first = await d.arrive(space, [stale]);
        const after = (await storedOf(space)).get('S');
        assert.ok(after?.properties?.zzStaleKey === undefined, 'the arrival that must not be stored WAS stored (the case is not about it)');
        assert.ok(!recorded(first, 'zzStaleKey'), `a document that was not stored was recorded: rows ${JSON.stringify(first.rows)}, lines ${JSON.stringify(linesNaming(first, 'zzStaleKey'))}`);
        const next = await d.arrive(space, [entity(space, 'N', 20, keys('zzFreshKey'))]);
        assert.ok(recorded(next, 'zzFreshKey'), 'a document that WAS stored beside it was not recorded');
        assert.ok(!recorded(next, 'zzStaleKey'), 'the stale document was recorded with the next page');
      });

      if (d.perDocRows || d.counted) {
        it('(3) only stored documents holds for a DECLARED violation as well', async () => {
          const space = await fresh('warn');
          const { seed: held, doc: stale } = d.unstored(space, 'S', {});
          stale.properties = { status: 7 };
          if (held.length > 0) await seed(space, held);
          const first = await d.arrive(space, [stale]);
          if (d.perDocRows) assert.deepEqual(first.rows.map(r => r.id), [], `a document that was not stored was recorded: ${JSON.stringify(first.rows)}`);
          else assert.equal(first.batchCount, 0, 'a document that was not stored was counted');
        });
      }

      it('(3) a replay of a document already held records nothing a second time', async () => {
        const space = await fresh('warn');
        const doc = entity(space, 'R', 5, keys('zzReplayKey'));
        const first = await d.arrive(space, [doc]);
        assert.ok(recorded(first, 'zzReplayKey'), 'the first arrival was not recorded, so a replay has nothing to repeat');
        const again = await d.arrive(space, [doc]);
        assert.ok(!recorded(again, 'zzReplayKey'), `the same document again recorded the key a second time: rows ${JSON.stringify(again.rows)}, lines ${JSON.stringify(linesNaming(again, 'zzReplayKey'))}`);
      });

      it('(4) one arrival records each undeclared key once, and a clean document beside them records none', async () => {
        const space = await fresh('warn');
        const obs = await d.arrive(space, [
          entity(space, 'e1', 5, keys('zzOnceOne')),
          entity(space, 'e2', 5, keys('zzOnceTwo')),
          entity(space, 'e3', 5),
        ]);
        assert.deepEqual(recordedOf(obs, ['zzOnceOne', 'zzOnceTwo']), ['zzOnceOne', 'zzOnceTwo'], 'a key of a stored document was not recorded');
        for (const key of ['zzOnceOne', 'zzOnceTwo']) {
          assert.ok(rowsNaming(obs, key).length <= 1, `'${key}' has ${rowsNaming(obs, key).length} rows: ${JSON.stringify(obs.rows)}`);
          assert.ok(linesNaming(obs, key).length <= 1, `'${key}' is named by ${linesNaming(obs, key).length} log lines: ${JSON.stringify(linesNaming(obs, key))}`);
        }
        if (d.perDocRows) assert.ok(!obs.rows.some(r => r.id === 'e3'), 'the clean document was recorded');
        if (d.counted) assert.equal(obs.batchCount, 2, 'the batch counted other than the two documents that carry a key: a recount?');
      });

      it('(5, control) an off space stores the same arrival', async () => {
        const space = await fresh('off');
        await d.arrive(space, [entity(space, 'e1', 5, keys('zzOffKey'))]);
        assert.equal((await storedOf(space)).get('e1')?.properties?.zzOffKey, SECRET, 'the off space did not store the document');
      });

      it('(5) an off space records nothing where a warn space records the same arrival', async () => {
        const warn = await fresh('warn');
        const off = await fresh('off');
        const inWarn = await d.arrive(warn, [entity(warn, 'e1', 5, keys('zzOffKey'))]);
        const inOff = await d.arrive(off, [entity(off, 'e1', 5, keys('zzOffKey'))]);
        assert.ok(recorded(inWarn, 'zzOffKey'), 'the warn space did not record it, so "off records nothing" is not shown');
        assert.ok(!recorded(inOff, 'zzOffKey'), `the off space recorded the undeclared key: rows ${JSON.stringify(inOff.rows)}, lines ${JSON.stringify(linesNaming(inOff, 'zzOffKey'))}, history ${inOff.history ?? '(none)'}`);
        if (d.counted) assert.equal(inOff.batchCount, 0, 'the off space counted a recorded document');
      });

      if (d.perDocRows || d.counted) {
        it('(5) an off space records nothing, a declared violation included (R6-9 "off spaces record nothing"; the base ignores validationMode)', async () => {
          const off = await fresh('off');
          const obs = await d.arrive(off, [{ ...entity(off, 'e1', 5), properties: { status: 7 } }]);
          assert.ok((await storedOf(off)).has('e1'), 'the off space did not store the document');
          if (d.perDocRows) assert.deepEqual(obs.rows, [], `the off space recorded a declared violation: ${JSON.stringify(obs.rows)}`);
          else assert.equal(obs.batchCount, 0, 'the off space counted a declared violation');
        });
      }

      it('(6) the sinks built for the record carry the key\'s NAME and never its VALUE', async () => {
        for (const mode of ['strict', 'warn']) {
          const space = await fresh(mode);
          const obs = await d.arrive(space, [entity(space, 'e1', 5, keys('zzSecretKey'))]);
          assert.ok(recorded(obs, 'zzSecretKey'), `nothing recorded the key in the ${mode} space, so there is no sink to read for a value`);
          assert.ok(!obs.valueSinks.includes(SECRET), `a sink carries the VALUE of an undeclared key (${mode} space): ${obs.valueSinks.split('\n').filter(l => l.includes(SECRET)).join(' | ').slice(0, 400)}`);
        }
      });
    });
  }
});
