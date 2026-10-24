/**
 * The rollback tool leaves a 6.0 database as 5.6 can run on it (bundle-81 test 17; design rev 8 section 3 "Rollback",
 * vet decision 10, the parent's decision 37; reliability S7, testing S7).
 *
 * ## What it prevents
 *
 * A 5.6 started on a 6.0 database keeps `pos`, `posAtSeq`, `writtenHere` and `issuedHere` on the rows it does not rewrite. 5.6's merkle
 * hashes every brain field outside ITS OWN local-only list, which knows none of them, so a rolled-back space on a `merkle: true` network
 * reports `MERKLE_DIVERGENCE` every cycle for data that is the same; 5.6's reads return the fields; and a 5.6 local edit stamps below the
 * row it replaces until its counter is raised. The tool does four things, each idempotent, and this holds all four.
 *
 * ## The rule, over the whole set it governs
 *
 * - EVERY collection the tool is to clean is derived: `SEQ_CARRYING` from `util/seq.ts` (the six record families and `tombstones`),
 *   never listed here; the fields come from the classes in `sync/local-only-fields.ts` (`POSITION_FIELDS`, `TOMBSTONE_LOCAL_FIELDS`
 *   without the 5.x member `storedVia`, and `writtenHere`), never written out. Floors on both, because an empty set passes every loop.
 * - After the run no row of any collection of any space has any of those fields (asserted per collection by a query, not by a count of
 *   what the tool says it did), every other field of every row is exactly as it was, and `storedVia`, a 5.x field, is kept.
 * - Each counter doc has `seq` raised to the highest version at or below the cap over the space's rows and tombstones (a row at
 *   `MAX_INGEST_SEQ` does not count; a counter already above is never lowered), `positionsOwed: 'repair'`, no `positionsReadyAt`, and
 *   `seqSeenBy6` as it was.
 * - One line per space, `<space>: <n> rows cleared, counter <old> -> <new>`, with the n the rows that carried a field, and a total; the
 *   database URI and its password are in no line.
 * - A second run changes nothing and clears nothing; a database with no 6.0 row is left byte for byte as it was.
 * - A 5.6-shaped merkle (the 5.6 local-only list, which does not know the new fields) over a cleared space equals the same data in a
 *   peer that never had the fields, and over the uncleared space it does not: the control that says the comparison can fail.
 *
 * ## Decision 37, the entry point
 *
 * `node server/dist/tools/positions-rollback.js` reads `config.json` ITSELF and never calls `loadConfig`, which runs the boot
 * migrations and writes the file: the tool runs with the instance stopped, against whatever 5.6 left. Held by the source (no
 * `loadConfig` in it) and by running the built entry against the harness database with an old-shaped config, which it must leave
 * byte for byte as it found it.
 *
 * `rollBackPositions(db, { log })` is the plan's name for the core (`sync/positions-rollback.ts`); `db` is taken to be the driver's
 * `Db`, and `log` a function called with each line. The plan fixes neither type: the report says so.
 *
 * Run: node --test testing/standalone/the-rollback-tool-clears-every-6-0-field-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openTestMongo, closeTestMongo, mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b81tD_rollback';
const SPACES = ['rb-one', 'rb-two'];
const PEER_SPACE = 'rb-peer';
const URI_PASSWORD = 'ythril-test-pw';

describe('the rollback tool clears every 6.0 field', { skip }, () => {
  let mongo; let seqMod; let classes; let CAP; let FIELDS; let rollBackPositions; let canonicalJsonHash; let local; let retagged;
  const col = (space, part) => mongo.col(`${space}_${part}`);

  before(async () => {
    mongo = await openTestMongo(SUITE);
    seqMod = await import('../../server/dist/util/seq.js');
    classes = await import('../../server/dist/sync/local-only-fields.js');
    ({ canonicalJsonHash } = await import('../../server/dist/util/canonical-json.js'));
    ({ RETAGGED_FIELDS: retagged } = await import('../../server/dist/sync/retagged-fields.js'));
    local = classes.LOCAL_ONLY_FIELDS;
    CAP = seqMod.MAX_INGEST_SEQ - seqMod.SEQ_CEILING_RESERVE;
    assert.ok(seqMod.SEQ_CARRYING.length >= 7, `only ${seqMod.SEQ_CARRYING.length} seq-carrying parts derived`);
    // The classes the plan creates. Read from the module, and a floor: the fields are not written out here.
    assert.ok([...(classes.POSITION_FIELDS ?? [])].length >= 2,
      'sync/local-only-fields.ts exports no POSITION_FIELDS (the class of pos and posAtSeq, design section 2)');
    assert.ok(classes.TOMBSTONE_LOCAL_FIELDS !== undefined,
      'sync/local-only-fields.ts exports no TOMBSTONE_LOCAL_FIELDS (design section 2: storedVia, issuedHere, pos, posAtSeq)');
    FIELDS = [...new Set([...classes.POSITION_FIELDS, 'writtenHere', ...[...classes.TOMBSTONE_LOCAL_FIELDS].filter(f => f !== 'storedVia')])];
    assert.ok(FIELDS.length >= 4, `only ${FIELDS.length} 6.0 field(s) derived: ${FIELDS.join(', ')}`);
    ({ rollBackPositions } = await import('../../server/dist/sync/positions-rollback.js'));
    assert.equal(typeof rollBackPositions, 'function', 'sync/positions-rollback.js exports no rollBackPositions');
  });
  after(async () => { await closeTestMongo(); });

  /** One row of `part`, with or without the 6.0 fields. `n` keeps ids and seqs apart. */
  const row = (space, part, n, { six, seq }) => ({
    _id: `${space}-${part}-${n}`, spaceId: space, seq, name: `${part}-${n}`, createdAt: '2026-01-01T00:00:00.000Z',
    ...(part === 'tombstones' ? { type: 'facts', deletedAt: '2026-01-02T00:00:00.000Z', storedVia: 'peer-x', instanceId: 'someone' } : {}),
    ...(six ? Object.fromEntries(FIELDS.map(f => [f, f === 'issuedHere' || f === 'writtenHere' ? true : 1_790_000_000_000_000 + n])) : {}),
  });

  /** Every collection of every space, every counter doc. `with6` false seeds a database no 6.0 ever touched. */
  async function seed({ with6 }) {
    for (const space of [...SPACES, PEER_SPACE]) {
      for (const part of seqMod.SEQ_CARRYING) await col(space, part).deleteMany({});
    }
    await mongo.col('ythril_counters').deleteMany({});
    for (const space of SPACES) {
      for (const part of seqMod.SEQ_CARRYING) {
        const rows = [1, 2, 3].map(n => row(space, part, n, { six: with6, seq: 100 * n }));
        rows.push(row(space, part, 4, { six: false, seq: 50 })); // a 5.6-shaped row among them
        await col(space, part).insertMany(rows);
      }
    }
    // The first space: a tombstone at 9000 is the highest version at or below the cap, and a fact at MAX_INGEST_SEQ is above it.
    await col(SPACES[0], 'tombstones').insertOne(row(SPACES[0], 'tombstones', 9, { six: with6, seq: 9000 }));
    await col(SPACES[0], 'facts').insertOne(row(SPACES[0], 'facts', 99, { six: with6, seq: seqMod.MAX_INGEST_SEQ }));
    await mongo.col('ythril_counters').insertMany([
      { _id: SPACES[0], seq: 12, seqSeenBy6: 12, ...(with6 ? { positionsReadyAt: '2026-10-01T00:00:00.000Z' } : {}) },
      { _id: SPACES[1], seq: 777_777, seqSeenBy6: 777_777, ...(with6 ? { positionsReadyAt: '2026-10-01T00:00:00.000Z' } : {}) },
    ]);
  }

  async function snapshot() {
    const out = { counters: await mongo.col('ythril_counters').find({}).sort({ _id: 1 }).toArray() };
    for (const space of SPACES) for (const part of seqMod.SEQ_CARRYING) out[`${space}_${part}`] = await col(space, part).find({}).sort({ _id: 1 }).toArray();
    return out;
  }
  const run = async () => { const lines = []; const result = await rollBackPositions(mongo.getDb(), { log: (l) => lines.push(String(l)) }); return { lines, result }; };
  const strip = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !FIELDS.includes(k)));

  beforeEach(async () => { await seed({ with6: true }); });

  it('every collection of every space loses every 6.0 field, and keeps everything else, `storedVia` included', async () => {
    const before = await snapshot();
    await run();
    const after = await snapshot();
    for (const space of SPACES) {
      for (const part of seqMod.SEQ_CARRYING) {
        for (const f of FIELDS) {
          const left = await col(space, part).countDocuments({ [f]: { $exists: true } });
          assert.equal(left, 0, `${space}_${part}: ${left} row(s) still carry ${f}`);
        }
        assert.deepEqual(after[`${space}_${part}`], before[`${space}_${part}`].map(strip), `${space}_${part}: a field the tool is not to touch changed, or a row went`);
      }
    }
    assert.ok(after[`${SPACES[0]}_tombstones`].some(t => t.storedVia === 'peer-x'), '`storedVia` is a 5.x field and must survive the tool');
  });

  it('the counters rise to the highest version at or below the cap, never fall, and every space owes a repair', async () => {
    const before = await snapshot();
    await run();
    const { counters } = await snapshot();
    const [one, two] = counters;
    assert.equal(one.seq, 9000, `${one._id}: the counter is ${one.seq}, the highest version at or below the cap is 9000 (a fact at MAX_INGEST_SEQ is above it)`);
    assert.equal(two.seq, 777_777, `${two._id}: a counter already above every version is not lowered`);
    for (const [i, c] of counters.entries()) {
      assert.equal(c.positionsOwed, 'repair', `${c._id}: does not owe a repair`);
      assert.equal('positionsReadyAt' in c, false, `${c._id}: is still marked ready`);
      assert.equal(c.seqSeenBy6, before.counters[i].seqSeenBy6, `${c._id}: seqSeenBy6 moved — it is not the tool's to move`);
    }
    assert.ok(CAP > 9000, 'the cap is below the seeded version; the fixture is wrong');
  });

  it('prints one line per space and a total, and never the database address', async () => {
    const { lines } = await run();
    const expectedRows = (space) => seqMod.SEQ_CARRYING.length * 3 + (space === SPACES[0] ? 2 : 0);
    for (const [space, old, now] of [[SPACES[0], 12, 9000], [SPACES[1], 777_777, 777_777]]) {
      const line = lines.find(l => l.startsWith(`${space}:`));
      assert.ok(line, `no line for ${space}: ${JSON.stringify(lines)}`);
      assert.match(line, new RegExp(`^${space}: ${expectedRows(space)} rows cleared, counter ${old} -> ${now}$`));
    }
    assert.ok(lines.some(l => /total/i.test(l)), `no total line: ${JSON.stringify(lines)}`);
    const text = lines.join('\n');
    assert.ok(!text.includes('mongodb://') && !text.includes(URI_PASSWORD), 'a line names the database address or its password');
  });

  it('a second run clears nothing and changes nothing', async () => {
    await run();
    const once = await snapshot();
    const { lines } = await run();
    assert.deepEqual(await snapshot(), once, 'the second run changed the database');
    for (const space of SPACES) assert.match(lines.find(l => l.startsWith(`${space}:`)) ?? '', /: 0 rows cleared/, `${space}: the second run cleared rows`);
  });

  it('a database with no 6.0 row is left as it was', async () => {
    await seed({ with6: false });
    const before = await snapshot();
    const { lines } = await run();
    const after = await snapshot();
    assert.deepEqual(after.counters.map(c => c.seq), before.counters.map(c => c.seq).map((s, i) => (i === 0 ? 9000 : s)), 'the counters of a 5.6-shaped database moved other than to the highest version');
    for (const k of Object.keys(before).filter(k => k !== 'counters')) assert.deepEqual(after[k], before[k], `${k}: a row of a 5.6-shaped database changed`);
    for (const space of SPACES) assert.match(lines.find(l => l.startsWith(`${space}:`)) ?? '', /: 0 rows cleared/, `${space}: rows were cleared that carried nothing`);
  });

  describe('a 5.6-shaped merkle over a cleared space matches its peer', () => {
    // 5.6's own list: today's local-only fields without the ones 6.0 adds. Its leaf is `doc:<collection>:<id>:<seq>:<hash>`, as `brain/merkle.ts` writes it.
    const OMIT_56 = () => new Set([...local, ...retagged].filter(f => !FIELDS.includes(f)));
    const leaf56 = (part, doc) => createHash('sha256').update(`doc:${part}:${String(doc._id)}:${String(doc.seq)}:${canonicalJsonHash(doc, { omitKeys: OMIT_56() })}`).digest('hex');
    const leaves = async (space) => {
      const out = [];
      for (const part of ['facts', 'entities', 'edges', 'chrono', 'links']) for (const d of await col(space, part).find({}).toArray()) out.push(leaf56(part, { ...d, _id: d._id.replace(space, 'x') }));
      return out.sort();
    };

    it('equal after the tool, different before it', async () => {
      // The peer holds the same data and never held a 6.0 field.
      for (const part of ['facts', 'entities', 'edges', 'chrono', 'links']) {
        const docs = (await col(SPACES[1], part).find({}).toArray()).map(d => ({ ...strip(d), _id: d._id.replace(SPACES[1], PEER_SPACE), spaceId: PEER_SPACE }));
        await col(PEER_SPACE, part).insertMany(docs);
      }
      const peer = await leaves(PEER_SPACE);
      assert.ok(peer.length >= 5, 'the peer has no rows, so the comparison is about nothing');
      assert.notDeepEqual(await leaves(SPACES[1]), peer, 'the control failed: a 5.6-shaped hash of the uncleared space already equals the peer, so the fields are not what this hash sees');
      await run();
      assert.deepEqual(await leaves(SPACES[1]), peer, 'after the tool the space still hashes differently from its peer under 5.6 rules');
    });
  });

  describe('the entry point (decision 37)', () => {
    const entry = path.join(process.cwd(), 'server', 'dist', 'tools', 'positions-rollback.js');
    const source = path.join(process.cwd(), 'server', 'src', 'tools', 'positions-rollback.ts');

    it('the source never calls loadConfig', () => {
      assert.ok(fs.existsSync(source), `${path.relative(process.cwd(), source)} does not exist`);
      const text = fs.readFileSync(source, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(!/loadConfig/.test(text), 'the tool calls loadConfig, which runs the boot migrations and writes config.json');
    });

    it('the built entry clears the database named by the settings the server reads and leaves config.json byte for byte as it found it', async () => {
      assert.ok(fs.existsSync(entry), `${path.relative(process.cwd(), entry)} is not built: the server build emits no tools/positions-rollback.js`);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b81d-rollback-'));
      try {
        const configPath = path.join(dir, 'config.json');
        // An old-shaped config: the shape `loadConfig`'s migrations rewrite, so a call to it would show as a changed file.
        fs.writeFileSync(configPath, JSON.stringify({ instanceId: 'rb', instanceLabel: 'rb', tokens: [], networks: [], spaces: SPACES.map(id => ({ id, label: id, folders: [] })) }, null, 3));
        const bytes = fs.readFileSync(configPath);
        const mtime = fs.statSync(configPath).mtimeMs;
        const out = spawnSync(process.execPath, [entry], {
          env: { ...process.env, CONFIG_PATH: configPath, DATA_ROOT: path.join(dir, 'data'), MONGO_URI: testMongoUri(`ythril_harness_${SUITE}`) },
          encoding: 'utf8', timeout: 60_000,
        });
        assert.equal(out.status, 0, `the tool exited ${out.status}: ${out.stderr?.slice(0, 400)}${out.stdout?.slice(0, 200)}`);
        assert.ok(fs.readFileSync(configPath).equals(bytes), 'the tool rewrote config.json');
        assert.equal(fs.statSync(configPath).mtimeMs, mtime, 'the tool touched config.json');
        assert.ok(!(out.stdout + out.stderr).includes(URI_PASSWORD), 'the tool printed the database password');
        assert.match(out.stdout, new RegExp(`${SPACES[0]}: \\d+ rows cleared`), `the tool printed no line for ${SPACES[0]}: ${out.stdout.slice(0, 300)}`);
        // The entry ran against the database `beforeEach` seeded with 6.0 fields: the settings it read named THAT database.
        for (const f of FIELDS) assert.equal(await col(SPACES[0], 'facts').countDocuments({ [f]: { $exists: true } }), 0, `${f} is still on a fact after the entry ran`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  });
});
