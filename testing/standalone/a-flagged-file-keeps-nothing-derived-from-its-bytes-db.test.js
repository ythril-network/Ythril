/**
 * With `softDeleteFileMeta` on, a file's deletion FLAG strips, in the same write, everything derived from the bytes it no longer has
 * (bundle-89, E2 / Q-418, plan rev 3 items 1 to 3).
 *
 * ## The rule, over every way a row gets flagged
 *
 * A flagged row is this instance's audit record of a deleted file. What the audit needs is: the path, the author, `createdAt`,
 * `deletedAt`, the retention stamp, the tags, the properties and a description a PERSON wrote. Nothing derived from the bytes:
 *
 *  - `embedding`, `embeddingModel`, `matchedText`: the vector and the text it was made from, still findable by the mechanism the
 *    delete was meant to end;
 *  - `excerpt`: the document's own opening prose, verbatim;
 *  - `sha256` and `embeddingStatus`: a fingerprint of bytes that are gone, and a 'complete' that makes `settledAndIdentical` skip
 *    the reprocessing of the same bytes uploaded to a revived path;
 *  - a MACHINE-MADE `description` (`descriptionSource` 'generated' or 'extracted') together with its marker: `describeDocument`
 *    returns the document's opening prose as the description when no model is available, so keeping it keeps the bytes' own words.
 *    A description with no `descriptionSource` was written by a person and STAYS.
 *
 * ## Why one case per door, and one for the primitives
 *
 * There are two flag primitives and they do not share a path: `markFileMetaDeleted` (one row) and `markFileMetaDeletedByPrefix` (a
 * directory's rows, reached from `retireFileMetaUnder`, which a directory delete calls). The first draft of the plan guarded the
 * wrapper `retireFileMeta` and "every soft-delete caller" did not include the directory one. So each flag path is driven through its
 * own real door, each in its own `it` so each is seen red alone, and the primitives are called directly as well, so a door added
 * next year that flags a row by a route of its own is still held to the rule by the table's last rows.
 *
 * Rows are seeded WITH real derived fields: the existing delete helpers open their space with `suppressEmbeddings: true`, which
 * would make a missing strip look like a vector that was never there.
 *
 * Run: node --test testing/standalone/a-flagged-file-keeps-nothing-derived-from-its-bytes-db.test.js
 * (requires a prior `npm run build:server`, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'b89e2a';
const T0 = '2026-09-01T00:00:00.000Z';
const EXPIRES = new Date('2099-01-01T00:00:00.000Z');
/** The peer whose bytes landed at a sidecar path, or whose tombstone is applied: author and deliverer. */
const PEER = 'b89e2a-peer';
const PEER_AUTHOR = Object.freeze({ instanceId: PEER, instanceLabel: 'Peer' });
const SELF_AUTHOR = Object.freeze({ instanceId: 'b89e2a-receiver', instanceLabel: 'Receiver' });

/** Everything derived from the bytes (plan rev 3, E2 item 1): none of it may be on a flagged row. */
const DERIVED_FROM_BYTES = ['embedding', 'embeddingModel', 'matchedText', 'excerpt', 'sha256', 'embeddingStatus'];
/** The audit record: all of it stays. */
const AUDIT_RECORD = ['path', 'author', 'createdAt', 'deletedAt', '_expireAt', 'tags', 'properties'];

/** The three kinds of description a row can hold, and whether the flag keeps it. */
const DESCRIPTIONS = {
  human: { fields: { description: 'written by a person, for people' }, kept: true },
  generated: { fields: { description: 'a model summarised the document', descriptionSource: 'generated' }, kept: false },
  extracted: { fields: { description: 'the document\'s own opening prose, taken verbatim', descriptionSource: 'extracted' }, kept: false },
};

let acts, door, loader, fileMeta, retirement, peerApply;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });

/** A row of a file as a finished upload and a finished processing run leave it: every derived field present. */
function fullRow(id, kind, { author = SELF_AUTHOR, seq = 3, extra = {} } = {}) {
  return {
    _id: id, spaceId: S, path: id, sizeBytes: 21, tags: ['audit-tag'], properties: { owner: 'finance' }, author: { ...author },
    createdAt: T0, updatedAt: T0, seq, _expireAt: EXPIRES,
    embedding: [0.1, 0.2, 0.3, 0.4], embeddingModel: 'model-a', matchedText: `text of ${id}`, excerpt: `opening prose of ${id}`,
    sha256: 'ab'.repeat(32), embeddingStatus: 'complete',
    ...DESCRIPTIONS[kind].fields,
    ...extra,
  };
}

/** Bytes on this instance's disk. */
function put(rel) {
  const abs = path.join(acts.root(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `bytes of ${rel}`);
}

/** Insert one row per description kind, with their bytes; returns `{ kind, id }` for each. */
async function seedKinds(idOf, opts = {}) {
  const seeded = [];
  for (const kind of Object.keys(DESCRIPTIONS)) {
    const id = idOf(kind);
    put(id);
    await door.coll(S, 'files').insertOne(fullRow(id, kind, opts));
    seeded.push({ kind, id });
  }
  return seeded;
}

/**
 * Everything wrong with one row after its flag, named `<label> <id>: <what>` — identities, not a count, so a failure says which row
 * kept which field. A row that is not flagged at all is the fixture's failure and is said as such.
 */
async function problemsOf({ kind, id }, label) {
  const row = await rowOf(id);
  if (row === null) return [`${label} ${id}: the row is gone (fixture: softDeleteFileMeta is on, the row must be FLAGGED)`];
  if (typeof row.deletedAt !== 'string') return [`${label} ${id}: the row was not flagged (fixture)`];
  const problems = [];
  for (const f of DERIVED_FROM_BYTES) if (f in row) problems.push(`${label} ${id}: flagged row keeps ${f}`);
  if (DESCRIPTIONS[kind].kept) {
    if (row.description !== DESCRIPTIONS[kind].fields.description) problems.push(`${label} ${id}: a human-written description was dropped`);
  } else {
    if ('description' in row) problems.push(`${label} ${id}: flagged row keeps a ${kind} description`);
    if ('descriptionSource' in row) problems.push(`${label} ${id}: flagged row keeps descriptionSource ${row.descriptionSource}`);
  }
  for (const f of AUDIT_RECORD) if (!(f in row)) problems.push(`${label} ${id}: the audit record lost ${f}`);
  return problems;
}

async function assertNothingDerivedKept(seeded, label) {
  const problems = [];
  for (const s of seeded) problems.push(...await problemsOf(s, label));
  assert.deepEqual(problems, [], `${label}: a flagged file kept what its deleted bytes made, or lost its audit record`);
}

const ok = (a, what) => assert.ok(!acts.failed(a), `${what}: ${JSON.stringify(a.body ?? a.text)}`);

/**
 * The flag paths: the doors that flag a row on this instance. Each seeds its own rows, acts, and returns the seeded `{ kind, id }`
 * list.
 */
const FLAG_PATHS = {
  'REST file delete': async () => {
    const seeded = await seedKinds(k => `docs/rest-${k}.txt`);
    for (const s of seeded) ok(await acts.del('REST', s.id), `REST delete ${s.id}`);
    return seeded;
  },
  'MCP delete_file': async () => {
    const seeded = await seedKinds(k => `docs/mcp-${k}.txt`);
    for (const s of seeded) ok(await acts.del('MCP', s.id), `MCP delete_file ${s.id}`);
    return seeded;
  },
  'a DIRECTORY delete (markFileMetaDeletedByPrefix via retireFileMetaUnder)': async () => {
    const seeded = await seedKinds(k => `docs/dir/${k}.txt`);
    ok(await acts.rest('DELETE', { path: 'docs/dir' }, { confirm: true }), 'REST directory delete');
    return seeded;
  },
  'a peer\'s file tombstone applied to the file (removeFileHere)': async () => {
    const seeded = await seedKinds(k => `docs/peer-${k}.txt`, { author: PEER_AUTHOR });
    const tombstones = seeded.map(s => ({ _id: `ft-${s.id}`, path: s.id, deletedAt: '2026-09-02T00:00:00.000Z', issuer: PEER, rowSeq: 5 }));
    const out = await peerApply.applyPeerFileTombstones(S, tombstones, { peerInstanceId: PEER, trustedRelay: false, upstream: false }, 'b89e2a');
    assert.deepEqual({ refused: out.refused, declined: out.declined }, { refused: [], declined: [] }, 'fixture: the peer\'s tombstones were not applied');
    return seeded;
  },
  'sidecar rows a peer delivered, retired with their file (deleteConversionArtifacts)': async () => {
    put('docs/with-sidecars.txt');
    await door.coll(S, 'files').insertOne({ _id: 'docs/with-sidecars.txt', spaceId: S, path: 'docs/with-sidecars.txt', sizeBytes: 3, tags: [], createdAt: T0, updatedAt: T0, seq: 3, author: { ...SELF_AUTHOR } });
    // TOP-LEVEL rows at the file's sidecar paths (no parentFileId): what a peer's bytes made before sidecars became instance-local.
    const seeded = await seedKinds(
      k => (k === 'human' ? '_converted/docs/with-sidecars.txt.md' : k === 'generated' ? '_extracted/docs/with-sidecars.txt/a.jpg' : '_extracted/docs/with-sidecars.txt/b.jpg'),
      { author: PEER_AUTHOR, seq: 0, extra: { deliveredBy: PEER } },
    );
    ok(await acts.del('REST', 'docs/with-sidecars.txt'), 'REST delete of the file the sidecars belong to');
    return seeded;
  },
  'the sweep that retires a peer\'s sidecars (retireFileMeta)': async () => {
    const seeded = await seedKinds(
      k => `_converted/docs/swept-${k}.txt.md`,
      { author: PEER_AUTHOR, seq: 0, extra: { deliveredBy: PEER } },
    );
    const n = await retirement.retirePeerSidecars();
    assert.ok(n >= seeded.length, `fixture: the sweep retired ${n} sidecars, want at least ${seeded.length}`);
    return seeded;
  },
  'markFileMetaDeleted, called directly': async () => {
    const seeded = await seedKinds(k => `docs/prim-one-${k}.txt`);
    for (const s of seeded) await fileMeta.markFileMetaDeleted(S, s.id);
    return seeded;
  },
  'markFileMetaDeletedByPrefix, called directly': async () => {
    const seeded = await seedKinds(k => `docs/prim-prefix/${k}.txt`);
    await fileMeta.markFileMetaDeletedByPrefix(S, 'docs/prim-prefix');
    return seeded;
  },
  'retireFileMeta, called directly': async () => {
    const seeded = await seedKinds(k => `docs/prim-retire-${k}.txt`);
    for (const s of seeded) await fileMeta.retireFileMeta(S, s.id);
    return seeded;
  },
  'retireFileMetaUnder, called directly': async () => {
    const seeded = await seedKinds(k => `docs/prim-under/${k}.txt`);
    await fileMeta.retireFileMetaUnder(S, 'docs/prim-under');
    return seeded;
  },
};

describe('a flagged file row keeps nothing derived from its bytes, on every path that flags one (E2, Q-418)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: S, space: S });
    ({ door } = acts);
    loader = await import('../../server/dist/config/loader.js');
    fileMeta = await import('../../server/dist/files/file-meta.js');
    retirement = await import('../../server/dist/sync/peer-sidecar-retirement.js');
    peerApply = await import('../../server/dist/files/peer-tombstone-apply.js');
  });
  after(async () => {
    if (loader) loader.getConfig().softDeleteFileMeta = false;
    await acts?.close();
  });
  beforeEach(async () => {
    await acts.reset();
    loader.getConfig().softDeleteFileMeta = true;
  });

  it('the table covers the doors, and the fixture rows hold every derived field before the flag (control)', async () => {
    assert.ok(Object.keys(FLAG_PATHS).length >= 8, 'a flag path was dropped from the table');
    const row = fullRow('x', 'generated');
    for (const f of DERIVED_FROM_BYTES) assert.ok(f in row, `fixture: ${f} is not seeded, so a strip of it would be invisible`);
    for (const f of ['markFileMetaDeleted', 'markFileMetaDeletedByPrefix', 'retireFileMeta', 'retireFileMetaUnder']) {
      assert.equal(typeof fileMeta[f], 'function', `${f} is not exported from files/file-meta.js: re-anchor this test`);
    }
  });

  for (const [name, run] of Object.entries(FLAG_PATHS)) {
    it(`${name}: the flagged rows hold none of what the bytes made, and keep the audit record`, async () => {
      const seeded = await run();
      assert.equal(seeded.length, Object.keys(DESCRIPTIONS).length, 'fixture: a path seeded the wrong rows');
      await assertNothingDerivedKept(seeded, name);
    });
  }
});
