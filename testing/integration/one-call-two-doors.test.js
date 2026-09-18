/**
 * The same call, through both doors, answers the same thing — proved against a running instance.
 *
 * ## Why this test rather than another source gate
 *
 * `one-capability-is-one-shape.test.js` reads the source and asserts that both doors dispatch through
 * `callTool` and that neither performs a check of its own. That is the structural half, and it is the half
 * that cannot rot quietly. What it cannot show is that the structure produces the same ANSWER, and every
 * expensive lesson in this repo is about a rule whose two implementations were each defensible.
 *
 * So this drives both doors with identical arguments and compares what comes back. Where they must differ —
 * an HTTP status exists and JSON-RPC has none — the difference is asserted rather than excused.
 *
 * ## What is asserted, and why the refusals matter more than the successes
 *
 * A capability that works on both doors is the easy half; it is what everybody checks. The refusals are
 * where the doors historically diverged: one validated existence and the other only shape, one demanded
 * `confirm` and the other did not, one checked the rung on the first named space and the other on all of
 * them. A refusal is also the thing a caller is least able to work around, because they cannot see why.
 *
 * Run: node --test testing/integration/one-call-two-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `two-doors-${RUN}`;

let tokenA;
let mcp;

/** The HTTP door: `POST /api/<tool-name>`, body is the arguments, nothing added. */
async function viaRest(tool, args) {
  const res = await fetch(`${INSTANCES.a}/api/${tool}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  return { status: res.status, ok: body.ok, text: body.ok ? body.text : body.error, data: body.data };
}

/** The MCP door: `tools/call` with the same arguments. */
async function viaMcp(tool, args) {
  const r = await mcp.callTool(tool, args);
  return {
    isError: r.isError === true,
    text: (r.content ?? []).map(c => c.text).join('\n'),
    data: r.structuredContent ?? null,
  };
}

/**
 * Both doors, one comparison.
 *
 * Returns the two answers so a caller can assert on the content as well, but the equality of the prose is
 * asserted HERE — so a new case cannot forget the assertion that is the entire point of the file.
 */
async function bothDoors(tool, args) {
  const rest = await viaRest(tool, args);
  const mcpAnswer = await viaMcp(tool, args);
  assert.equal(rest.text, mcpAnswer.text,
    `${tool} answers differently depending on the door:\n  REST: ${rest.text}\n  MCP:  ${mcpAnswer.text}`);
  assert.equal(rest.ok, !mcpAnswer.isError,
    `${tool} succeeded on one door and failed on the other`);
  assert.deepEqual(rest.data, mcpAnswer.data, `${tool} returns different structured data per door`);
  /*
   * AND THE ANSWER IS ACTUALLY IN THERE, which the equality above cannot tell you.
   *
   * `deepEqual(null, null)` passes, so this helper reported agreement for two doors that both answered
   * nothing — `space_stats` and `list_spaces` were doing exactly that from the day they were added here.
   * Thirty-three returns carried no structured half at all, and this file compared their absence and
   * called it parity.
   *
   * The condition is the rule the source gate holds: a call that SUCCEEDED carries a structured half.
   * Nothing about the text is consulted, and that width is deliberate — the first version keyed on the
   * text looking like JSON, which excused every write tool that reports its id in a sentence.
   *
   * It lives in the shared helper rather than in each case on purpose: a new case is written by copying
   * the one above it, and this is the line a copy drops.
   */
  if (rest.ok) {
    assert.notEqual(rest.data, null,
      `${tool} succeeded and carries nothing in \`data\` / \`structuredContent\`. A client that surfaces `
      + 'the structured form gets `null` and has to parse prose to recover a result it just asked for.');
  }
  return { rest, mcp: mcpAnswer };
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(tokenA);
  const created = await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: `Two doors ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
  mcp?.close();
});

describe('a read answers identically on both doors', () => {
  it('space_stats', async () => {
    const { rest } = await bothDoors('space_stats', { space: SPACE });
    assert.equal(rest.status, 200);
  });

  it('list_spaces, which takes no space at all', async () => {
    const { rest } = await bothDoors('list_spaces', {});
    assert.equal(rest.status, 200);
    assert.match(rest.text, new RegExp(SPACE), 'the space created in setup must be listed');
    // The text half is a bare ARRAY and the structured half must be an object, so the array is NAMED.
    // That naming is the one place the two halves are allowed to differ in shape, and it is worth an
    // assertion rather than an assumption.
    assert.ok(Array.isArray(rest.data?.spaces), `list_spaces must name its array: ${JSON.stringify(rest.data)}`);
  });

  it('space_meta', async () => {
    const { rest } = await bothDoors('space_meta', { space: SPACE });
    assert.equal(rest.status, 200);
  });

  it('network_peers, which is global and answers an array even with no peers', async () => {
    // The empty case on purpose: its text half is the PROSE 'No peers configured.', and the structured
    // half is `{peers: []}` unconditionally. A client reading the structured form must not have to
    // recognise a sentence to learn there are none.
    const { rest } = await bothDoors('network_peers', {});
    assert.equal(rest.status, 200);
    assert.ok(Array.isArray(rest.data?.peers), `network_peers must name its array: ${JSON.stringify(rest.data)}`);
  });

  it('graph_traverse, which answered `data: null` until 5.0', async () => {
    // Named because it is the one a walk was measured against: `{"ok":true,"text":"{\"nodes\":[…]}",
    // "data":null}`. The traversal need not FIND anything for the shape to be the subject.
    const seed = await viaRest('save_entity', { space: SPACE, name: `Seed ${RUN}`, type: 'person' });
    assert.equal(seed.ok, true, JSON.stringify(seed));
    const startId = seed.data?._id;
    assert.ok(startId, `save_entity must report the id it wrote: ${JSON.stringify(seed.data)}`);

    const { rest } = await bothDoors('graph_traverse', { space: SPACE, startId, maxDepth: 2 });
    assert.equal(rest.status, 200);
    assert.ok(Array.isArray(rest.data?.nodes), `graph_traverse must carry its nodes: ${JSON.stringify(rest.data)}`);
  });
});

describe('a write answers identically on both doors', () => {
  it('save_fact, then the fact is found by both', async () => {
    // Written once through HTTP. The point is not that the write works — it is that the tool a caller
    // reaches over HTTP is the same handler, so what MCP sees afterwards is what HTTP created.
    const written = await viaRest('save_fact', { space: SPACE, fact: `A fact from the HTTP door ${RUN}` });
    assert.equal(written.status, 200, JSON.stringify(written));
    assert.equal(written.ok, true);

    // `filter` requires both `collection` and `filter` — an empty predicate is "every row", which is what
    // this wants: the question is whether the OTHER door can see the write, not how well it filters.
    const seen = await viaMcp('filter', { space: SPACE, collection: 'facts', filter: {}, limit: 10 });
    assert.equal(seen.isError, false, seen.text);
    assert.match(seen.text, new RegExp(`A fact from the HTTP door ${RUN}`),
      'a fact written through the HTTP door must be readable through MCP — one store, one handler');
  });
});

describe('a refusal is the same refusal, and this is the half that used to differ', () => {
  it('an unknown space', async () => {
    const { rest } = await bothDoors('space_stats', { space: `no-such-space-${RUN}` });
    // The one sanctioned difference: HTTP has a status code and JSON-RPC does not, so the classification
    // that MCP carries in `isError` is carried here as a 404. The SENTENCE is identical.
    assert.equal(rest.status, 404, `an unknown space must be 404, got ${rest.status}`);
  });

  it('a list of spaces handed to a tool that takes one', async () => {
    const { rest } = await bothDoors('space_stats', { space: [SPACE, 'general'] });
    assert.equal(rest.status, 400);
    assert.match(rest.text, /takes one 'space', not a list/);
  });

  it('an empty list, which must not be read as "every space"', async () => {
    // The dangerous default: `[]` is what a caller's own filter produces when it matches nothing, and every
    // falsy check spells it the same as absent. Widening it would search everything at the exact moment the
    // caller meant nothing.
    const { rest } = await bothDoors('recall', { space: [], query: 'anything' });
    assert.equal(rest.status, 400);
    assert.match(rest.text, /empty list/);
  });

  it('a required argument left out', async () => {
    const { rest } = await bothDoors('save_fact', { space: SPACE });
    assert.equal(rest.status, 400);
  });

  it('an irreversible act without its confirmation', async () => {
    const { rest } = await bothDoors('delete_space_data', { space: SPACE });
    assert.match(rest.text, /confirm/);
    assert.ok(rest.status >= 400 && rest.status < 500, `expected a 4xx, got ${rest.status}`);
  });

  it('a body that is not an object, named as what it is', async () => {
    /*
     * A JSON array parses fine and answers every property lookup with `undefined`, so without a guard the
     * first gate to read one reports the wrong thing — `space_stats` with a body of `[1,2]` was refused
     * for "missing `space`", sending the caller after a field they never meant to send.
     */
    const res = await fetch(`${INSTANCES.a}/api/space_stats`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([1, 2]),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /must be an object/, `the refusal must name the BODY: ${body.error}`);
  });

  it('a tool that does not exist', async () => {
    // Not a 404 from express — the path `/api/no_such_tool` is not a tool name, so the router hands it back
    // to the app and the generic `/api` fallback answers. What must NOT happen is the tool door claiming it.
    const res = await fetch(`${INSTANCES.a}/api/no_such_tool_${RUN}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.ok, undefined, 'an unknown path must not be answered in the tool envelope');
  });
});

describe('the envelope is the same shape whatever the tool', () => {
  it('success carries ok, text and data; a refusal carries ok, error and data', async () => {
    /*
     * Asserted over several tools rather than one, because "one shape for every tool" is the promise a
     * caller writes their response handling against — and a single example proves only that one tool's
     * handler happens to be shaped that way.
     */
    for (const [tool, args] of [['space_stats', { space: SPACE }], ['list_spaces', {}], ['help', {}]]) {
      const res = await fetch(`${INSTANCES.a}/api/${tool}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const body = await res.json();
      assert.equal(res.status, 200, `${tool}: ${JSON.stringify(body)}`);
      assert.equal(body.ok, true, `${tool} must report ok`);
      assert.equal(typeof body.text, 'string', `${tool} must carry prose`);
      assert.ok('data' in body, `${tool} must carry a data key, even when it is null`);
    }

    const refused = await viaRest('space_stats', { space: `nope-${RUN}` });
    assert.equal(refused.ok, false);
    assert.equal(typeof refused.text, 'string');
  });
});
