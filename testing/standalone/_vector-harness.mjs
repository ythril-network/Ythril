/**
 * A vector index that is really serving the records a test put there — for the `-db` tests that RANK.
 *
 * ## Why this is a module
 *
 * A test about which records a `$vectorSearch` returns can pass or fail for three reasons that have nothing to
 * do with the code under test, and each one has been hand-handled (or not) per file:
 *
 *  1. **No index, or the wrong one.** `$vectorSearch` against a missing index matches nothing, so a suite that
 *     hand-rolls an index definition measures its own copy of the definition rather than production's. The
 *     index here is always built by production's own `reconcileSpaceSearchIndexes` / `ensureVectorSearchIndex`.
 *  2. **Index lag.** READY is not "has ingested every document". A recall issued the moment the index reports
 *     READY can still miss records, which reads exactly like the defect a completeness test is looking for.
 *     `waitUntilServing` polls an UNFILTERED exact count until it equals what was inserted, and THROWS if it
 *     never does — the forgettable guard, so a caller cannot receive a half-built index quietly.
 *  3. **Which stage ran.** A test that says "stage 1 answered, no collection pass happened" has to observe it
 *     from the DATABASE's side, not from a probe inside the code under test — a probe is a claim the code makes
 *     about itself. `recordTraffic` reads Mongo's own profiler for the harness database.
 *
 * The vectors are unit vectors in the plane of axes 0 and 2, placed by ANGLE from the query axis. Similarity to
 * the query is then a known, monotonic function of the angle (`(1 + cos θ) / 2` for cosine), so a test can
 * compute the exact expected ranking in JS without trusting the engine it is testing. Keep the angles apart by
 * more than a few thousandths of a degree away from 0°, or float32 storage turns neighbours into ties.
 */
import http from 'node:http';

/** A unit vector at `deg` degrees from axis 0, in the axis-0/axis-2 plane. */
export function unitAt(deg, dims) {
  const v = new Array(dims).fill(0);
  const th = (deg * Math.PI) / 180;
  v[0] = Math.cos(th);
  v[2] = Math.sin(th);
  return v;
}

/** The query every angle is measured from. */
export const queryAxis = (dims) => unitAt(0, dims);

/** Cosine similarity to the query axis on the engine's scale, for computing expected rankings in JS. */
export const cosineScoreAt = (deg) => (1 + Math.cos((deg * Math.PI) / 180)) / 2;

/**
 * An OpenAI-shaped embedding endpoint that answers with `vectorFor(text)`, so the real `embed()` path runs over
 * HTTP rather than being stubbed as a function. Sets `EMBEDDING_URL`; call before importing the server modules.
 */
export async function startStubEmbedder(vectorFor) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const input = JSON.parse(body || '{}').input;
      const texts = Array.isArray(input) ? input : [input];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: texts.map((t, index) => ({ index, embedding: vectorFor(String(t)) })) }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  process.env['EMBEDDING_URL'] = `http://127.0.0.1:${server.address().port}`;
  return { close: () => new Promise(r => server.close(r)) };
}

/**
 * Create a space's five vector-indexed collections. mongot answers `NamespaceNotFound` rather than creating
 * one, and `initSpace` is not used because it also creates the space's FILE directory, which a CI runner
 * cannot write (`EACCES: mkdir '/data'`).
 */
export async function createSpaceCollections(mongo, spaceId) {
  const { VECTOR_INDEXED_COLLECTIONS } = await import('../../server/dist/spaces/vector-index.js');
  const existing = new Set((await mongo.getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  for (const suffix of VECTOR_INDEXED_COLLECTIONS) {
    const name = `${spaceId}_${suffix}`;
    if (!existing.has(name)) await mongo.getDb().createCollection(name);
  }
}

/** Insert in batches, so a twenty-thousand-record fixture is one round trip per few thousand. */
export async function insertAll(mongo, collName, docs, batch = 5000) {
  for (let i = 0; i < docs.length; i += batch) await mongo.col(collName).insertMany(docs.slice(i, i + batch));
}

/**
 * Wait until the index answers an UNFILTERED exact search with every one of `n` records, or throw.
 *
 * Throws rather than returning false: a caller handed a half-ingested index would run its assertions against
 * it and report the lag as the defect — or, worse, as the fix.
 */
export async function waitUntilServing(mongo, collName, indexName, { path = 'embedding', dims, n, timeoutMs = 120_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'nothing yet';
  while (Date.now() < deadline) {
    try {
      const rows = await mongo.col(collName).aggregate([
        { $vectorSearch: { index: indexName, path, queryVector: queryAxis(dims), exact: true, limit: n } },
        { $count: 'n' },
      ]).toArray();
      const seen = rows[0]?.n ?? 0;
      if (seen === n) return;
      last = `${seen} of ${n}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${indexName} never served all ${n} records within ${timeoutMs} ms (last: ${last}). `
    + 'A ranking test run against a half-ingested index measures the lag, not the code.');
}

/** The filter paths the index's LIVE definition declares — what the server holds, not what we asked for. */
export async function liveFilterPaths(mongo, collName, indexName) {
  const all = await mongo.col(collName).listSearchIndexes().toArray();
  const found = all.find(i => i.name === indexName);
  return (found?.latestDefinition?.fields ?? []).filter(f => f.type === 'filter').map(f => f.path);
}

/**
 * Run `fn` with Mongo's profiler recording every operation on the harness database, and return the operations
 * it issued against `collName`, oldest first.
 *
 * The profiler truncates a large command into a string (`$truncated`), which is exactly what a stage-2 search
 * carrying twenty thousand ids looks like — so every classifier below reads the command's TEXT, which survives
 * truncation, rather than its structure, which does not.
 */
export async function recordTraffic(mongo, collName, fn) {
  const db = mongo.getDb();
  await db.command({ profile: 0 });
  await db.collection('system.profile').drop().catch(() => {});
  // A large profile collection: the default 1 MB cap would roll over during a pass over twenty thousand ids.
  await db.createCollection('system.profile', { capped: true, size: 64 * 1024 * 1024 }).catch(() => {});
  await db.command({ profile: 2 });
  let result;
  try {
    result = await fn();
  } finally {
    await db.command({ profile: 0 });
  }
  const ops = await db.collection('system.profile')
    .find({ ns: `${db.databaseName}.${collName}` }).sort({ ts: 1 }).toArray();
  return { result, ops: ops.map(o => ({ op: o.op, text: JSON.stringify(o.command ?? {}) })) };
}

/** A `$vectorSearch` whose native filter names `_id` — the signature of scoring a candidate id set. */
export function isIdFilteredSearch(op) {
  return /\$vectorSearch/.test(op.text)
    && /filter\\?"?\s*:\s*\{\s*(?:\\?"?\$and\\?"?\s*:\s*\[\s*\{\s*)?\\?"?_id\\?"?\s*:/.test(op.text);
}

/**
 * A read of the COLLECTION itself that applies the caller's predicate — a `find`, or an aggregate that opens
 * with `$match` — as opposed to a read of the index. The fresh-write scan opens with `$sort` and is not one.
 */
export function isCollectionPass(op, predicateKey) {
  if (!op.text.includes(predicateKey)) return false;
  if (/^\{"find"/.test(op.text)) return true;
  return /^\{"aggregate"[^[]*"pipeline":\[\{"\$match"/.test(op.text);
}
