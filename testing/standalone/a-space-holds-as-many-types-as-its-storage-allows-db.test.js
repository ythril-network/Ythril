/**
 * A space holds as many type definitions as its storage allows (bundle-382, Q-981; owner's decision): no door refuses a schema for its number of
 * types, the schema's growth asks the storage quota, and a schema larger than a peer takes a snapshot of (SCHEMA_SNAPSHOT_MAX_BYTES) is refused
 * before anything is written.
 *
 * ## What it holds
 *
 * - More than 200 types of one kind are written through every door that held the old per-kind count limit: `PUT /api/spaces/:id/schema`, the
 *   single-type `PUT`, a library group apply, the space `PATCH` and MCP `schema_update` (the schema-from-RDF door and the inference are held in
 *   their own specs: `an-rdf-import-inferring-a-schema-*`).
 * - A write that grows the schema while the storage hard limit is reached is refused `507` with the quota's own sentence (the area, what is
 *   used, what is allowed) and `storageExceeded`, as the fact doors are, and nothing is stored; a write that shrinks the schema is not asked, so
 *   an owner at the limit can still remove types.
 * - A schema whose stored text is past SCHEMA_SNAPSHOT_MAX_BYTES, the one bound (peers refuse to fetch a larger snapshot, so a schema between that
 *   and MongoDB's 16 MiB could be stored and never sync), is refused `413` with words naming that limit in bytes, and nothing is written: not
 *   the meta, not the backup `PUT /schema` writes of the schema it replaces. Every door asks: space create (both create doors), the single-type
 *   `PUT` and a library group apply included.
 * - The room check measures GROWTH: a small growth of a large schema passes while the quota has room for it, and a write that does not grow the
 *   schema is never refused, so a space already over the bound still takes a settings change and a shrink.
 * - The words state figures whose used value is visibly over the limit, at any size.
 * - No count cap is left in the sources: no `MAX_TYPES_PER_KIND`, no refusal sentence of it, no module of it.
 *
 * Run: node --test testing/standalone/a-space-holds-as-many-types-as-its-storage-allows-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { SERVER_CODE_ROOTS } from './_sources.mjs';
import { typesOfSize } from './_schema-near-bound.mjs';

const dir = tempInstanceDir('ythril-types-storage-');
const skip = await mongoSkipReason();
/** The old per-kind count limit: every case writes past it. */
const OLD_LIMIT = 200;
const AUTH = { rights: { instanceAdmin: true, perSpace: {} } };
const typesOf = (n, prefix = 't') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, {}]));
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const SPACES = ['putmany', 'onemore', 'groupmany', 'patchmany', 'toolmany', 'quota', 'huge', 'room', 'nearone', 'neargroup', 'over'];

describe('a space holds as many types as its storage allows', { skip, timeout: 600_000 }, () => {
  let inst, schemaLibraryRouter, schemaTextOf, BOUND, measureUsage, quotaSentence;
  /** A type map of the given text size, from the server's own text. */
  const sized = (bytes, kind) => typesOfSize(schemaTextOf, bytes, kind);
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
    ({ schemaTextOf } = await import('../../server/dist/spaces/schema-stamp.js'));
    ({ SCHEMA_SNAPSHOT_MAX_BYTES: BOUND } = await import('../../server/dist/spaces/schema-snapshot.js'));
    ({ measureUsage } = await import('../../server/dist/quota/quota.js'));
    ({ quotaSentence } = await import('../../server/dist/spaces/schema-room.js'));
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
    const quotaWords = /Storage (total|brain) hard limit exceeded: ([\d.]+) MiB used of 0 MiB allowed/;
    const one = await inst.doors['put-single-type']('quota', { typeSchemas: { entity: { added: {} } } });
    assert.equal(one.status, 507, one.text.slice(0, 300));
    assert.match(one.body?.error ?? '', quotaWords);
    assert.ok(Number(quotaWords.exec(one.body.error)[2]) > 0, `the sentence shows no used figure: ${one.body.error}`);
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

  /** The bytes a 413's words say the schema would take and the limit they name, read from the sentence. */
  const figuresOf = (text) => {
    const m = /would take (\d+) bytes[^]*?more than the (\d+) bytes/.exec(text);
    assert.ok(m, `the 413 words state no byte figures: ${text}`);
    return { took: Number(m[1]), limit: Number(m[2]) };
  };

  it('a schema past the snapshot limit peers take is refused 413 naming that limit in bytes, and nothing is written: not the meta, not a backup', async () => {
    seed('huge', { entity: { kept: {} } });
    const filesDir = path.join(process.env['DATA_ROOT'], 'files', 'huge');
    const backups = () => (fs.existsSync(filesDir) ? fs.readdirSync(filesDir).filter(f => f.startsWith('_schema-backup-')) : []);
    // Between the snapshot limit and MongoDB's 16 MiB: a document would hold it, and no peer would fetch it.
    const big = sized(BOUND + MiB, 'entity').entity;
    const whole = await inst.doors['put-schema']('huge', { typeSchemas: { entity: big } });
    assert.equal(whole.status, 413, whole.text.slice(0, 300));
    assert.equal(whole.body?.code, 'schema_too_large');
    assert.match(whole.body?.error ?? '', /peers/);
    assert.doesNotMatch(whole.body?.error ?? '', /16 MiB/, 'the words name a bound that is not the one asked');
    const { took, limit } = figuresOf(whole.body?.error ?? '');
    assert.equal(limit, BOUND, 'the words name another limit than SCHEMA_SNAPSHOT_MAX_BYTES');
    assert.ok(took > limit, `the words say the schema would take ${took} bytes against a limit of ${limit}: not over it`);
    assert.deepEqual(backups(), [], 'a refused PUT wrote a backup of the schema it did not replace');
    const patch = await inst.doors['space-patch']('huge', { typeSchemas: { entity: big } });
    assert.equal(patch.status, 413, patch.text.slice(0, 300));
    assert.deepEqual(Object.keys(inst.heldTypes('huge').entity), ['kept'], 'a refused write stored types');
  });

  it('the single-type PUT and a library group apply are refused 413 when they grow a schema past the bound, and store nothing', async () => {
    seed('nearone', sized(BOUND - 3, 'entity'));
    const one = await inst.doors['put-single-type']('nearone', { typeSchemas: { entity: { brandNew: {} } } });
    assert.equal(one.status, 413, one.text.slice(0, 300));
    assert.equal(one.body?.code, 'schema_too_large');
    assert.equal(inst.heldTypes('nearone').entity.brandNew, undefined, 'a refused single-type PUT stored the type');
    seed('neargroup', sized(BOUND - 3, 'entity'));
    const group = await callRoute(schemaLibraryRouter, 'post', '/groups/:group/apply', { params: { group: 'many' }, body: { spaceId: 'neargroup' }, authToken: AUTH });
    assert.equal(group.code, 413, JSON.stringify(group.body).slice(0, 300));
    assert.equal(group.body?.code, 'schema_too_large');
    assert.equal(inst.heldTypes('neargroup').entity.n1, undefined, 'a refused group apply stored the types');
  });

  it('space create with a schema past the bound is refused 413 on both create doors and no space exists; at the storage limit it is refused 507', async () => {
    const big = sized(BOUND + 1024, 'entity').entity;
    const exists = (id) => inst.loader.getConfig().spaces.some(s => s.id === id);
    for (const door of ['space-create', 'mcp-save-space']) {
      const r = await inst.doors[door]('crt', { typeSchemas: { entity: big } });
      assert.equal(r.status, 413, `${door}: ${r.text.slice(0, 300)}`);
      assert.match(r.text, /schema_too_large|peers refuse to fetch/, door);
      assert.equal(exists('crt-new'), false, `${door}: a refused create left a space`);
    }
    inst.loader.mutateConfig(cfg => { cfg.storage = { brain: { softLimitGiB: 0, hardLimitGiB: 0 } }; });
    try {
      const full = await inst.doors['space-create']('crt507', { typeSchemas: { entity: { added: {} } } });
      assert.equal(full.status, 507, full.text.slice(0, 300));
      assert.equal(full.body?.storageExceeded, true);
      assert.equal(exists('crt507-new'), false, 'a refused create left a space');
    } finally { inst.loader.mutateConfig(cfg => { delete cfg.storage; }); }
  });

  it('a small growth of a large schema passes while the quota has room for it, and is refused 507 once the growth passes the room', async () => {
    seed('room', sized(5 * MiB, 'entity'));
    const usedGiB = (await measureUsage(0)).brain;
    inst.loader.mutateConfig(cfg => { cfg.storage = { brain: { softLimitGiB: 0, hardLimitGiB: usedGiB + (2 * MiB) / GiB } }; });
    try {
      // Room for 2 MiB of growth: 3 MiB more is refused; the schema itself (5 MiB) is not what is asked.
      const more = { ...inst.heldTypes('room'), fact: sized(3 * MiB, 'fact').fact };
      const refused = await inst.doors['put-schema']('room', { typeSchemas: more });
      assert.equal(refused.status, 507, refused.text.slice(0, 300));
      const small = await inst.doors['put-single-type']('room', { typeSchemas: { entity: { added: {} } } });
      assert.equal(small.status, 200, `a few bytes of growth of a large schema was refused with room left: ${small.text.slice(0, 300)}`);
      assert.deepEqual(inst.heldTypes('room').fact, undefined, 'the refused growth stored types');
    } finally { inst.loader.mutateConfig(cfg => { delete cfg.storage; }); }
  });

  it('a space whose stored schema is already over the bound takes a settings change and a shrink; a growth is still refused', async () => {
    // Past the snapshot limit and past one MongoDB document alike: the schema grew past the bound before it was asked, or the bound was lowered.
    seed('over', sized(BOUND + 7 * MiB, 'entity'));
    const patch = await inst.doors['space-patch']('over', { strictLinkage: false });
    assert.equal(patch.status, 200, `a settings change that does not touch the schema was refused: ${patch.text.slice(0, 300)}`);
    const { pad3: _dropped, ...shrunk } = inst.heldTypes('over').entity;
    const shrink = await inst.doors['put-schema']('over', { typeSchemas: { entity: shrunk } });
    assert.equal(shrink.status, 200, `a shrink that stays over the bound was refused: ${shrink.text.slice(0, 300)}`);
    const grow = await inst.doors['put-single-type']('over', { typeSchemas: { entity: { more: {} } } });
    assert.equal(grow.status, 413, grow.text.slice(0, 300));
  });

  it('the quota sentence states figures whose used value is visibly over the limit, at any size', () => {
    const figure = (text, which) => {
      const m = /: ([\d.]+) (MiB|GiB) used of ([\d.]+) (MiB|GiB) allowed/.exec(text);
      assert.ok(m, text);
      const unit = (u) => (u === 'GiB' ? 1024 : 1);
      return which === 'used' ? Number(m[1]) * unit(m[2]) : Number(m[3]) * unit(m[4]);
    };
    for (const [used, limit] of [[0.02, 0], [0.003, 0.0029], [1.004, 1], [250.003, 250], [0.0004, 0.0001]]) {
      const text = quotaSentence('brain', used, limit);
      assert.ok(figure(text, 'used') > figure(text, 'limit'), `used ${used} GiB of ${limit} GiB reads as: ${text}`);
    }
  });

  it('source check: no count cap on types is left in the server, the schema package, the client or a test expecting one', () => {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const files = execFileSync('git', ['ls-files', ...SERVER_CODE_ROOTS, 'client/src', 'testing'], { cwd: root, encoding: 'utf8' }).split('\n').filter(f => /\.(ts|mjs|js|html)$/.test(f));
    // This file names the cap to say it is gone: the one place that may.
    const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join('/');
    const hits = [];
    for (const f of files) {
      if (f === self) continue;
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      if (/MAX_TYPES_PER_KIND|type definitions per knowledge type|typesAddedPastCap|types-added-past-cap|overCap\b|'type-cap'|[Mm]ax 200 types|exceeding 200 types|201st (entity )?type/.test(text)) hits.push(f);
    }
    assert.deepEqual(hits, [], 'a count cap on types is still in these files');
  });
});
