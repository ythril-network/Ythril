/**
 * Every sync read asks the area its rows belong to (bundle-47, Q-247).
 *
 * ## What was true before
 *
 * The sync GET routes asked only that the token reach the space. A local token holding nothing but `networks: read` on a space
 * read every fact, entity, edge, chrono entry, link and file row in it through `/api/sync/<family>?full=true`. Only the two schema
 * doors asked a rung (`schema_rung`).
 *
 * ## The rights decision, recorded here and in 09-sync-api.md
 *
 * | rows | routes | area |
 * |---|---|---|
 * | records and their tombstones | facts, entities, edges, chrono, links (page and by id), tombstones | `knowledge: read` |
 * | files | filemeta (page and by id), manifest, file-tombstones | `files: read` |
 * | both | merkle (a root over records and files) | both |
 * | schema | meta, schema-snapshot | `schema: read` (unchanged) |
 *
 * A refusal is `403 { code: '<area>_rung' }`, the spelling `schema_rung` already has. A peer token holds `write` on every area of a
 * network space, so sync between instances is unchanged.
 *
 * ## The gate is derived
 *
 * Every GET route mounted under `/api/sync` (`mountedRoutes()`) must have a row in the table below or be a network governance route
 * (`/api/sync/networks/...`, which asks the caller's standing in the network, not a space's area). A sync read added later with no
 * decision fails here.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-sync-read-asks-the-area-of-its-rows-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { mountedRoutes } from './_routes.mjs';

const skip = await mongoSkipReason();
const S = 'syncrung';

/** The decision: each sync read and the areas it needs. */
const AREAS = new Map([
  ...['facts', 'entities', 'edges', 'chrono', 'links'].flatMap(f => [[`/api/sync/${f}`, ['knowledge']], [`/api/sync/${f}/:id`, ['knowledge']]]),
  ['/api/sync/tombstones', ['knowledge']],
  ['/api/sync/filemeta', ['files']],
  ['/api/sync/filemeta/:id', ['files']],
  ['/api/sync/manifest', ['files']],
  ['/api/sync/file-tombstones', ['files']],
  ['/api/sync/merkle', ['knowledge', 'files']],
  ['/api/sync/meta', ['schema']],
  ['/api/sync/schema-snapshot', ['schema']],
]);
const isGovernance = (path) => path.startsWith('/api/sync/networks/');

let door; let server; const keys = {};

async function ask(path, key) {
  const url = `${server.url}${path.replace(':id', 'zqid')}?spaceId=${S}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

describe('every sync read asks the area of its rows', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'syncrung', spaces: [{ id: S, label: S, folders: [] }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const only = (granted) => Object.fromEntries(SPACE_AREAS.map(a => [a, granted.includes(a) ? 'read' : 'none']));
    const mintWith = async (name, granted) => (await tokens.createToken({
      name, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: only(granted) } },
    })).plaintext;
    keys.networks = await mintWith('networks-only', ['networks']);
    keys.knowledge = await mintWith('knowledge-only', ['knowledge']);
    keys.files = await mintWith('files-only', ['files']);
    server = await listenApp();
  });
  after(async () => { await server?.close(); await door?.close(); });

  it('every GET route under /api/sync has a rights decision and refuses a token that holds no area it reads (derived from the mounted routes)', async () => {
    const reads = mountedRoutes().filter(r => r.method.toUpperCase() === 'GET' && r.path.startsWith('/api/sync/')).map(r => r.path);
    assert.ok(reads.length >= 17, `only ${reads.length} sync GET route(s) found: the walk is wrong, not the code`);
    const undecided = reads.filter(p => !AREAS.has(p) && !isGovernance(p));
    assert.deepEqual(undecided, [], 'a sync read route has no recorded rights decision');
    const open = [];
    // The schema doors check their own parameters first (a snapshot needs a fingerprint) and have their own rung tests.
    for (const p of reads.filter(x => !isGovernance(x) && !(AREAS.get(x) ?? []).includes('schema'))) {
      const a = await ask(p, keys.networks);
      if (a.status !== 403 || !/_rung$/.test(a.body.code ?? '')) open.push(`${p} -> ${a.status} ${a.body.code ?? ''}`);
    }
    assert.deepEqual(open, [], 'a sync read served a token holding only networks: read');
  });

  for (const [path, areas] of AREAS) {
    for (const holder of ['networks', 'knowledge', 'files']) {
      const holds = areas.every(a => a === holder) && areas.length === 1;
      if (areas.includes('schema')) continue;   // the schema doors' rung is pinned by their own tests
      it(`GET ${path} for a token holding only ${holder}: read ${holds ? 'admitted' : `refused with ${areas.find(a => a !== holder)}_rung`}`, async () => {
        const a = await ask(path, keys[holder]);
        if (holds) {
          assert.ok(!(a.status === 403 && /_rung$/.test(a.body.code ?? '')), `refused a token that holds ${holder}: ${JSON.stringify(a.body)}`);
        } else {
          assert.equal(a.status, 403, `a token without ${areas.join(' and ')} read ${path}: ${a.status} ${JSON.stringify(a.body).slice(0, 160)}`);
          assert.equal(a.body.code, `${areas.find(x => x !== holder)}_rung`);
        }
      });
    }
  }
});
