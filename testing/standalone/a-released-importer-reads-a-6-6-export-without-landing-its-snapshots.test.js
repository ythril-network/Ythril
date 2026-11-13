/**
 * An export written by 6.6 carries the schema snapshots its records use as a new top-level ARRAY key, `schemaSnapshots` (Q-740, bundle-266). An
 * importer that is already released (6.3.0 to 6.5.5) must read such a body, land its records, land nothing of the new key, and not refuse it; and the
 * names of unknown keys a reader collects must be bounded.
 *
 * ## Why this is a version-skew test
 *
 * An admin restores a 6.6 backup onto a server not yet upgraded. A released reader indexes an unknown array key and caps EACH element of it at
 * `MAX_DOCUMENT_BYTES`, unknown keys included (`export-stream.ts` :176-183 in those releases). The snapshot cap is the same 10 MiB and a JSON-escaped
 * text grows, so 6.6's export leaves out any element over `MAX_DOCUMENT_BYTES` minus 64 KiB (design r2 O1). The case below hands the released reader
 * an element at exactly that limit, with a text that grows when escaped, and holds that it is read and not refused.
 *
 * The release's own source is loaded from its tag (`_previous-release.mjs`, `loadRelease`), `export-stream.ts` together with `replicated-families.ts`
 * (its sibling import), so the reader under test is the one that shipped and not this build's (testing lens S1: the default predecessor v5.6.10 has no
 * `export-stream.ts`).
 *
 * ## Seen at 82208a6b
 *
 * GREEN, as a pin: the behaviour is the released readers', which this bundle cannot change. It fails for a real defect only if the export's element
 * limit were set above what a released reader takes, or a release had refused an unknown key (probe experiment 5 measured the latter before the design).
 * The bounded-names case is a pin of this build's reader too (testing lens S9), which the import's new `unknownKeys` answer relies on.
 *
 * Run: node --test testing/standalone/a-released-importer-reads-a-6-6-export-without-landing-its-snapshots.test.js
 * (requires a prior server build and the tags v6.3.0 and v6.5.5 in the checkout)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { releaseSkipReason, loadRelease } from './_previous-release.mjs';

const STREAM = 'server/src/sync/export-stream.ts';
const FAMILIES = 'server/src/sync/replicated-families.ts';
const TAGS = ['v6.3.0', 'v6.5.5'];
const HEADROOM = 64 * 1024;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-released-importer-'));
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
const spoolOf = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };

const fact = (id, seq) => ({ _id: id, spaceId: 'elsewhere', fact: `fact ${id}`, tags: [], seq,
  author: { instanceId: 'origin', instanceLabel: 'Origin' }, createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' });

/** One snapshot element `{fp, text, links}` whose JSON is exactly `bytes` long: its text is quotes and letters, so escaping makes it grow. */
function elementOfBytes(bytes) {
  const shell = (text) => JSON.stringify({ fp: 'c'.repeat(64), text, links: { own: 'c'.repeat(64), layers: [], served: [] } });
  const base = Buffer.byteLength(shell(''));
  // Each `"` costs two bytes escaped; fill the rest with a plain letter.
  const quotes = Math.floor((bytes - base) / 4);
  const text = '"'.repeat(quotes) + 'a'.repeat(bytes - base - quotes * 2);
  const out = shell(text);
  assert.equal(Buffer.byteLength(out), bytes, 'the fixture is wrong: the element is not the size asked for');
  return out;
}

for (const tag of TAGS) {
  describe(`the ${tag} importer reads a 6.6 export body`, { skip: releaseSkipReason(tag) }, () => {
    let loaded, stream, families;
    before(async () => {
      loaded = await loadRelease([STREAM, FAMILIES], { tag });
      stream = loaded.modules[STREAM];
      families = loaded.modules[FAMILIES].REPLICATED_FAMILIES.map(f => f.collection);
    });
    after(() => loaded?.cleanup());

    it('indexes the body, lands its records, names schemaSnapshots as unknown and lands none of it, with an element at the export\'s own limit', async () => {
      assert.equal(families.includes('schemaSnapshots'), false, `${tag} lists schemaSnapshots as a family: the skew this file is about does not exist`);
      const limit = stream.MAX_DOCUMENT_BYTES - HEADROOM;
      const small = JSON.stringify({ fp: 'd'.repeat(64), text: '{"format":1,"rules":{},"typeSchemas":{}}', links: null });
      const body = `{"exportedAt":"2026-11-13T00:00:00.000Z","spaceId":"s","spaceName":"S","version":"6.6.0","instanceId":"i-1",`
        + `"facts":[${JSON.stringify(fact('f-1', 1))},${JSON.stringify(fact('f-2', 2))}],"entities":[],`
        + `"schemaSnapshots":[${small},${elementOfBytes(limit)}]}`;
      const file = spoolOf(`${tag}-6.6.json`, body);
      const index = await stream.indexExportBody(file);
      assert.equal(index.families.has('schemaSnapshots'), false, `${tag} took schemaSnapshots as a family it lands`);
      assert.deepEqual([...index.unknownKeys], ['schemaSnapshots'], `${tag} did not name the new key as unknown`);
      assert.equal(index.unknownKeysTotal, 1);
      const landed = [];
      for await (const page of stream.readFamilyPages(file, index, 'facts')) landed.push(...page.map(d => d._id));
      assert.deepEqual(landed, ['f-1', 'f-2'], `${tag} did not land the records of a body that carries snapshots`);
    });

    it('refuses an element one byte over the cap it applies to every array, so the export\'s headroom is what keeps the body readable', async () => {
      const body = `{"spaceId":"s","facts":[],"schemaSnapshots":[${elementOfBytes(stream.MAX_DOCUMENT_BYTES + 1)}]}`;
      await assert.rejects(stream.indexExportBody(spoolOf(`${tag}-over.json`, body)), (err) => err instanceof Error,
        `${tag} took an unknown-key element over MAX_DOCUMENT_BYTES: the export's limit would then guard nothing`);
    });
  });
}

describe('this build\'s reader names unknown keys bounded (the import answer\'s source)', () => {
  it('eleven unknown array keys and one unknown object key: ten names, a total of eleven, and the object key is not named', async () => {
    const { indexExportBody } = await import('../../server/dist/sync/export-stream.js');
    const keys = Array.from({ length: 11 }, (_, i) => `future${String(i).padStart(2, '0')}`);
    const body = `{"spaceId":"s","anObjectKey":{"a":1},"facts":[],${keys.map(k => `"${k}":[]`).join(',')}}`;
    const index = await indexExportBody(spoolOf('unknown-keys.json', body));
    assert.equal(index.unknownKeys.length, 10, `named ${index.unknownKeys.length} keys`);
    assert.deepEqual([...index.unknownKeys], keys.slice(0, 10));
    assert.equal(index.unknownKeysTotal, 11, 'the total does not count every unknown array key');
    assert.equal(index.unknownKeys.includes('anObjectKey'), false, 'an object key was named as an unknown family');
  });
});
