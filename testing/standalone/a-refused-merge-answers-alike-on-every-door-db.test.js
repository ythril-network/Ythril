/**
 * A merge is refused the same way on every door that can run one — with nothing written, and the status the
 * refusal means (`Q-107` part 3a).
 *
 * ## The doors
 *
 * Four callers run `executeMerge`, and they are DERIVED here from the source, not listed: the REST merge route
 * (`POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId`), the duplicate review's
 * `POST /api/duplicates/:id/merge`, the `graph_merge` tool through `callTool` (the dispatch both the MCP
 * transport and `POST /api/graph_merge` use), and the duplicate scanner's unattended `automerge`. A fifth caller
 * without a driver below fails the derivation: a door this file cannot send a merge through is a door whose
 * refusal nobody checks.
 *
 * ## The two refusals, and what each door must answer
 *
 *  - **Too large** (`MergeTooLarge`). A merge relinks every edge, link and face label of the absorbed entity inside
 *    one transaction; on a hub that is a transaction the store cannot hold (or holds the sync horizon for minutes).
 *    The plan bounds it at `MERGE_MAX_RELINKS` (absorbed edges + links + files), refused BEFORE any write. The HTTP
 *    doors answer `422 merge_too_large` naming the count and the bound; automerge skips the pair with a warning
 *    naming both. The bound's VALUE is set from measurement (`testing/bench/merge-hub-in-one-transaction.mjs`), so
 *    it is read from the module that exports it — found in the source, not imported by a guessed path. A merge of
 *    exactly the bound must succeed on every door, or the bound refuses what it claims to admit.
 *  - **The survivor would break its strict schema** (`MergeSchemaViolation`). Thrown inside the transaction, so
 *    nothing lands — and it is the CALLER's refusal: `400` on every HTTP door. Today the REST merge route lets it
 *    reach the global error handler (`500 Internal server error`) and the duplicate route catches it as a `500`,
 *    while the tool door answers `400`: one refusal, two answers, picked by which client the caller used.
 *
 * Automerge has no status to answer, so its refusal is a warning — ONE per pair, naming it, with the pair left open
 * for review and skipped on the next scan while it is unchanged. Today a refused pair is re-merged (a whole
 * transaction, rolled back) and warned about on every scan, once from each end.
 *
 * "Nothing written" is read from every record collection, the tombstones, the embed queue and the space counter,
 * before and after, compared whole — a count would pass a merge that wrote one record and removed another.
 *
 * Automerge is reached for real: the scanner finds the pair by `$vectorSearch` over the stored vectors (the harness
 * Mongo is Atlas Local), so the space is created with its vector index and the case waits until the index sees the
 * pair. `YTHRIL_MODELS_OFFLINE` keeps the survivor's re-embed from downloading a model: the merge swallows an embed
 * failure, which is the behaviour it has when the model is unavailable.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-refused-merge-answers-alike-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { seedHub, relinkProblems, vectorOf } from './_merge-hub.mjs';

const skip = await mongoSkipReason();

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-doors-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const INSTANCE = 'merge-doors-receiver';
const AUTHOR = { instanceId: INSTANCE, instanceLabel: 'Receiver' };
/** One space per refusal, so the strict schema cannot refuse a bound case and the bound cannot refuse a schema one. */
const OPEN = 'mergedoors';
const STRICT = 'mergedoorsstrict';
const AUTOMERGE = [{ minScore: 0.5, action: 'automerge', types: ['entity'] }];
const DIMS = 768;

let mongo, callTool, scanSpace, findSimilar, bumpSeq, log, ADMIN;
const handlers = {};
let tokenSerial = 0;

const coll = (space) => (part) => mongo.col(`${space}_${part}`);
const PARTS = ['entities', 'edges', 'facts', 'chrono', 'links', 'files', 'tombstones', 'embed_jobs'];

/** Everything a merge could have written, whole and in a stable order. */
async function snapshot(space) {
  const out = {};
  for (const p of PARTS) out[p] = await coll(space)(p).find({}).sort({ _id: 1 }).toArray();
  out.counter = (await mongo.col('ythril_counters').findOne({ _id: space }))?.seq ?? 0;
  return out;
}

/** The parts of two snapshots that differ — named, so a failure says WHAT a refused merge wrote. */
function changed(before_, after_, { ignore = [] } = {}) {
  return Object.keys(before_).filter(k => !ignore.includes(k) && JSON.stringify(before_[k]) !== JSON.stringify(after_[k]));
}

async function wipe(space) {
  for (const p of [...PARTS, 'dupe_candidates']) await coll(space)(p).deleteMany({});
}

// ── the doors: each answers { status, text } — status a number for HTTP doors, 'merged' / 'refused' for automerge ──

/** What `app.ts`'s global error handler answers for a handler that threw (it is inline there, so it is mirrored). */
const statusOfThrown = (err) => {
  const s = err && typeof err === 'object' && typeof err.status === 'number' ? err.status : undefined;
  return s !== undefined && s >= 400 && s < 600 ? s : 500;
};

function response() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; }, set() { return this; }, get() { return undefined; },
  };
}
const token = () => ({ id: `merge-doors-${++tokenSerial}`, name: 'merge-doors', rights: ADMIN });

const DRIVERS = {
  /** POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId */
  'server/src/api/brain/entities.ts': async (space, hub) => {
    const res = response();
    try {
      await handlers.rest({ params: { spaceId: space, survivorId: hub.survivorId, absorbedId: hub.absorbedId },
        query: {}, body: {}, headers: {}, ip: '127.0.0.1', authToken: token(), get: () => undefined }, res);
    } catch (err) {
      return { status: statusOfThrown(err), text: String(err?.message ?? err) };
    }
    return { status: res.statusCode, text: JSON.stringify(res.body ?? '') };
  },
  /** POST /api/duplicates/:id/merge — the candidate the scanner would have recorded. */
  'server/src/api/duplicates.ts': async (space, hub) => {
    const [aId, bId] = [hub.survivorId, hub.absorbedId].sort();
    const _id = `entity:${aId}:${bId}`;
    const seqOf = (id) => (id === hub.survivorId ? 1 : 2);
    await coll(space)('dupe_candidates').insertOne({ _id, spaceId: space, type: 'entity', aId, bId,
      aSeq: seqOf(aId), bSeq: seqOf(bId), score: 0.99, status: 'open', detectedAt: 'x', updatedAt: 'x' });
    const res = response();
    try {
      await handlers.dupes({ params: { id: _id }, query: {}, body: {}, headers: {}, ip: '127.0.0.1',
        authToken: token(), get: () => undefined }, res);
    } catch (err) {
      return { status: statusOfThrown(err), text: String(err?.message ?? err) };
    }
    return { status: res.statusCode, text: JSON.stringify(res.body ?? '') };
  },
  /** `graph_merge` through `callTool` — MCP and `POST /api/graph_merge` alike. */
  'server/src/mcp/tools/entity.ts': async (space, hub) => {
    const t = token();
    const out = await callTool({
      name: 'graph_merge',
      args: { space, survivorId: hub.survivorId, absorbedId: hub.absorbedId },
      caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: t.id, tokenLabel: t.name },
    });
    return { status: out.status, text: (out.result.content ?? []).map(c => c.text ?? '').join('\n') };
  },
  /** The duplicate scanner's `automerge` rule, reached through a real scan. */
  'server/src/brain/dupe-scanner.ts': async (space, hub) => {
    // The pair must be visible to $vectorSearch before the scan, or the scan finds nothing and "not merged" would
    // read as a refusal.
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await findSimilar(space, hub.survivorId, 'entity', 5, ['entity']).catch(() => ({ results: [] }));
      if (r.results.some(x => x._id === hub.absorbedId)) break;
      assert.ok(Date.now() < deadline, 'the vector index never saw the seeded pair, so automerge cannot be asked');
      await new Promise(res => setTimeout(res, 250));
    }
    const lines = [];
    const orig = log.warn;
    log.warn = (...a) => { lines.push(a.join(' ')); };
    try { await scanSpace(space, { reset: true }); } finally { log.warn = orig; }
    const merged = !(await coll(space)('entities').findOne({ _id: hub.absorbedId }));
    const candidate = await coll(space)('dupe_candidates').findOne({});
    // Only the lines about THIS pair: the survivor's re-embed warns that the (offline) model is unavailable, which
    // is the merge's business and not the refusal's.
    const aboutPair = (ls) => ls.filter(l => l.includes(hub.absorbedId) || l.includes(hub.survivorId));
    return { status: merged ? 'merged' : 'refused', text: aboutPair(lines).join('\n'), candidate,
      again: async () => {
        const more = [];
        log.warn = (...a) => { more.push(a.join(' ')); };
        try { await scanSpace(space, { reset: true }); } finally { log.warn = orig; }
        return aboutPair(more);
      } };
  },
};

/** The callers of `executeMerge`, read from the source with comments stripped, minus its definition. */
function mergeDoors() {
  const files = readTrackedSources('server/src', { untracked: true, floor: 300 })
    .filter(({ text }) => /\bexecuteMerge\s*\(/.test(stripComments(text).replace(/(?:async\s+)?function\s+executeMerge\s*\(/g, '')))
    .map(f => f.file);
  return files;
}

/** The module that exports `MERGE_MAX_RELINKS`, found in the source; its compiled twin is imported. */
async function mergeBound() {
  const defining = readTrackedSources('server/src', { untracked: true, floor: 300 })
    .filter(({ text }) => /export\s+const\s+MERGE_MAX_RELINKS\b/.test(stripComments(text)));
  assert.equal(defining.length, 1,
    `MERGE_MAX_RELINKS is exported by ${defining.length} server module(s) (${defining.map(d => d.file).join(', ') || 'none'}) — `
    + 'the merge bound the plan names does not exist, so no door can refuse a merge too large to run in one transaction');
  const dist = `../../${defining[0].file.replace(/^server\/src\//, 'server/dist/').replace(/\.ts$/, '.js')}`;
  const bound = (await import(dist)).MERGE_MAX_RELINKS;
  assert.ok(Number.isInteger(bound) && bound > 2, `MERGE_MAX_RELINKS is ${bound}, not a usable bound`);
  return bound;
}

describe('a refused merge answers alike on every door', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergedoors');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Receiver', tokens: [], networks: [],
      dupeScanner: { types: ['entity'] },
      spaces: [
        { id: OPEN, label: 'Open', folders: [], completeLinkage: true, meta: {}, dupeRules: AUTOMERGE },
        { id: STRICT, label: 'Strict', folders: [], completeLinkage: true, dupeRules: AUTOMERGE,
          // An allowlist of entity types the seeded entities ('thing') are not in: the merged survivor breaks it.
          meta: { validationMode: 'strict', typeSchemas: { entity: { person: {} } } } },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await mongo.checkVectorSearchAvailability();
    const { initSpace } = await import('../../server/dist/spaces/lifecycle.js');
    for (const s of [OPEN, STRICT]) await initSpace(s, { waitForVectorReady: true });

    const { entitiesRouter } = await import('../../server/dist/api/brain/entities.js');
    const { duplicatesRouter } = await import('../../server/dist/api/duplicates.js');
    const final = (router, p) => {
      const layer = router.stack.find(l => l.route?.path === p && l.route.methods?.post);
      assert.ok(layer, `POST ${p} is gone or moved — re-anchor this test`);
      return layer.route.stack.at(-1).handle;
    };
    handlers.rest = final(entitiesRouter, '/spaces/:spaceId/entities/:survivorId/merge/:absorbedId');
    handlers.dupes = final(duplicatesRouter, '/:id/merge');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ scanSpace } = await import('../../server/dist/brain/dupe-scanner.js'));
    ({ findSimilar } = await import('../../server/dist/brain/recall.js'));
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
    ({ log } = await import('../../server/dist/util/log.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => { for (const s of [OPEN, STRICT]) await wipe(s); });

  /** A hub in `space` relinking `n` records: one link, one face label, and the rest edges. */
  async function hubOf(space, n) {
    assert.ok(n >= 2, `a hub of ${n} relinks cannot carry a link and a face label`);
    const hub = await seedHub({ coll: coll(space), space, author: AUTHOR, edges: n - 2, links: 1, faces: 1,
      entityVector: vectorOf(DIMS) });
    assert.equal(hub.relinks, n);
    await bumpSeq(space, hub.maxSeq);
    return hub;
  }

  it('every caller of executeMerge has a driver here, and there are at least four', () => {
    const doors = mergeDoors();
    assert.ok(doors.length >= 4, `only ${doors.length} caller(s) of executeMerge found — the derivation is broken: ${doors}`);
    assert.deepEqual([...doors].sort(), Object.keys(DRIVERS).sort(),
      'a caller of executeMerge has no driver in this file (or a driver names a file that no longer merges) — every '
      + 'door a merge can run through must be asked how it refuses one');
  });

  describe('a merge whose survivor breaks its strict schema', () => {
    for (const [door, drive] of Object.entries(DRIVERS)) {
      it(`${door}: is refused as the caller's error, and nothing is written`, async () => {
        const hub = await hubOf(STRICT, 3);
        const before_ = await snapshot(STRICT);
        const out = await drive(STRICT, hub);
        const after_ = await snapshot(STRICT);
        if (door.endsWith('dupe-scanner.ts')) {
          assert.equal(out.status, 'refused', `automerge merged a pair the strict schema refuses: ${out.text}`);
          assert.match(out.text, new RegExp(hub.absorbedId), 'the refusal was not reported naming the pair');
          assert.equal(out.text.split('\n').length, 1, `one scan warned ${out.text.split('\n').length} times about one pair:\n${out.text}`);
          assert.equal(out.candidate?.status, 'open', 'a refused pair must stay open for review');
          assert.deepEqual(await out.again(), [], 'an unchanged refused pair was warned about again');
        } else {
          assert.equal(out.status, 400,
            `${door} answered ${out.status} for a merge the space's strict schema refuses — the refusal is the `
            + `caller's (400), on every door: ${out.text}`);
        }
        // The counter is not compared here: this refusal is thrown INSIDE the transaction, after seqs were taken,
        // and a seq taken and never used is a gap — safe by design (`util/seq.ts`), unlike a reused one.
        assert.deepEqual(changed(before_, after_, { ignore: ['counter'] }), [], `${door}: a refused merge changed the space`);
      });
    }
  });

  describe('the merge bound', () => {
    for (const [door, drive] of Object.entries(DRIVERS)) {
      it(`${door}: a merge of exactly MERGE_MAX_RELINKS relinks succeeds`, { timeout: 600_000 }, async () => {
        const bound = await mergeBound();
        const hub = await hubOf(OPEN, bound);
        const out = await drive(OPEN, hub);
        if (door.endsWith('dupe-scanner.ts')) assert.equal(out.status, 'merged', `automerge refused a merge at the bound: ${out.text}`);
        else assert.equal(out.status, 200, `${door} refused a merge at the bound: ${out.text}`);
        assert.deepEqual(await relinkProblems({ coll: coll(OPEN), hub }), [], `${door}: the merge at the bound did not land whole`);
      });

      it(`${door}: one relink over the bound is refused before any write`, { timeout: 600_000 }, async () => {
        const bound = await mergeBound();
        const hub = await hubOf(OPEN, bound + 1);
        const before_ = await snapshot(OPEN);
        const out = await drive(OPEN, hub);
        const after_ = await snapshot(OPEN);
        if (door.endsWith('dupe-scanner.ts')) {
          assert.equal(out.status, 'refused', `automerge merged a hub over the bound`);
          for (const n of [bound + 1, bound]) {
            assert.match(out.text, new RegExp(`\\b${n}\\b`), `the automerge warning does not name ${n} (the count and the bound): ${out.text}`);
          }
          assert.match(out.text, new RegExp(hub.absorbedId), 'the warning does not name the pair it skipped');
          assert.equal(out.text.split('\n').length, 1, `one scan warned ${out.text.split('\n').length} times about one pair:\n${out.text}`);
          assert.equal(out.candidate?.status, 'open', 'a refused pair must stay open for review');
          assert.deepEqual(await out.again(), [], 'an unchanged refused pair was warned about again');
        } else {
          assert.equal(out.status, 422, `${door} answered ${out.status} for a merge over the bound: ${out.text}`);
          assert.match(out.text, /merge_too_large/, `${door}: the refusal does not say merge_too_large: ${out.text}`);
          for (const n of [bound + 1, bound]) {
            assert.match(out.text, new RegExp(`\\b${n}\\b`), `${door}: the refusal does not name ${n} (the count and the bound)`);
          }
        }
        assert.deepEqual(changed(before_, after_), [],
          `${door}: a merge over the bound changed the space — it must be refused before any write (the counter included)`);
      });
    }
  });
});
