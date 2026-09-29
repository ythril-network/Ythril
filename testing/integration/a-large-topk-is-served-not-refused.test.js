/**
 * A large `topK` is served on both doors — never a 500 (`Q-103`).
 *
 * `topK` has no ceiling (owner, P-34). The vector stage was handed a per-type limit that followed `topK` while its
 * candidate count stopped at 1000, and the index refuses `limit > numCandidates` — so a recall asking for more than
 * about 666 of a type answered a 500 labelled retryable. A `minPerType` floor above 1000 was a second route to it.
 *
 * Run: node --test testing/integration/a-large-topk-is-served-not-refused.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `q103-${RUN}`;

let admin, mcp;

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const s = await post(INSTANCES.a, admin, '/api/spaces', { id: SPACE, label: SPACE });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const e = await post(INSTANCES.a, admin, `/api/brain/spaces/${SPACE}/entities`, { name: 'Ada Lovelace', type: 'person' });
  assert.ok(e.status === 200 || e.status === 201, JSON.stringify(e.body));
  mcp = await openMcpSession(admin);
});

after(async () => {
  await mcp?.close?.();
  await delWithBody(INSTANCES.a, admin, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('a topK past what one vector stage used to allow', () => {
  for (const topK of [1500, 5000]) {
    it(`topK ${topK} answers 200 over REST`, async () => {
      const r = await post(INSTANCES.a, admin, '/api/brain/recall', { space: SPACE, query: 'mathematician', types: ['entity'], topK });
      assert.equal(r.status, 200, `a topK of ${topK} was refused: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    });

    it(`topK ${topK} answers over MCP`, async () => {
      const r = await mcp.callTool('recall', { space: SPACE, query: 'mathematician', types: ['entity'], topK });
      assert.ok(!r?.isError, `a topK of ${topK} was refused over MCP: ${r?.content?.[0]?.text?.slice(0, 300)}`);
    });
  }

  it('a minPerType floor above 1000 is clamped, not a second route to the 500', async () => {
    const r = await post(INSTANCES.a, admin, '/api/brain/recall', { space: SPACE, query: 'mathematician', topK: 5000, minPerType: { entity: 4000 } });
    assert.equal(r.status, 200, `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  });
});
