/**
 * Starting an ingest run is rate limited per token, and the two doors share ONE count (`S-8`).
 *
 * A run is minutes of model calls. MCP `ingest` was declared `heavy`, so `callTool` held it to the heavy-call
 * rail; `POST /api/brain/spaces/:spaceId/ingest` had only the global limiter — a `knowledge: write` token could
 * start runs without bound over REST and exhaust the model backends. The rail now sits in `beginIngest`, the module
 * both doors call, so neither can start a run without it.
 *
 * What is asserted: REST reaches the limit; MCP, called with the same token, is refused by the same count in the
 * same words; and a start refused BEFORE anything is paid for (a space missing the group's types) is still answered
 * with that refusal, never with the rate limit — the rail counts runs, not attempts.
 *
 * Named to run after `ingest-writes-a-conversation`, which starts runs with the same token and would otherwise find
 * the window full.
 *
 * Run: node --test testing/integration/the-ingest-rail-holds-on-both-doors.test.js
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
const WITH_GROUP = `ingest-rail-${RUN}`;
const WITHOUT_GROUP = `ingest-rail-bare-${RUN}`;
/** More starts than any per-minute rail of this kind allows, so a working rail must refuse one of them. */
const ATTEMPTS = 12;

let token;
let mcp;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  for (const id of [WITH_GROUP, WITHOUT_GROUP]) {
    const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const applied = await post(INSTANCES.a, token, '/api/schema-library/groups/conversation/apply', { spaceId: WITH_GROUP });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
});

after(async () => {
  for (const id of [WITH_GROUP, WITHOUT_GROUP]) await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

/** The smallest extraction the group accepts: it asks no model, so a started run costs the stack nothing. */
const extraction = (conversationId) => ({
  conversationId,
  sessions: [{ date: '2023-05-10', turns: ['s1:1'], text: 'Ada: Hello.' }],
  entities: [{ key: 'ada', type: 'person', name: `Ada ${conversationId}`, description: 'Ada said hello.', sourceTurns: ['s1:1'] }],
  existingEntities: [], edges: [], chrono: [], claims: [],
  producedBy: { extractor: 'ythril-conversation', unattended: true, backends: ['test'] },
});

const restStart = (space, id) => post(INSTANCES.a, token, `/api/brain/spaces/${space}/ingest`, { kind: 'conversation', extraction: extraction(id) });

describe('the ingest rail', () => {
  let limited;

  it('REST: a token starting runs in a burst is refused with 429 before the burst ends', async () => {
    const statuses = [];
    for (let i = 0; i < ATTEMPTS; i++) {
      const r = await restStart(WITH_GROUP, `rail-rest-${RUN}-${i}`);
      statuses.push(r.status);
      if (r.status === 429) { limited = r.body.error; break; }
      assert.equal(r.status, 202, JSON.stringify(r.body));
    }
    assert.ok(limited, `${ATTEMPTS} REST starts from one token, none refused: ${JSON.stringify(statuses)}`);
    assert.match(limited, /rate limited/);
  });

  it('MCP: the same token is refused by the same count, in the same words', async () => {
    assert.ok(limited, 'the REST case did not reach the limit');
    const r = await mcp.callTool('ingest', { space: WITH_GROUP, kind: 'conversation', extraction: extraction(`rail-mcp-${RUN}`) });
    assert.equal(r?.isError, true, `MCP started a run the REST door had already used up: ${JSON.stringify(r)}`);
    assert.equal(r.content?.[0]?.text, limited);
  });

  it('a start refused before anything is paid for keeps its own refusal, while limited', async () => {
    assert.ok(limited, 'the REST case did not reach the limit');
    const r = await restStart(WITHOUT_GROUP, `rail-bare-${RUN}`);
    assert.equal(r.status, 409, `a space missing the group was answered ${r.status}: ${JSON.stringify(r.body)}`);
  });
});
