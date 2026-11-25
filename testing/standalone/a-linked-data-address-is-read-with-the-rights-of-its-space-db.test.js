/**
 * A Linked Data address is read with the rights of the space whose base holds it, and answers alike to every caller who may not read it
 * (bundle-271, Q-758; design §3, r2 R1.3, R1.4, R1.5; DEC-2).
 *
 * ## The rules
 *
 * 1. **The twin of each read door.** A record address needs `knowledge: read`; a file address needs `files: read` as well (a knowledge-only
 *    token gets the file as not found); a schema version (`/ld/<space>/schema/<fp>`) and a vocabulary term (`/ld/<space>/vocab/...`) need
 *    `schema: read`, as `GET /api/spaces/:id/schema-rdf` does.
 * 2. **Alike when not readable.** No right on the space, a space no base covers and a record that is not there answer the same `404` problem
 *    body, byte for byte: an answer never tells a caller which of the three it met.
 * 3. **By base, never by segment.** The address is `<public URL> + path`, read back against the bases of the spaces with RDF on; the rights
 *    asked are those of the space that holds the base. A space renamed after its base was set is read at its old segment; a space holding
 *    `<public URL>/ld/<other>/` as its base answers for that segment, and a token reading only the space named `<other>` reads nothing there.
 * 4. **Browsers are sent to the app, before any token is asked.** An `Accept` that prefers `text/html` answers `303` to
 *    `/brain?space=<segment>&tab=<the kind's tab>`, reading nothing; a machine read without a token answers `401`. Each answer says
 *    `Vary: Accept`.
 *
 * ## Seen red
 *
 * On c647bd24f every address answers the 404 placeholder: no `200`, no `303`, no `401`. Mutations: the rights asked of the space the URL
 * segment names (rule 3: the renamed space is 404, the segment's own reader is 200); the file route without the files predicate (rule 1).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/a-linked-data-address-is-read-with-the-rights-of-its-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openRdfExportDoors, rdfMeta, parseRdf } from './_rdf-export-doors.mjs';

const skip = await mongoSkipReason();
const PUBLIC = 'https://rdf.example.org';
const baseAt = (segment) => `${PUBLIC}/ld/${segment}/`;
/** A space's meta with RDF on under `base` (its vocab under it). */
const metaAt = (id, base, extra = {}) => ({ ...rdfMeta(id, extra), rdf: { enabled: true, base, vocab: `${base}vocab/`, baseEpoch: 0 } });

const S = 'ldr';
/** Renamed: its base still names its old id, which no space has now. */
const RENAMED = 'ldren';
const OLD = 'ldold';
/** Holds `<public URL>/ld/ldseg/` as its base; the space `ldseg` has a base elsewhere. */
const OWNER = 'ldown';
const SEGMENT = 'ldseg';
const STAMP = '2026-03-04T05:06:07.000Z';
const FILE_PATH = 'docs/a.txt';

let d;
const keys = {};
const previousPublic = process.env['PUBLIC_BASE_URL'];

/** A GET of `path` with `accept`, by `key` (no Authorization without one), following no redirect. */
async function get(path, accept, key) {
  const headers = { Accept: accept, ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  const r = await fetch(`${d.server.url}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  return { status: r.status, headers: r.headers, text: await r.text() };
}
const fmt = (r) => `${r.status} ${r.text.slice(0, 200)}`;
const subjects = async (r) => new Set((await parseRdf('nquads', r.text)).map(q => q.subject.value));

describe('a linked data address is read with the rights of its space', { skip }, () => {
  before(async () => {
    d = await openRdfExportDoors({
      suite: 'ld_rights',
      spaces: [
        { id: S, meta: rdfMeta(S, { typeSchemas: { entity: { Person: { propertySchemas: { age: { type: 'number' } } } } } }) },
        { id: RENAMED, meta: metaAt(RENAMED, baseAt(OLD)) },
        { id: OWNER, meta: metaAt(OWNER, baseAt(SEGMENT)) },
        { id: SEGMENT, meta: metaAt(SEGMENT, 'https://elsewhere.example.org/ldseg/') },
      ],
    });
    await d.seed(S, 'entity', [{ _id: 'e1', name: 'Ada', type: 'Person', properties: { age: 36 } }]);
    await d.seed(S, 'file', [{ _id: FILE_PATH, path: FILE_PATH, sizeBytes: 3, sha256: 'ab'.repeat(32), createdAt: STAMP, updatedAt: STAMP }]);
    await d.seed(RENAMED, 'entity', [{ _id: 'r1', name: 'Renamed' }]);
    await d.seed(OWNER, 'entity', [{ _id: 'o1', name: 'Owned' }]);
    await d.seed(SEGMENT, 'entity', [{ _id: 'o1', name: 'Segment' }]);
    const mint = async (name, perSpace) => (await d.mint(name, perSpace)).key;
    keys.reader = await mint('ld-reader', { [S]: d.row({ knowledge: 'read', files: 'read' }) });
    keys.knowledgeOnly = await mint('ld-knowledge', { [S]: d.row({ knowledge: 'read' }) });
    keys.schemaReader = await mint('ld-schema', { [S]: d.row({ knowledge: 'read', schema: 'read' }) });
    keys.elsewhere = await mint('ld-elsewhere', { [SEGMENT]: d.row({ knowledge: 'read', schema: 'read', files: 'read' }) });
    keys.renamed = await mint('ld-renamed', { [RENAMED]: d.row({ knowledge: 'read' }) });
    keys.owner = await mint('ld-owner', { [OWNER]: d.row({ knowledge: 'read' }) });
    keys.admin = (await d.mint('ld-admin', {}, { admin: true })).key;
    process.env['PUBLIC_BASE_URL'] = PUBLIC;
  });
  after(async () => {
    if (previousPublic === undefined) delete process.env['PUBLIC_BASE_URL']; else process.env['PUBLIC_BASE_URL'] = previousPublic;
    await d?.close();
  });

  it('a record needs knowledge read, a file files read as well', async () => {
    const record = await get(`/ld/${S}/entity/e1`, 'application/n-quads', keys.knowledgeOnly);
    assert.equal(record.status, 200, fmt(record));
    assert.match(String(record.headers.get('vary')), /accept/i, 'a machine read says Vary: Accept');
    assert.ok((await subjects(record)).has(`${baseAt(S)}entity/e1`), 'the record is the subject of its answer');

    const file = await get(`/ld/${S}/file/${FILE_PATH}`, 'application/n-quads', keys.reader);
    assert.equal(file.status, 200, fmt(file));
    assert.ok((await subjects(file)).has(`${baseAt(S)}file/${FILE_PATH}`), 'the file is the subject of its answer');
    const withheld = await get(`/ld/${S}/file/${FILE_PATH}`, 'application/n-quads', keys.knowledgeOnly);
    const missing = await get(`/ld/${S}/entity/nope`, 'application/n-quads', keys.knowledgeOnly);
    assert.equal(withheld.status, 404, `a knowledge-only token reads the file: ${fmt(withheld)}`);
    assert.equal(withheld.text, missing.text, 'the withheld file answers as a missing record does');
  });

  it('a schema version and a vocabulary term need schema read', async () => {
    const meta = await d.rest(keys.admin, 'GET', `/api/spaces/${S}/meta`);
    const fp = meta.body?.schemaFingerprint;
    assert.match(String(fp), /^[0-9a-f]{64}$/, `the space's fingerprint: ${meta.text.slice(0, 200)}`);
    const missing = await get(`/ld/${S}/entity/nope`, 'application/n-quads', keys.knowledgeOnly);
    for (const path of [`/ld/${S}/schema/${fp}`, `/ld/${S}/vocab/entity/Person`]) {
      const allowed = await get(path, 'application/n-quads', keys.schemaReader);
      assert.equal(allowed.status, 200, `${path} with schema read: ${fmt(allowed)}`);
      assert.ok((await parseRdf('nquads', allowed.text)).length > 0, `${path}: an empty answer`);
      const refused = await get(path, 'application/n-quads', keys.knowledgeOnly);
      assert.equal(refused.status, 404, `${path} without schema read: ${fmt(refused)}`);
      assert.equal(refused.text, missing.text, `${path} without schema read answers as a missing record does`);
    }
    const term = await get(`/ld/${S}/vocab/entity/Person`, 'application/n-quads', keys.schemaReader);
    const termSubjects = await subjects(term);
    assert.ok(termSubjects.has(`${baseAt(S)}vocab/entity/Person`), 'the type is a subject of its term\'s answer');
    assert.ok([...termSubjects].every(s => s.startsWith(`${baseAt(S)}vocab/entity/Person`)), `the term's answer is the term's alone: ${[...termSubjects].join(', ')}`);
  });

  it('no right, an unknown space and a missing record answer byte-alike', async () => {
    const answers = [
      ['no right on the space', await get(`/ld/${S}/entity/e1`, 'text/turtle', keys.elsewhere)],
      ['a space no base covers', await get('/ld/nosuch/entity/e1', 'text/turtle', keys.reader)],
      ['a missing record', await get(`/ld/${S}/entity/nope`, 'text/turtle', keys.reader)],
      ['a kind no address has', await get(`/ld/${S}/link/e1`, 'text/turtle', keys.reader)],
    ];
    for (const [what, r] of answers) {
      assert.equal(r.status, 404, `${what}: ${fmt(r)}`);
      assert.match(String(r.headers.get('content-type')), /^application\/problem\+json/, what);
    }
    const [first] = answers;
    for (const [what, r] of answers.slice(1)) assert.equal(r.text, first[1].text, `${what} answers otherwise than ${first[0]}`);
    assert.equal(JSON.parse(first[1].text).code, 'ld_not_found');
  });

  it('an address is resolved by its base, and read with the rights of the space holding it', async () => {
    const renamed = await get(`/ld/${OLD}/entity/r1`, 'application/n-quads', keys.renamed);
    assert.equal(renamed.status, 200, `the renamed space at its old segment: ${fmt(renamed)}`);
    assert.ok((await subjects(renamed)).has(`${baseAt(OLD)}entity/r1`));
    const byNewId = await get(`/ld/${RENAMED}/entity/r1`, 'application/n-quads', keys.renamed);
    assert.equal(byNewId.status, 404, `no base is under the renamed space's new id: ${fmt(byNewId)}`);

    const owned = await get(`/ld/${SEGMENT}/entity/o1`, 'application/n-quads', keys.owner);
    assert.equal(owned.status, 200, `the space holding the segment's base: ${fmt(owned)}`);
    const body = await parseRdf('nquads', owned.text);
    assert.ok(body.some(q => q.object.value === 'Owned'), 'the record of the space holding the base, not of the space the segment names');
    assert.ok(!body.some(q => q.object.value === 'Segment'), 'the space the segment names is not read');
    const bySegment = await get(`/ld/${SEGMENT}/entity/o1`, 'application/n-quads', keys.elsewhere);
    const missing = await get(`/ld/${S}/entity/nope`, 'application/n-quads', keys.reader);
    assert.equal(bySegment.status, 404, `a reader of the space the segment names reads the base's owner: ${fmt(bySegment)}`);
    assert.equal(bySegment.text, missing.text);
  });

  it('a browser is sent to the app before any token is asked; a machine read without one is 401', async () => {
    const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    for (const [path, tab] of [[`/ld/${S}/entity/e1`, 'entities'], ['/ld/nosuch/fact/f1', 'facts'], [`/ld/${S}/file/${FILE_PATH}`, 'files']]) {
      for (const accept of ['text/html', BROWSER]) {
        const r = await get(path, accept);
        assert.equal(r.status, 303, `${path} (${accept}): ${fmt(r)}`);
        const space = path.split('/')[2];
        assert.equal(r.headers.get('location'), `/brain?space=${space}&tab=${tab}`, `${path} (${accept})`);
        assert.match(String(r.headers.get('vary')), /accept/i, `${path}: the 303 says Vary: Accept`);
      }
    }
    for (const accept of ['text/turtle', 'application/n-quads', '*/*']) {
      const r = await get(`/ld/${S}/entity/e1`, accept);
      assert.equal(r.status, 401, `a machine read (${accept}) without a token: ${fmt(r)}`);
    }
  });
});
