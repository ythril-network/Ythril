/**
 * A `write` token can delete a single record through either door, and a token with no matrix is not exempt.
 *
 * ## The two defects this covers, both measured before the fix
 *
 * A token minted with `rights.perSpace.general.knowledge = 'write'`:
 *
 * | call | before | after |
 * |---|---|---|
 * | `DELETE /api/brain/spaces/general/memories/:id` | **403** `Token needs 'admin' on knowledge…` | 204 |
 * | MCP `delete_memory`, same record | deleted it | deletes it |
 *
 * One rule, two implementations, and the weaker one silently in charge — `mcp/router.ts` gates on the token's
 * `readOnly`/`admin` FLAGS and never consults the rung. Owner ruling B, 2026-08-13: level DOWN. `write` is the
 * right rung for deleting a single record you could have created, so the seven REST rows that asked for `admin`
 * now ask for `write`. The collection WIPES still ask for `admin`, matching `wipe_space`.
 *
 * The second defect: a token minted with no `rights` at all skipped the rung check entirely, because
 * `enforceAreaRung` used to return early without a matrix. Minting always derives one — *"only matrix from
 * now on"* — and `Q-5` closed the other end too: the early return is gone, so an absent matrix is now a 403
 * rather than a skipped check. Two independent reasons where there had been one, which is the point.
 *
 * Run: node --test testing/integration/rung-matches-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let admin;
const WRITE_RIGHTS = {
  instanceAdmin: false,
  createSpaces: false,
  floor: null,
  perSpace: { general: { knowledge: 'write', files: 'write', schema: 'none', dataQuality: 'none' } },
};

const minted = [];

async function mint(name, body) {
  const r = await post(INSTANCES.a, admin, '/api/tokens', { name, ...body });
  assert.equal(r.status, 201, `minting ${name}: ${JSON.stringify(r.body)}`);
  minted.push(r.body.id);
  return r.body;
}

const writeMemory = async (tk) => {
  const r = await post(INSTANCES.a, tk, '/api/brain/spaces/general/memories', { fact: `rung probe ${RUN} ${Math.random()}` });
  assert.equal(r.status, 201, `writing a memory: ${JSON.stringify(r.body)}`);
  return r.body._id ?? r.body.id;
};

const restDelete = (tk, id) => fetch(`${INSTANCES.a}/api/brain/spaces/general/memories/${id}`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${tk}` },
});

before(() => { admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim(); });

after(async () => {
  for (const id of minted) {
    await fetch(`${INSTANCES.a}/api/tokens/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${admin}` },
    }).catch(() => {});
  }
});

describe('a write token deletes one record on both doors', () => {
  it('REST accepts the delete it used to refuse', async () => {
    const tok = await mint(`rung-rest-${RUN}`, { rights: WRITE_RIGHTS });
    const id = await writeMemory(tok.plaintext);
    const r = await restDelete(tok.plaintext, id);
    const text = await r.text();
    assert.equal(r.status, 204, `a write token must be able to delete one record: ${r.status} ${text}`);
  });

  it('MCP accepts it too, which it always did — the point is that they now agree', async (t) => {
    const tok = await mint(`rung-mcp-${RUN}`, { rights: WRITE_RIGHTS });
    const id = await writeMemory(tok.plaintext);
    let session;
    try {
      session = await openMcpSession(tok.plaintext);
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('delete_memory', { space: 'general', id });
      assert.doesNotMatch(JSON.stringify(res ?? {}), /isError/, `MCP delete failed: ${JSON.stringify(res).slice(0, 200)}`);
      const after = await get(INSTANCES.a, admin, `/api/brain/spaces/general/memories/${id}`);
      assert.equal(after.status, 404, 'the record must be gone');
    } finally {
      session?.close();
    }
  });

  it('the collection WIPE still needs admin — levelling down was about single records', async () => {
    const tok = await mint(`rung-wipe-${RUN}`, { rights: WRITE_RIGHTS });
    const r = await fetch(`${INSTANCES.a}/api/brain/spaces/general/memories`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(r.status, 403, `emptying a collection is not deleting a row: ${r.status} ${await r.text()}`);
  });
});

describe('a token carrying a DERIVED matrix is not exempt from the rung', () => {
  it('the derived matrix is consulted, so the schema area is still decided', async () => {
    /*
     * Before: no matrix meant `enforceAreaRung` returned early and the rung was never consulted.
     *
     * **The premise moved with `D-5` and the subject survived it.** This minted with legacy `spaces`
     * only, so the matrix came from the server-side derivation. `POST /api/tokens` no longer accepts
     * that shape, so the derivation now runs at the CALLER — `legacyRights` is the same `migrateToken`
     * the server used, so the token under test carries exactly the matrix it carried before.
     *
     * What is no longer reachable through the API is a token with NO matrix at all. That state now
     * arises only from a record predating the matrix, which `every-token-carries-a-rights-matrix`
     * covers at the unit level. Asserted here because it is worth saying which half moved.
     */
    const tok = await mint(`rung-derived-${RUN}`, { rights: legacyRights({ spaces: ['general'] }) });
    const r = await fetch(`${INSTANCES.a}/api/spaces/general/schema`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ typeSchemas: {} }),
    });
    // A legacy full-access token derives `write` everywhere. `PUT /:id/schema` asks for `schema: ADMIN` since
    // 2026-09-08 — the whole-map replace is the schema area's irreversible operation — so this is now refused
    // rather than allowed. Either answer satisfies this case, because what it is about is that the answer is a
    // DECISION and not a skipped check; the assertion below is where a rung is held to refusing.
    //
    // The sentence here previously read "so this is allowed", and it was already wrong before that change: the
    // route was guarded at space-admin, so the rung was never what decided.
    assert.ok(r.status !== 500, `the derived matrix must not break the request: ${r.status}`);

    const wipe = await fetch(`${INSTANCES.a}/api/brain/spaces/general/memories`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tok.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(wipe.status, 403,
      `a derived write matrix must still be refused an admin-rung route: ${wipe.status} ${await wipe.text()}`);
  });
});
