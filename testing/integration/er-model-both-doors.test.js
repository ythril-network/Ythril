/**
 * The entity-relationship model comes back the same through both doors.
 *
 * ## Why the tool exists
 *
 * `GET /api/brain/spaces/:spaceId/er-model` was REST-only, and it answers the question an agent asks FIRST:
 * which entity types are actually here, which edge labels connect which of them, and how many of each.
 * `space_meta` answers a different question — the DECLARED schema, what may exist — so an MCP-only client
 * could learn what a space permits and not what it contains.
 *
 * Found by `scripts/surface-matrix.mjs`, which listed `GET /er-model` in the REST-only column.
 *
 * ## What these assertions are for
 *
 * Not "the tool returns 200". The two doors must return the SAME model from the same fixture, because a second
 * implementation that merely looks right is the defect this repo produces most. The fixture is built so the
 * answer is not trivially empty: two entity types and an edge between them, so a wrong narrowing or a dropped
 * relationship shows up as a difference rather than as two identical empty objects.
 *
 * Run: node --test testing/integration/er-model-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `er-model-${RUN}`;

let tokenA;
const token = () => tokenA;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `ER model ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // Two types and a relationship, so the model has something to report either way.
  const svc = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `api-gateway-${RUN}`, type: 'service', tags: [], properties: {},
  });
  const team = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/entities`, {
    name: `platform-team-${RUN}`, type: 'team', tags: [], properties: {},
  });
  assert.equal(svc.status, 201, JSON.stringify(svc.body));
  assert.equal(team.status, 201, JSON.stringify(team.body));
  const edge = await post(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/edges`, {
    from: svc.body._id, to: team.body._id, label: 'owned_by',
  });
  assert.equal(edge.status, 201, JSON.stringify(edge.body));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('er_model reaches both doors with the same answer', () => {
  it('REST reports the two types and the relationship', async () => {
    const r = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/er-model`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const json = JSON.stringify(r.body);
    assert.match(json, /service/, `the stored types must appear: ${json.slice(0, 300)}`);
    assert.match(json, /team/);
    assert.match(json, /owned_by/, 'the edge label is the relationship half of the model');
  });

  it('the MCP tool returns the same model, byte for byte', async (t) => {
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const rest = await get(INSTANCES.a, token(), `/api/brain/spaces/${SPACE}/er-model`);
      const res = await session.callTool('er_model', { space: SPACE });
      const text = res?.content?.[0]?.text ?? '';
      const mcp = JSON.parse(text);
      // Same object, not merely both plausible. One builder serves both, and this is what says so.
      assert.deepEqual(mcp, rest.body, `the two doors disagree:\nMCP:  ${text.slice(0, 300)}\nREST: ${JSON.stringify(rest.body).slice(0, 300)}`);
    } finally {
      session.close();
    }
  });

  it('a space the token cannot reach is refused, not answered', async (t) => {
    // The tool narrows with `memberSpacesWithin`; a tool that ignored it would answer for any space id.
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('er_model', { space: `no-such-space-${RUN}` });
      const text = JSON.stringify(res ?? {});
      // NOT just /error/: against a stale image this assertion passed on "Unknown tool: er_model", which is
      // a refusal of the TOOL rather than of the space — a false pass that hid the tool being absent.
      assert.doesNotMatch(text, /Unknown tool/i, 'the tool itself must exist — rebuild the test image');
      assert.match(text, /space|not found|not accessible/i,
        `an unknown space must be refused rather than answered: ${text.slice(0, 200)}`);
    } finally {
      session.close();
    }
  });
});

