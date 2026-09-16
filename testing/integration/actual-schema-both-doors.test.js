/**
 * The entity-relationship model comes back the same through both doors.
 *
 * ## Why the tool exists
 *
 * The actual shape of a space — what it HOLDS, not what it declares — answers the question an agent asks FIRST:
 * which entity types are actually here, which edge labels connect which of them, and how many of each.
 * `space_meta` answers a different question — the DECLARED schema, what may exist — so an MCP-only client
 * could learn what a space permits and not what it contains.
 *
 * It began as a REST-only route found by `scripts/surface-matrix.mjs`, became a tool, and folded into the space meta at 5.0 — three shapes, one claim: both doors, one answer.
 *
 * ## What these assertions are for
 *
 * Not "the tool returns 200". The two doors must return the SAME model from the same fixture, because a second
 * implementation that merely looks right is the defect this repo produces most. The fixture is built so the
 * answer is not trivially empty: two entity types and an edge between them, so a wrong narrowing or a dropped
 * relationship shows up as a difference rather than as two identical empty objects.
 *
 * Run: node --test testing/integration/actual-schema-both-doors.test.js
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
const SPACE = `actual-schema-${RUN}`;

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

/*
 * THE TOOL WENT; THE PARITY CLAIM DID NOT. `er_model` folded into `space_meta` at 5.0 and its route folded
 * into `GET /api/spaces/:id/meta`, arriving as `actualSchema`. What this file was written to catch is
 * unchanged and is if anything easier to get wrong now: the answer is assembled in two places, so the two
 * doors can drift while each looks right on its own.
 *
 * That very defect shipped in the fold and was caught on a live instance rather than by a build — the fold
 * went in on MCP first, leaving REST without the capability at all, and then returned `{ members }` where
 * the proxy form must be `{ spaceId, members }`.
 */
describe('the actual schema reaches both doors with the same answer', () => {
  it('REST reports the two types and the relationship', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${SPACE}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const json = JSON.stringify(r.body?.actualSchema);
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
      const rest = await get(INSTANCES.a, token(), `/api/spaces/${SPACE}/meta`);
      const res = await session.callTool('space_meta', { space: SPACE });
      const text = res?.content?.[0]?.text ?? '';
      const mcp = JSON.parse(text);
      // Same object, not merely both plausible. One builder serves both, and this is what says so.
      assert.deepEqual(mcp.actualSchema, rest.body?.actualSchema,
        `the two doors disagree:\nMCP:  ${JSON.stringify(mcp.actualSchema).slice(0, 300)}\nREST: ${JSON.stringify(rest.body?.actualSchema).slice(0, 300)}`);
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
      const res = await session.callTool('space_meta', { space: `no-such-space-${RUN}` });
      const text = JSON.stringify(res ?? {});
      // NOT just /error/: against a stale image this assertion passed on "Unknown tool: space_meta", which is
      // a refusal of the TOOL rather than of the space — a false pass that hid the tool being absent.
      assert.doesNotMatch(text, /Unknown tool/i, 'the tool itself must exist — rebuild the test image');
      assert.match(text, /space|not found|not accessible/i,
        `an unknown space must be refused rather than answered: ${text.slice(0, 200)}`);
    } finally {
      session.close();
    }
  });
});

