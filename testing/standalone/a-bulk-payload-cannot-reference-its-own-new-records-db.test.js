/**
 * No surface may promise that a bulk payload can reference a record the same payload creates.
 *
 * ## The claim, and why it is false
 *
 * Five surfaces said an edge could name an entity inserted in the same batch, and that the processing order
 * (memories → entities → edges → chrono) is what makes it work. One of the five is an MCP tool description,
 * which `help()` calls the authoritative reference a caller reads *while constructing arguments*.
 *
 * The **ID-IS-ID** ruling, 2026-08-12, made it false: *"the identity is ours to mint, always. A supplied id
 * may ADDRESS an existing record, but it never becomes a new record's identity."* The reason is on the same
 * comment — adopting a caller's id makes them a co-author of the primary key, and across a sync two instances
 * deriving ids from one key collide by design.
 *
 * So a batch that inserts an entity carrying `id: X` stores it under a fresh UUID, and an edge in the same
 * batch with `to: X` names nothing. Bulk checks references for SHAPE and never for existence, so the edge is
 * accepted and stored dangling, and the response says `errors: []`. An agent that followed the sentence was
 * told its import succeeded.
 *
 * ## Why a gate, and why it takes two directions
 *
 * Every surface MENTIONED forward references, and they all agreed with each other — so a coverage check that
 * asks "is this documented?" was green throughout, and the fifth copy was found only because a tracker's
 * verify line counted the phrase and got two where the row said one.
 *
 * Which is why this asserts BOTH halves. The behaviour, from a database: a supplied id is not adopted. And the
 * words: no surface offers the forward reference, and each one still says something true about where a new
 * record's id comes from. Either half alone goes vacuous — a pattern list can rot into matching nothing, and a
 * behaviour nobody has written down is one the next writer re-promises.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-bulk-payload-cannot-reference-its-own-new-records-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

/**
 * One long line, so a pattern cannot miss a sentence for being wrapped.
 *
 * Both shapes here break a sentence in the middle: a docblock wraps it across ` * ` line leaders, and a tool
 * description is a chain of concatenated string literals with `\n` escapes in it. The first draft of this gate
 * missed one of the five copies for exactly that reason — *"reference records created earlier"* and *"in the
 * same batch"* sat on different lines — and a gate that reads less than the file is a gate that passes on it.
 */
const flatten = (s) => s
  .replace(/\\n/g, ' ')                 // escaped newlines INSIDE a string literal
  .replace(/'\s*\+\s*'/g, '')           // the joins of a concatenated description
  .replace(/\n\s*\*\s?/g, ' ')          // docblock line leaders
  .replace(/\s+/g, ' ');

const read = (p) => flatten(readFileSync(p, 'utf8'));

/** The five places the claim lived. Each is somebody's authoritative source. */
const SURFACES = [
  { file: 'docs/integration-guide/04d-brain-ops-api.md', who: "the integrator's reference" },
  { file: 'server/src/api/brain/bulk.ts', who: 'the REST route docblock' },
  { file: 'server/src/brain/bulk.ts', who: "the writer's own docblock" },
  { file: 'server/src/mcp/tools/bulk.ts', who: 'the MCP tool description, and one per-field description' },
];

/**
 * The promise, as patterns — each with the exact words it was found in.
 *
 * The fixture is not decoration. A pattern that has rotted into matching nothing turns this whole file into a
 * green no-op, and that failure has shipped in this repo more than once. Every pattern is exercised against
 * the sentence it was written for, so it cannot silently stop being about anything.
 */
const PROMISE = [
  {
    re: /created LATER in the same (?:payload|batch)/i,
    found: 'a batch may legitimately reference an entity created LATER in the same payload',
  },
  {
    re: /reference (?:an entity|entities|records|a record) (?:inserted|created) (?:earlier|later) in the same/i,
    found: 'so edges/chrono can reference records created earlier in the same batch',
  },
  {
    re: /in the same batch (?:will |would )?resolve correctly/i,
    found: 'edges that reference entities inserted in the same batch will resolve correctly',
  },
  {
    re: /referencing newly created entities within the same batch resolve correctly/i,
    found: 'so edges referencing newly created entities within the same batch resolve correctly',
  },
  {
    re: /would reject valid forward references/i,
    found: 'an existence check would reject valid forward references',
  },
];

/**
 * What each surface has to say instead — the half a caller acts on.
 *
 * Loose on purpose: this pins that the surface addresses where a new record's id comes FROM, not the wording.
 * A required exact sentence is a gate that fails on an improvement.
 */
/*
 * WHAT TO DO INSTEAD — and the answer changed with `F-27` item 2.
 *
 * It used to be "take the ids from the response and send the edges as a second call", because there was no
 * other way. There is now: a `$ref` correlation key names a record the same call creates. Both still count
 * as an answer, and so does the unchanged half — the id is MINTED, never adopted from what you sent.
 *
 * What must never come back is the claim this file exists for: that a LITERAL id you invent can be
 * referenced. `PROMISE` above still holds that line.
 */
const TRUTH = /mint|minted|not adopted|never adopted|from the response|in the response|two calls|a second call|\$ref/i;

/**
 * The processing order, which every one of these surfaces states and which is the anchor the correction hangs
 * off — the false sentence was attached to it on all five copies.
 */
const ORDER = /facts\s*(?:→|->|—>)\s*entities/i;

/**
 * How much of the flattened text after the anchor counts as "the same passage" — 600 characters, which is
 * roughly the paragraph the order sentence lives in on all four files.
 *
 * A character window, and normally this repo's rule is that a gate window must be STRUCTURAL, because a count
 * spans different lines on CRLF than on CI's LF. That reason does not apply here: the text has already been
 * flattened to one line, so the same characters are counted on either checkout. Whole-file matching is what
 * the window replaces — the integrator's page is 500 lines long and mentions minted ids elsewhere, so a
 * file-wide search would have passed the correction without it ever being made.
 */
const PASSAGE = 600;

describe('no surface promises a bulk forward reference', () => {
  it('the patterns still describe the claim they were written for', () => {
    for (const p of PROMISE) {
      assert.match(p.found, p.re, `this pattern no longer matches its own example: ${p.re}`);
    }
  });

  it('every named surface still exists', () => {
    for (const s of SURFACES) {
      assert.ok(read(s.file).length > 200, `${s.file} is gone or empty — re-point this list, do not drop rows`);
    }
  });

  for (const s of SURFACES) {
    it(`${s.file} does not offer it`, () => {
      const src = read(s.file);
      const offenders = PROMISE.filter(p => p.re.test(src)).map(p => String(p.re));
      assert.deepEqual(offenders, [],
        `${s.file} (${s.who}) tells a caller a bulk payload can reference a record it creates. Since the `
        + 'ID-IS-ID ruling a supplied id never becomes a new record\'s identity, so that reference names '
        + `nothing and the edge is stored dangling with errors: []:\n  ${offenders.join('\n  ')}`);
    });

    it(`${s.file} says where a new record's id comes from instead`, () => {
      // Removing the false sentence without replacing it leaves a caller with no answer, and the next writer
      // re-derives the wrong one. This is the direction that makes the deletion a correction.
      const src = read(s.file);
      const at = src.search(ORDER);
      assert.ok(at >= 0,
        `${s.file} (${s.who}) no longer states the processing order, which is the passage this asserts about `
        + '— re-anchor this case rather than removing it');
      assert.match(src.slice(at, at + PASSAGE), TRUTH,
        `${s.file} (${s.who}) no longer promises a forward reference but does not say what to do instead — a `
        + 'caller needs the answer that works: a `$ref` correlation key, or the ids from the response and a '
        + 'second call. Removing the false sentence without replacing it leaves the next writer to re-derive '
        + 'the wrong one.');
    });
  }
});

// ── the behaviour the words have to match ──────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-bulk-refs-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const CHOSEN = 'aaaaaaaa-0000-4000-8000-00000000c4c4';

let mongo, bulkMod, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('a supplied id is not adopted, which is what makes the claim false', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('bulkforwardrefs');
    loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'bulk-refs-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    bulkMod = await import('../../server/dist/brain/bulk.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
  });

  it('the importer is reachable (the suite cannot pass by importing nothing)', () => {
    assert.equal(typeof bulkMod.bulkWrite, 'function');
  });

  it('an entity inserted with an id is stored under a DIFFERENT one', async () => {
    const res = await bulkMod.bulkWrite(SPACE, {
      entities: [{ id: CHOSEN, name: 'Carol', type: 'person' }],
    });
    assert.deepEqual(res.errors, []);
    assert.equal(res.inserted.entities, 1);

    const stored = await coll('entities').findOne({ name: 'Carol' });
    assert.ok(stored, 'the entity was not stored at all');
    assert.notEqual(stored._id, CHOSEN,
      'a supplied id became a new record\'s identity, which the ID-IS-ID ruling forbids: it makes the caller '
      + 'a co-author of the primary key, and across a sync two instances deriving ids from one key collide');
  });

  it('so an edge naming that id in the same payload is REFUSED, and says which end', async () => {
    /*
     * The measurement behind the correction, kept as a case because it is the whole reason the sentence
     * mattered: a supplied id does not become the new record's identity, so an edge naming it points at
     * nothing.
     *
     * **What changed is the answer, not the finding.** This door stored the dangling edge and reported it
     * as fine while shape-not-existence was its documented contract, and that contract was scoped to
     * spaces still on the 4.x arrays. 5.0 leaves one shape, so the trade is gone and the reference is
     * checked here as everywhere else — which is the better end of the same story: the caller is told, at
     * the moment of the write, rather than finding out from a traversal that comes back empty.
     */
    const res = await bulkMod.bulkWrite(SPACE, {
      entities: [{ id: CHOSEN, name: 'Carol', type: 'person' }],
      edges: [{ from: CHOSEN, to: CHOSEN, label: 'knows' }],
    });
    assert.equal(res.inserted.edges, 0, 'the dangling edge was stored');
    assert.equal(res.errors.length, 1, `expected one refusal, got ${JSON.stringify(res.errors)}`);
    assert.equal(res.errors[0].type, 'edge');
    assert.match(res.errors[0].reason, /from/,
      'the refusal must name the END that does not resolve, or a caller with a large payload cannot find it');
    assert.equal(await coll('entities').countDocuments({ _id: CHOSEN }), 0,
      'an entity exists at the id the caller chose, so the forward reference DOES resolve and the five '
      + 'surfaces were right — re-open W-12 rather than editing this');
  });
  it('addressing an entity that already exists works, which is what the order is still good for', async () => {
    // The processing order is not wrong, it is merely no longer load-bearing for a NEW record. An entity the
    // batch UPDATES is updated before an edge in the same batch reads it — so the correction says that
    // instead of deleting the order from the documentation.
    await coll('entities').insertOne({ _id: CHOSEN, spaceId: SPACE, name: 'Carol', type: 'person', tags: [], seq: 1 });

    const res = await bulkMod.bulkWrite(SPACE, {
      entities: [{ id: CHOSEN, name: 'Carol', type: 'person', tags: ['renamed'] }],
      edges: [{ from: CHOSEN, to: CHOSEN, label: 'knows' }],
    });
    assert.deepEqual(res.errors, []);
    assert.equal(res.updated.entities, 1, 'a supplied id no longer ADDRESSES an existing record either');
    const edge = await coll('edges').findOne({ label: 'knows' });
    assert.equal(await coll('entities').countDocuments({ _id: edge.from }), 1,
      'the edge points at the entity the batch just updated');
  });
});
