/**
 * The export reader decides, over a spooled body and without holding the ids it has seen, which document of a repeated id is the one that lands,
 * and no two distinct ids are ever taken for one (bundle-40 slice b, `Q-267`; plan 2R R1 as amended by 2R3 "Id table").
 *
 * ## The interface this file holds the module to
 *
 * `server/src/sync/export-stream.ts` (built to `server/dist/sync/export-stream.js`) exports:
 *
 * - `indexExportBody(path, { hashOf? })` -> a promise of an INDEX of the body in one pass: it validates the whole body and records, per family, the
 *   byte range of its array and a table of (8-byte id hash, seq, position). `hashOf(id)` returns the id's 8 bytes (a `Buffer`); the default is the
 *   module's own, and a test passes one that collides on purpose.
 * - `readFamilyPages(path, index, family, { pageSize? })` -> an async iterable of PAGES, each an array of at most `pageSize` (default 500) parsed
 *   documents of one family, in body order, holding ONLY the winning copy of each id: the highest seq, and of equal seqs the earliest (as
 *   `held-tombstone-rules.ts` reads a page).
 *
 * ## The rules
 *
 *  1. **A repeated id across page boundaries lands once, at its highest seq, and of equal seqs the earliest.** The pages are small here (100) and the
 *     copies are on different pages, so a reader that judges each page alone keeps a lower copy.
 *  2. **A forced 8-byte hash collision of two distinct ids lands BOTH.** The hash is a filter, never the identity: ids that hash alike are compared by
 *     their text (a second scan collects the full ids of the hashes seen twice), so neither is dropped as a "repeat" of the other, and a real repeat
 *     inside the colliding pair is still resolved by seq and position.
 *  3. **An id that is a prototype key** (`__proto__`, `constructor`) is an id like any other.
 *
 * ## Red on the base
 *
 * The module does not exist on 6c64a7112: each rule fails at the loader naming `server/dist/sync/export-stream.js` (the plan allows this red for a pure
 * unit test of a module it names).
 *
 * Run: `node --test testing/standalone/an-export-body-is-indexed-and-paged-without-holding-its-ids.test.js` (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const RULE = 'an export body is indexed and paged without holding its ids';
const NAMES = ['indexExportBody', 'readFamilyPages'];
const PAGE = 100;

let dir, mod;

/** Loaded per rule, so each rule reports the module as missing by itself (`_load-dist-module.mjs`). */
async function load() {
  mod ??= needModule(await loadDistModule('../../server/dist/sync/export-stream.js', import.meta.url), NAMES, RULE);
  return mod;
}

const doc = (id, seq, tag) => ({ _id: id, spaceId: 'elsewhere', fact: `fact ${id}`, tags: [], seq, ...(tag ? { tag } : {}) });
const body = (facts) => JSON.stringify({ exportedAt: '2026-11-01T00:00:00.000Z', spaceId: 's', facts });
const spoolOf = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

/** Every document the reader yields for `family`, flattened, and the pages' sizes. */
async function landed(file, family, opts = {}) {
  await load();
  const index = await mod.indexExportBody(file, opts.hashOf ? { hashOf: opts.hashOf } : {});
  const sizes = [];
  const docs = [];
  for await (const page of mod.readFamilyPages(file, index, family, { pageSize: PAGE })) { sizes.push(page.length); docs.push(...page); }
  return { docs, sizes };
}

describe('an export body is indexed and paged without holding its ids (the export-stream reader)', () => {
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-export-stream-'));
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('a repeated id across page boundaries lands once at its highest seq, and of equal seqs the earliest', async () => {
    const facts = [doc('dup', 5, 'first, seq 5'), doc('tie', 7, 'first')];
    for (let i = 0; i < 250; i++) facts.push(doc(`filler-a-${i}`, 100 + i));
    facts.push(doc('dup', 9, 'middle, seq 9'));
    for (let i = 0; i < 250; i++) facts.push(doc(`filler-b-${i}`, 400 + i));
    facts.push(doc('dup', 6, 'last, seq 6'), doc('tie', 7, 'second'));
    const { docs, sizes } = await landed(spoolOf('across.json', body(facts)), 'facts');
    assert.ok(sizes.length >= 5 && sizes.every(n => n <= PAGE), `fixture check: the body did not come in pages of at most ${PAGE}: ${JSON.stringify(sizes)}`);
    const ids = docs.map(d => d._id);
    assert.equal(new Set(ids).size, ids.length, `a repeated id was yielded more than once: ${JSON.stringify(ids.filter((id, i) => ids.indexOf(id) !== i))}`);
    assert.equal(ids.length, 2 + 500, 'a document was lost or invented');
    assert.equal(docs.find(d => d._id === 'dup')?.tag, 'middle, seq 9', 'a repeated id did not keep its highest seq');
    assert.equal(docs.find(d => d._id === 'tie')?.tag, 'first', 'of two copies at an equal seq the earlier did not stand');
  });

  it('a forced 8-byte hash collision of two distinct ids lands both', async () => {
    const collide = () => Buffer.alloc(8, 7); // every id hashes alike
    const facts = [doc('id-a', 1, 'a'), doc('id-b', 2, 'b'), doc('id-c', 3, 'c')];
    const { docs } = await landed(spoolOf('collide.json', body(facts)), 'facts', { hashOf: collide });
    assert.deepEqual(docs.map(d => d._id).sort(), ['id-a', 'id-b', 'id-c'], 'two distinct ids with one hash were taken for a repeat of each other');
  });

  it('a real repeat inside a colliding set is still resolved by seq, position and exact id', async () => {
    const collide = () => Buffer.alloc(8, 7);
    const facts = [doc('id-a', 1, 'a low'), doc('id-b', 4, 'b'), doc('id-a', 8, 'a high'), doc('id-c', 3, 'c first'), doc('id-c', 3, 'c second')];
    for (let i = 0; i < 200; i++) facts.push(doc(`pad-${i}`, 10 + i));
    const { docs } = await landed(spoolOf('collide-repeat.json', body(facts)), 'facts', { hashOf: collide });
    const by = Object.fromEntries(docs.map(d => [d._id, d.tag]));
    assert.deepEqual([by['id-a'], by['id-b'], by['id-c']], ['a high', 'b', 'c first'], `the colliding ids were resolved wrongly: ${JSON.stringify([by['id-a'], by['id-b'], by['id-c']])}`);
    assert.equal(docs.length, 3 + 200, 'a document was lost or yielded twice');
  });

  it('an id that is a prototype key is an id like any other', async () => {
    const facts = [doc('__proto__', 1, 'proto'), doc('constructor', 2, 'ctor'), doc('toString', 3, 'ts'), doc('hasOwnProperty', 4, 'hop'), doc('__proto__', 9, 'proto high')];
    const { docs } = await landed(spoolOf('proto.json', body(facts)), 'facts');
    const by = new Map(docs.map(d => [d._id, d.tag]));
    assert.deepEqual([...by.keys()].sort(), ['__proto__', 'constructor', 'hasOwnProperty', 'toString'], 'a prototype-key id was lost, or took another\'s place');
    assert.equal(by.get('__proto__'), 'proto high', 'a repeated `__proto__` id did not keep its highest seq');
  });
});
