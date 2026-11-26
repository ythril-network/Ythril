/**
 * Every write to a record collection reaches the triple index: it is positioned (the follower reads it by position), journaled (the db door
 * writes its row in `<space>_rdf_dirty`), or listed in `every-record-write-is-positioned-journaled-or-listed.allow.json` with its reason
 * (bundle-273, Q-764 slice S2; design-r2 R9; contract row 6).
 *
 * ## What it prevents
 *
 * The index is kept by a follower that reads records by position, and by a journal at the one db door for every write that carries no
 * position. A write that is neither leaves the index answering a query from statements the records no longer hold, and nothing reports it.
 * Three shapes are that write, and this lint refuses each:
 *
 * 1. **A write method the door does not journal.** Every method the driver's `Collection` has that is not a read (`COLLECTION_METHOD_EFFECT`)
 *    is driven through the door with a journal registered, and must reach it, so a write method added to the table without the journal fails.
 * 2. **A second door onto the database.** A file that opens its own client (or its own `Db`) writes around the journal. Each such file is
 *    listed with the reason it changes no field a statement reads, or says how the index learns of it. This re-judges the exemptions of
 *    `a-record-write-reaches-the-index-presence-observer.test.js` (section 4), which ask only whether a door inserts a record.
 * 3. **A position copied from another field** (`pos: '$seq'`). The clock hands out positions above every one handed before; a position taken
 *    from a version is below the clock's band, so a follower already past it never reads the row (`sync/positions-owed.ts`).
 *
 * The scope is the repository's server sources (git-listed, untracked included), never a hand list; the planted cases at the end prove each
 * finder fails on a copy of the bad shape.
 *
 * Run: node --test testing/standalone/every-record-write-is-positioned-journaled-or-listed.test.js (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALLOW_FILE = 'every-record-write-is-positioned-journaled-or-listed.allow.json';
const ALLOW = JSON.parse(fs.readFileSync(path.join(HERE, ALLOW_FILE), 'utf8')).entries;
const SCAN = { specs: false, untracked: true };

/** The shapes, each built fresh per use (a global regex shared between uses under-scans). */
const DOOR = () => /new\s+MongoClient\s*\(|\.db\s*\(/g;
const POS_FROM_A_FIELD = () => /\bpos\s*:\s*['"`]\$/g;

const lineOf = (text, at) => text.slice(0, at).split('\n').length;

/** Every hit of `shape` in `sources` (comments blanked, lines of the original source), as `{ file, rule, line }`. */
function findings(sources, rule, shape) {
  const out = [];
  for (const s of sources) {
    const code = blankComments(s.text);
    for (const m of code.matchAll(shape())) out.push({ file: s.file, rule, line: lineOf(code, m.index) });
  }
  return out;
}

/** The files of `found` no allowlist entry of `rule` names. */
function unlisted(found, rule) {
  const listed = new Set(ALLOW.filter(e => e.rule === rule).map(e => e.file));
  return found.filter(f => !listed.has(f.file));
}

const sources = readTrackedSources(SERVER_CODE_ROOTS, SCAN);
const RULES = { 'own-door': DOOR, 'pos-from-a-field': POS_FROM_A_FIELD };

describe('1. the db door journals every write method', () => {
  it('a journal registered at the door is asked before each write and told after it', async () => {
    const { COLLECTION_METHOD_EFFECT, observeRecordWrites, setRecordWriteJournal } = await import('../../server/dist/db/record-write-observer.js');
    assert.equal(typeof setRecordWriteJournal, 'function', 'the door has no journal to register (db/record-write-observer.ts setRecordWriteJournal)');
    const asked = [];
    const told = [];
    const fakeCollection = new Proxy({}, {
      get: (_t, prop) => (prop === 'then' ? undefined : (...args) => {
        if (String(prop).startsWith('initialize')) return { execute: async () => ({}) };
        void args;
        return Promise.resolve({});
      }),
    });
    const fakeDb = { databaseName: 'lint', collection: () => fakeCollection };
    setRecordWriteJournal({
      wants: (name) => name === 'lint_entities',
      before: (name, method) => { asked.push(method); return Promise.resolve({ method }); },
      after: (ticket) => { told.push(ticket.method); },
    });
    try {
      const db = observeRecordWrites(fakeDb, () => false, () => {});
      const writes = Object.entries(COLLECTION_METHOD_EFFECT).filter(([, e]) => e !== 'read').map(([m]) => m);
      assert.ok(writes.length >= 10, `the method table lists too few writes to mean anything: ${writes}`);
      for (const method of writes) {
        const out = db.collection('lint_entities')[method]({ _id: 'x' }, {});
        if (out && typeof out.execute === 'function') await out.execute(); else await out;
      }
      assert.deepEqual(asked, writes, 'every write method is journaled before it runs');
      assert.deepEqual(told, writes, 'and told the journal when it settled');
      asked.length = 0;
      await db.collection('lint_other').updateOne({ _id: 'x' }, { $set: { a: 1 } });
      assert.deepEqual(asked, [], 'a collection the journal does not want is not journaled');
    } finally {
      setRecordWriteJournal(null);
    }
  });
});

describe('2. every write around the door is listed with its reason', () => {
  for (const [rule, shape] of Object.entries(RULES)) {
    const found = findings(sources, rule, shape);
    it(`${rule}: every hit is listed`, () => {
      assert.ok(rule !== 'own-door' || found.some(f => f.file === 'server/src/db/mongo.ts'), 'the scan did not find mongo.ts itself: it is broken');
      const left = unlisted(found, rule);
      assert.deepEqual(left.map(f => `${f.file}:${f.line}`), [],
        `a ${rule} write the index never learns of. Write through getDb()/col() (the journal), stamp it with withLandingStamp, or list it in ${ALLOW_FILE} `
        + 'with the reason it changes no field a statement reads (rdf/record-triples.ts RDF_READ_FIELDS) or how the index is marked not ready');
    });
    it(`${rule}: no entry is stale`, () => {
      const hit = new Set(found.map(f => f.file));
      const stale = ALLOW.filter(e => e.rule === rule && !hit.has(e.file)).map(e => e.file);
      assert.deepEqual(stale, [], `entries for files that no longer have the shape: ${stale.join(', ')}`);
    });
  }

  it('every entry names a known rule, a file, a reason of five words or more and a reviewBy date', () => {
    const bad = ALLOW.filter(e => !(e.rule in RULES) || typeof e.file !== 'string' || typeof e.reason !== 'string'
      || e.reason.trim().split(/\s+/).length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy ?? '') || new Date(e.reviewBy) < new Date());
    assert.deepEqual(bad.map(e => `${e.rule}:${e.file}`), [], 'each entry needs rule, file, reason (5+ words) and a reviewBy date not past');
  });

  it(`reports its exception count (${ALLOW.length})`, () => {
    assert.ok(ALLOW.length > 0);
  });
});

describe('3. the finders fail on a planted copy', () => {
  /** A planted file: a line of the repository copied under a path no entry names. */
  const plantFrom = (file, shape) => {
    const src = sources.find(s => s.file === file);
    assert.ok(src, `${file} is gone; re-anchor the plant`);
    const line = blankComments(src.text).split('\n').find(l => shape().test(l));
    assert.ok(line, `${file} no longer holds the shape; re-anchor the plant`);
    return { file: 'server/src/planted/unjournaled-write.ts', text: `${line}\n` };
  };

  it('an unpositioned write on a client of its own is refused', () => {
    const planted = plantFrom('server/src/tools/positions-rollback.ts', DOOR);
    assert.equal(unlisted(findings([planted], 'own-door', DOOR), 'own-door').length, 1, 'the own-door finder missed a planted client');
  });

  it('a position copied from another field is refused', () => {
    const planted = plantFrom('server/src/sync/positions-owed.ts', POS_FROM_A_FIELD);
    assert.equal(unlisted(findings([planted], 'pos-from-a-field', POS_FROM_A_FIELD), 'pos-from-a-field').length, 1,
      'the position finder missed a planted copy');
  });
});
