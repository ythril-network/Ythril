/**
 * A file REWRITE merges its `properties` into the stored bag, on every door that rewrites (bundle-62, Q-197).
 *
 * ## The defect
 *
 * `upsertFileMeta`'s existing-record branch assigned `$set['properties'] = opts.properties`: a rewrite that named one key destroyed every other
 * property on the file, with no error, while `update_file_meta` (and the four brain writers) MERGE and keep removal for `deleteFields`
 * (X-6). A rewrite reaches that one write from MCP `write_file`, `POST /api/write_file` and the REST single upload.
 *
 * ## The rule
 *
 * Over the stored bag `{ a: 1 }`, on each door:
 *
 *  - a rewrite with `{ b: 2 }` stores `{ a: 1, b: 2 }`;
 *  - a rewrite with no properties keeps `{ a: 1 }`, and so does one with `{}` (an absence, and an empty map, never mean delete);
 *  - a stored value that is not a plain object (an array, a string: a row a peer or an old writer left) counts as ABSENT, so the incoming bag
 *    replaces it;
 *  - what a peer pulls (`GET /filemeta`) and the text the file's vector is rebuilt from both carry the MERGED bag, not the incoming one.
 *
 * The doors are the real handlers (`_file-act-doors.mjs`); only auth is skipped. REST chunked uploads carry no properties, so they are no row.
 *
 * Red against 0ac12bdd: the stored bag after `{ b: 2 }` is `{ b: 2 }`.
 *
 * Run: node --test testing/standalone/a-file-rewrite-merges-its-properties-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'rewriteprops';
const P = 'notes/a.txt';

let acts, embedRecord;

/** Every door that rewrites a file with metadata; `run` answers `true` when the write was accepted. */
const DOORS = () => [
  { name: 'MCP write_file', run: async (props) => !(await acts.mcp('write_file', { path: P, content: 'new', ...(props !== undefined ? { properties: props } : {}) })).isError },
  { name: 'POST /api/write_file', run: async (props) => (await acts.tool('write_file', { path: P, content: 'new', ...(props !== undefined ? { properties: props } : {}) })).code < 300 },
  { name: 'REST single upload', run: async (props) => (await acts.post('upload', { query: { path: P },
    body: { content: 'new', ...(props !== undefined ? { properties: props } : {}) }, headers: { 'content-type': 'application/json' } })).code < 300 },
];

const stored = async () => (await acts.door.coll(S, 'files').findOne({ _id: P }))?.properties;
const plant = async (properties) => { await acts.reset(); await acts.seed(P, { properties }); };

describe('a file rewrite merges its properties into the stored bag', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'rewriteprops', space: S });
    embedRecord = await import('../../server/dist/brain/embed-record.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await plant({ a: 1 }); });

  it('the door set is the three that rewrite (a floor, so an empty table cannot pass)', () => {
    assert.ok(DOORS().length >= 3, 'MCP write_file, POST /api/write_file and the REST single upload are the doors a rewrite arrives through');
  });

  for (const d of DOORS()) {
    describe(d.name, () => {
      it('a rewrite with { b: 2 } over { a: 1 } stores { a: 1, b: 2 }', async () => {
        assert.ok(await d.run({ b: 2 }), 'the rewrite was refused');
        assert.deepEqual(await stored(), { a: 1, b: 2 }, 'the rewrite replaced the bag instead of merging into it');
      });

      it('a rewrite that names the same key overwrites that key only', async () => {
        assert.ok(await d.run({ a: 9, b: 2 }));
        assert.deepEqual(await stored(), { a: 9, b: 2 });
      });

      it('a rewrite with no properties keeps { a: 1 }', async () => {
        assert.ok(await d.run(undefined));
        assert.deepEqual(await stored(), { a: 1 });
      });

      it('a rewrite with {} keeps { a: 1 }: an empty map is not a delete', async () => {
        assert.ok(await d.run({}));
        assert.deepEqual(await stored(), { a: 1 }, 'an empty bag cleared the stored one; removal is update_file_meta deleteFields');
      });

      for (const [label, planted] of [['an array', ['x', 'y']], ['a string', 'text']]) {
        it(`a stored bag that is ${label} is replaced by the incoming one`, async () => {
          await plant(planted);
          assert.ok(await d.run({ b: 2 }));
          assert.deepEqual(await stored(), { b: 2 }, `${label} is not a bag: it counts as absent, and must not be spread into the result`);
        });
      }

      it('the page a peer pulls and the text the vector is rebuilt from carry the merged bag', async () => {
        assert.ok(await d.run({ b: 2 }));
        const page = await acts.door.pull('/filemeta', { spaceId: S });
        const row = page.items.find(r => r._id === P);
        assert.ok(row, 'the peer page does not carry the file');
        assert.deepEqual(row.properties, { a: 1, b: 2 }, 'a peer would converge on the incoming bag alone');
        const text = await embedRecord.buildEmbedText(S, 'file', await acts.door.coll(S, 'files').findOne({ _id: P }));
        assert.ok(text.includes(' 1 2'), `the rebuilt embed text (property values, merged order) lost a stored value: ${text}`);
      });
    });
  }
});
