/**
 * A retried write must converge, not duplicate.
 *
 * ## The finding this closes
 *
 * An MCP agent or an integrator whose request times out will retry. Before this, what happened next differed per
 * record type by three different mechanisms, and none of it was documented:
 *
 * | type | a retried create | mechanism |
 * |---|---|---|
 * | entity | idempotent | a caller-supplied `id` makes it an upsert |
 * | edge | idempotent | natural key `(from, to, label)` |
 * | memory | **DUPLICATED** | no id parameter, no natural key |
 * | chrono | **DUPLICATED** | no id parameter, no natural key |
 *
 * Memory is the highest-volume write type and the one an agent retries most, so it had the worst of it. The owner
 * chose the caller-supplied id over an `Idempotency-Key` header because it reuses a path already shipped and
 * tested on entities: no new storage, no TTL to expire, and an agent that generates one UUID before its first
 * attempt gets idempotency for free.
 *
 * ## Why these tests need a real instance
 *
 * The whole behaviour is "which record the second call landed on", which is a database question. The
 * offline gate (`idempotent-writes-contract.test.js`) holds the parts that can be checked from source — that the
 * routes validate the shape, that the MCP tools advertise it, that the docs describe all four behaviours. Only
 * this file can prove where the second write actually went.
 *
 * Run: node --test testing/integration/idempotent-writes.test.js
 * (needs the Docker test stack: `npm run test:up`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');

let tok;
before(() => { tok = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });

/** A fresh UUID v4 per test, so one test's id can never make another's assertion pass. */
const uuid = () => crypto.randomUUID();

/**
 * Identity, not count.
 *
 * The first version of these tests counted records through a list endpoint. It came back empty — the endpoint
 * was a POST /facts/query I had invented; listing is a GET — and the assertion then reported "the retry
 * created a second memory (0 records with this fact)", which is the opposite of the truth.
 *
 * **A count cannot tell "no duplicate" from "I looked in the wrong place."** Comparing the ids the API returns
 * is the same property asserted directly: same id means one record, different ids mean two. It needs no list
 * endpoint and cannot be fooled by pagination, which an existing test in this suite already warns about past
 * 100 records.
 */
const idOf = (r) => r.body?._id ?? r.body?.entity?._id ?? r.body?.edge?._id;

/**
 * ── Reversed by the "id is id" ruling, 2026-08-12 ────────────────────────────────────────────────
 *
 * Every describe in this file used to assert that a retry with the same id CONVERGES: two creates, one record.
 * That was the documented contract and it is gone — identity is server-minted, and a supplied id that names
 * nothing is ignored rather than adopted.
 *
 * The file is rewritten rather than deleted, for the reason it existed in the first place: "how many records are
 * in the collection after the second call" is a database question, and only a real instance can answer it. A
 * source-reading gate can prove the code says `_id: uuidv4()`; only this can prove the server behaves that way.
 *
 * What is asserted now is the COST as well as the rule, because the cost is the part callers have to plan for:
 * a retried create really does duplicate, and the duplicate-check is what makes that visible.
 */
describe('memories: a supplied id is not adopted', () => {
  it('a create with an unused id mints a server id instead', async () => {
    const unused = uuid();
    const r = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`,
      { id: unused, fact: `unadopted-${Date.now()}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.notEqual(idOf(r), unused, 'the caller must not choose the identity');
    assert.match(idOf(r), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('two creates with the SAME unused id produce TWO records', async () => {
    // The cost of the ruling, stated as a fact rather than a caveat. A caller still reusing an id across a
    // retry gets duplicates, which is exactly why the release note calls this breaking.
    const unused = uuid();
    const fact = `duplicating-${Date.now()}`;
    const a = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`, { id: unused, fact });
    const b = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`, { id: unused, fact });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(idOf(a), idOf(b), 'these are two records now, and that is the documented consequence');
  });

  it('an id that NAMES a record still updates it', async () => {
    // The surviving half. If this broke, every update would silently become a create — worse than the bug the
    // ruling removes, and invisible until a collection doubled.
    const created = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`,
      { fact: `addressable-${Date.now()}` });
    assert.equal(created.status, 201);
    const id = idOf(created);

    const again = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`,
      { id, fact: `addressable-${Date.now()}-v2` });
    assert.ok([200, 201].includes(again.status), JSON.stringify(again.body));
    assert.equal(idOf(again), id, 'an id naming a real record must land on it');
  });

  it('a malformed id is still refused with 400, not stored', async () => {
    // Unchanged, and worth keeping: the format check is what stops a corrupted id being stored at all, which
    // is the defect that started this whole audit.
    const r = await post(INSTANCES.a, tok, `/api/brain/spaces/general/facts`,
      { id: 'not-a-uuid', fact: `malformed-${Date.now()}` });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

describe('edges: the one thing that IS still idempotent', () => {
  it('an edge retry converges on its natural key, with no id involved', async () => {
    // Deliberately kept: edges are unaffected by the ruling because `(from, to, label)` is their identity.
    // A caller told "retries duplicate now" needs the exception stated, or they will work around a problem
    // they do not have.
    const from = (await post(INSTANCES.a, tok, `/api/brain/spaces/general/entities`,
      { name: `EdgeFrom-${Date.now()}`, type: 'concept' })).body._id;
    const to = (await post(INSTANCES.a, tok, `/api/brain/spaces/general/entities`,
      { name: `EdgeTo-${Date.now()}`, type: 'concept' })).body._id;

    const a = await post(INSTANCES.a, tok, `/api/brain/spaces/general/edges`, { from, to, label: 'relates_to' });
    const b = await post(INSTANCES.a, tok, `/api/brain/spaces/general/edges`, { from, to, label: 'relates_to' });
    assert.ok([200, 201].includes(a.status), JSON.stringify(a.body));
    assert.ok([200, 201].includes(b.status), JSON.stringify(b.body));
    assert.equal(idOf(a), idOf(b), 'the natural key must still converge');
  });
});
