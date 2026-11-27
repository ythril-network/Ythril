/**
 * A space holds as many type definitions as its storage allows (bundle-382, Q-981; owner's decision): no door refuses a schema for its number of
 * types, the schema's growth asks the storage quota, and a schema larger than one stored document is refused before anything is written.
 *
 * ## What it holds
 *
 * - More than 200 types of one kind are written through every door that held the old per-kind count limit: `PUT /api/spaces/:id/schema`, the
 *   single-type `PUT`, a library group apply, the space `PATCH` and MCP `schema_update` (the schema-from-RDF door and the inference are held in
 *   their own specs: `an-rdf-import-inferring-a-schema-*`).
 * - A write that grows the schema while the storage hard limit is reached is refused `507` with the quota's own sentence (the area, what is
 *   used, what is allowed) and `storageExceeded`, as the fact doors are, and nothing is stored; a write that shrinks the schema is not asked, so
 *   an owner at the limit can still remove types.
 * - A schema whose stored text would not fit in one stored document (MongoDB's 16 MiB) is refused `413` with words naming that limit, and nothing
 *   is written: not the meta, not the backup `PUT /schema` writes of the schema it replaces.
 * - No count cap is left in the sources: no `MAX_TYPES_PER_KIND`, no refusal sentence of it, no module of it.
 *
 * Run: node --test testing/standalone/a-space-holds-as-many-types-as-its-storage-allows-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';

const dir = tempInstanceDir('ythril-types-storage-');
const skip = await mongoSkipReason();
/** The old per-kind count limit: every case writes past it. */
const OLD_LIMIT = 200;
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const typesOf = (n, prefix = 't') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, {}]));
/** MongoDB's largest document, in bytes: the limit a refused schema's words name. */
const ONE_DOCUMENT = 16 * 1024 * 1024;
/** A type map whose stored text passes one document: each type carries a description of the most characters a type's description may hold. */
const tooLarge = () => Object.fromEntries(Array.from({ length: Math.ceil(ONE_DOCUMENT / 4000) + 50 }, (_, i) => [`big${i}`, { description: 'd'.repeat(4000) }]));
const SPACES = ['putmany', 'onemore', 'groupmany', 'patchmany', 'toolmany', 'quota', 'huge'];

describe('a space holds as many types as its storage allows', { skip, timeout: 600_000 }, () => {
  let inst, schemaLibraryRouter;
  before(async () => {
    await openTestMongo('types_storage');
    inst = await bootSchemaInstance(dir, {
      spaces: [
        ...SPACES.map(id => ({ id, label: id, folders: [], meta: {} })),
      ],
      library: [
        { name: 'many-entity-n1', knowledgeType: 'entity', typeName: 'n1', schemaGroup: 'many', schema: {} },
        { name: 'many-entity-n2', knowledgeType: 'entity', typeName: 'n2', schemaGroup: 'many', schema: {} },
      ],
    });
    ({ schemaLibraryRouter } = await import('../../server/dist/api/schema-library.js'));
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const seed = (id, typeSchemas) => { inst.loader.getConfig().spaces.find(s => s.id === id).meta = { typeSchemas }; };
  const count = (id, kind = 'entity') => Object.keys(inst.heldTypes(id)[kind] ?? {}).length;
  const atTheLimit = (fn) => async () => {
    inst.loader.mutateConfig(cfg => { cfg.storage = { brain: { softLimitGiB: 0, hardLimitGiB: 0 } }; });
    try { await fn(); } finally { inst.loader.mutateConfig(cfg => { delete cfg.storage; }); }
  };

  it('PUT /schema writes a map of more than 200 types of one kind', async () => {
    const r = await inst.doors['put-schema']('putmany', { typeSchemas: { entity: typesOf(OLD_LIMIT + 1) } });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(count('putmany'), OLD_LIMIT + 1);
  });

  it('the single-type PUT adds a type to a kind already holding 200', async () => {
    seed('onemore', { entity: typesOf(OLD_LIMIT) });
    const r = await inst.doors['put-single-type']('onemore', { typeSchemas: { entity: { brandNew: {} } } });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(count('onemore'), OLD_LIMIT + 1);
  });

  it('a library group apply takes a kind past 200 types', async () => {
    seed('groupmany', { entity: typesOf(OLD_LIMIT - 1) });
    const r = await callRoute(schemaLibraryRouter, 'post', '/groups/:group/apply', { params: { group: 'many' }, body: { spaceId: 'groupmany' }, authToken: AUTH });
    assert.equal(r.code, 200, JSON.stringify(r.body).slice(0, 300));
    assert.equal(count('groupmany'), OLD_LIMIT + 1);
  });

  it('PATCH and schema_update write more than 200 types of one kind', async () => {
    const patch = await inst.doors['space-patch']('patchmany', { typeSchemas: { fact: typesOf(OLD_LIMIT + 1) } });
    assert.equal(patch.status, 200, patch.text.slice(0, 300));
    assert.equal(count('patchmany', 'fact'), OLD_LIMIT + 1);
    const tool = await inst.doors['mcp-schema-update']('toolmany', { typeSchemas: { edge: typesOf(OLD_LIMIT + 1) } });
    assert.equal(tool.refused, false, tool.text.slice(0, 300));
    assert.equal(count('toolmany', 'edge'), OLD_LIMIT + 1);
  });

  it('with the storage hard limit reached, a write that grows the schema is refused 507 with the quota\'s sentence on every door, and nothing is stored', atTheLimit(async () => {
    seed('quota', { entity: typesOf(3) });
    const quotaWords = /Storage (total|brain) hard limit exceeded: [\d.]+ GiB used of 0 GiB allowed/;
    const one = await inst.doors['put-single-type']('quota', { typeSchemas: { entity: { added: {} } } });
    assert.equal(one.status, 507, one.text.slice(0, 300));
    assert.match(one.body?.error ?? '', quotaWords);
    assert.equal(one.body?.storageExceeded, true);
    const whole = await inst.doors['put-schema']('quota', { typeSchemas: { entity: typesOf(4) } });
    assert.equal(whole.status, 507, whole.text.slice(0, 300));
    const patch = await inst.doors['space-patch']('quota', { typeSchemas: { entity: { added: {} } } });
    assert.equal(patch.status, 507, patch.text.slice(0, 300));
    assert.match(patch.text, quotaWords);
    const tool = await inst.doors['mcp-schema-update']('quota', { typeSchemas: { entity: { added: {} } } });
    assert.equal(tool.refused, true, tool.text.slice(0, 300));
    assert.match(tool.text, quotaWords);
    const group = await callRoute(schemaLibraryRouter, 'post', '/groups/:group/apply', { params: { group: 'many' }, body: { spaceId: 'quota' }, authToken: AUTH });
    assert.equal(group.code, 507, JSON.stringify(group.body).slice(0, 300));
    assert.deepEqual(Object.keys(inst.heldTypes('quota').entity).sort(), ['t0', 't1', 't2'], 'a refused write stored types');
    const shrink = await inst.doors['put-schema']('quota', { typeSchemas: { entity: typesOf(2) } });
    assert.equal(shrink.status, 200, `a write that frees room was refused at the limit: ${shrink.text.slice(0, 300)}`);
    assert.equal(count('quota'), 2);
  }));

  it('a schema larger than one stored document is refused 413 naming that limit, and nothing is written: not the meta, not a backup', async () => {
    seed('huge', { entity: { kept: {} } });
    const filesDir = path.join(process.env['DATA_ROOT'], 'files', 'huge');
    const backups = () => (fs.existsSync(filesDir) ? fs.readdirSync(filesDir).filter(f => f.startsWith('_schema-backup-')) : []);
    const big = tooLarge();
    const whole = await inst.doors['put-schema']('huge', { typeSchemas: { entity: big } });
    assert.equal(whole.status, 413, whole.text.slice(0, 300));
    assert.match(whole.body?.error ?? '', /16 MiB/);
    assert.match(whole.body?.error ?? '', /one stored document/);
    assert.equal(whole.body?.code, 'schema_too_large');
    assert.deepEqual(backups(), [], 'a refused PUT wrote a backup of the schema it did not replace');
    const patch = await inst.doors['space-patch']('huge', { typeSchemas: { entity: big } });
    assert.equal(patch.status, 413, patch.text.slice(0, 300));
    assert.deepEqual(Object.keys(inst.heldTypes('huge').entity), ['kept'], 'a refused write stored types');
  });

  it('source check: no count cap on types is left in the server, the schema package or the client', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', 'server/src', 'schema/src', 'client/src'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|mjs|js|html)$/.test(f));
    const hits = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      if (/MAX_TYPES_PER_KIND|type definitions per knowledge type|typesAddedPastCap|types-added-past-cap|overCap\b|'type-cap'/.test(text)) hits.push(f);
    }
    assert.deepEqual(hits, [], 'a count cap on types is still in these files');
  });
});
