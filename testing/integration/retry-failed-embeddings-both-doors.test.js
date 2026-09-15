/**
 * Bulk retry of failed embeddings reaches both doors, and reports the same count.
 *
 * ## Why the tool exists
 *
 * `POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed` was REST-only. An agent recovering a space
 * after an embedder outage had to list the failures and call the single-file `retry_embed_file` once per file —
 * the shape of the reindex-by-curl-loop that motivated the `reindex` tool, where a customer did fourteen spaces
 * by hand because the agent planning their work could not do it.
 *
 * Found by `scripts/surface-matrix.mjs`. Filed as B-22.
 *
 * ## What is asserted, and what deliberately is not
 *
 * A fixture with a genuinely FAILED media job needs a broken file and a worker that gives up on it, which is
 * slow and flaky. So these assertions are about the contract both doors owe: the tool exists, it is refused for
 * a read-only token, an empty queue answers `0` rather than erroring, and the two doors return the same shape
 * and the same number on the same space.
 *
 * The count-when-there-are-failures path is covered by `embed-jobs-are-visible-db.test.js` on the REST side; the
 * point here is that MCP is not a second implementation of it.
 *
 * Run: node --test testing/integration/retry-failed-embeddings-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `retry-failed-${RUN}`;

let tokenA;
const token = () => tokenA;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `Retry failed ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('retry_failed_media_embeddings answers the same as its route', () => {
  it('REST reports a count, and zero is an answer rather than an error', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/embedding-queue/media/retry-failed`, {});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(typeof r.body.retried, 'number', `a count, not a message: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.retried, 0, 'a fresh space has no failed jobs');
  });

  it('the MCP tool reports the same count for the same space', async (t) => {
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('retry_embed_media', { space: SPACE });
      const text = JSON.stringify(res ?? {});
      // The tool must EXIST — against a stale image this is where an "Unknown tool" answer would hide.
      assert.doesNotMatch(text, /Unknown tool/i, 'the tool is missing — rebuild the test image');
      assert.equal(res?.structuredContent?.retried, 0,
        `structured count must match REST's: ${text.slice(0, 250)}`);
      assert.match(res?.content?.[0]?.text ?? '', /nothing to retry/i,
        'and the prose must say so plainly rather than reporting a bare 0');
    } finally {
      session.close();
    }
  });

  it('a read-only token cannot call it — it is a mutation', async (t) => {
    // `mutating: true` is what hides it from a readOnly token. A bulk re-queue creates no records and is still a
    // write, and getting that flag wrong is how a read-only token gains a side effect.
    //
    // The token is MINTED here rather than read from a fixture file. My first version looked for
    // `configs/a/readonly-token.txt`, which does not exist — so the case would have skipped for ever and proved
    // nothing, which is worse than not writing it. `mcp-tools.test.js` already had the recipe.
    const minted = await post(INSTANCES.a, token(), '/api/tokens', {
      name: `readonly-retry-failed-${RUN}`,
      rights: legacyRights({ readOnly: true })
    });
    assert.equal(minted.status, 201, `minting a read-only token: ${JSON.stringify(minted.body)}`);
    const roToken = minted.body.plaintext;
    const roId = minted.body.id;

    let session;
    try {
      session = await openMcpSession(roToken);
      const res = await session.callTool('retry_embed_media', { space: SPACE });
      const text = JSON.stringify(res ?? {});
      // The refusal names the missing GRANT now rather than a flag: mutating tools are gated on holding a
      // write rung somewhere. `Unknown tool` stays in the alternation because a hidden tool can legitimately
      // be reported that way depending on how the client resolves the listing first.
      assert.match(text, /mutates|write rung|not permitted|Unknown tool/i,
        `a read-only token must not be able to re-queue anything: ${text.slice(0, 250)}`);

      // And it must not even be OFFERED: a tool a token cannot call should not appear in its listing.
      const listed = await session.listTools();
      assert.ok(!listed.some(x => x.name === 'retry_embed_media'),
        'a mutating tool must be hidden from a read-only token, not merely refused on call');
    } finally {
      session?.close();
      if (roId) {
        await fetch(`${INSTANCES.a}/api/tokens/${roId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token()}` },
        }).catch(() => {});
      }
    }
  });
});
