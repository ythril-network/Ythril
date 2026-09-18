/**
 * A token that reaches exactly ONE space does not have to name it.
 *
 * ## The report this comes from, and why the fix is not a benchmark fix
 *
 * `B-6`, found 2026-09-15 reading a generic MCP benchmark harness. It matches a tool by name, fills the
 * parameters it recognises and calls it — which against us means `save_fact({fact: "…"})`, refused for a
 * missing `space` the client has no way to know we want. The run then stores nothing, searches an empty
 * space and scores about zero, **with no error anybody sees**: the adapter's reset failure is inside a
 * bare `except: pass` and the ingest failure is one 400 in a log nobody reads.
 *
 * The adapter is doing what any generic client does. What makes it fail is ours.
 *
 * ## Why one space is the line
 *
 * `space`'s enum is already narrowed to the spaces the calling token reaches. When that list has exactly
 * one member there is no other space the call could mean, so requiring it buys no safety and costs every
 * caller who did not read the schema. With two or more the omission is genuinely ambiguous, and guessing
 * would write a record into a space nobody named — so it stays required, and the refusal NAMES them.
 *
 * ## What this file will not let happen
 *
 * **The advertised schema and the enforced one are the same object.** A tool whose `required` still lists
 * `space` while the dispatcher defaults it is a caller told to send something they need not; the reverse
 * is a caller told they may omit it and then refused. Both are asserted, per token.
 *
 * **A READ is a different question and must not move.** `recall` and `filter` already treat an omitted
 * `space` as *"every space I can reach"* — an answer, not a default. Folding the two would turn a
 * cross-space search into a single-space one the day a token gains a second space.
 *
 * Run: node --test testing/integration/one-space-needs-no-naming.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody, readCollection } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const ONE = `solo-${RUN}`;
const TWO_A = `pair-a-${RUN}`;
const TWO_B = `pair-b-${RUN}`;

let admin;
/** Reaches exactly one space. */
let soloToken;
/** Reaches two, so an omitted `space` is genuinely ambiguous. */
let pairToken;

const mkSpace = async (id) => {
  const r = await post(INSTANCES.a, admin, '/api/spaces', { id, label: id });
  assert.ok([201, 409].includes(r.status), `create ${id}: ${JSON.stringify(r.body)}`);
};

const mkToken = async (spaces) => {
  const r = await post(INSTANCES.a, admin, '/api/tokens', {
    name: `b6-${spaces.join('-')}-${RUN}`, rights: legacyRights({ spaces }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.plaintext;
};

before(async () => {
  admin = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  await mkSpace(ONE);
  await mkSpace(TWO_A);
  await mkSpace(TWO_B);
  soloToken = await mkToken([ONE]);
  pairToken = await mkToken([TWO_A, TWO_B]);
});

after(async () => {
  for (const id of [ONE, TWO_A, TWO_B]) {
    await delWithBody(INSTANCES.a, admin, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

/** A tool's materialised schema, as THIS token is shown it. */
const schemaFor = async (token, toolName) => {
  const session = await openMcpSession(token);
  try {
    // `listTools()` already unwraps the JSON-RPC envelope and returns the ARRAY.
    const tool = (await session.listTools()).find(t => t.name === toolName);
    assert.ok(tool, `${toolName} is not advertised to this token`);
    return tool.inputSchema;
  } finally {
    session?.close?.();
  }
};

describe('one reachable space needs no naming', () => {
  it('a write with no `space` lands, on both doors', async () => {
    const viaRest = await post(INSTANCES.a, soloToken, '/api/save_fact', { fact: `solo rest ${RUN}` });
    assert.equal(viaRest.status, 200, JSON.stringify(viaRest.body));

    const session = await openMcpSession(soloToken);
    try {
      const viaMcp = await session.callTool('save_fact', { fact: `solo mcp ${RUN}` });
      assert.ok(!viaMcp?.isError, JSON.stringify(viaMcp));
    } finally {
      session?.close?.();
    }

    // And they landed in the ONE space, rather than being accepted and dropped.
    const back = await readCollection(INSTANCES.a, soloToken, ONE, 'facts', { limit: 50 });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const facts = (back.results ?? []).map(r => r.fact);
    assert.ok(facts.includes(`solo rest ${RUN}`), 'the REST write did not reach the space');
    assert.ok(facts.includes(`solo mcp ${RUN}`), 'the MCP write did not reach the space');
  });

  it('and the schema that token is SHOWN says so', async () => {
    // The half that makes the behaviour discoverable. A tool that accepts the omission while advertising
    // `space` as required tells every caller who reads the schema to send something they need not.
    const schema = await schemaFor(soloToken, 'save_fact');
    assert.ok(!(schema.required ?? []).includes('space'),
      `save_fact still advertises \`space\` as required to a single-space token: ${JSON.stringify(schema.required)}`);
    assert.ok((schema.required ?? []).includes('fact'),
      'the other required arguments must be unaffected — this is about `space` alone');
  });
});

describe('two reachable spaces still need one named', () => {
  it('a write with no `space` is refused, and the refusal names them', async () => {
    const viaRest = await post(INSTANCES.a, pairToken, '/api/save_fact', { fact: `pair rest ${RUN}` });
    assert.equal(viaRest.status, 400, JSON.stringify(viaRest.body));
    const text = JSON.stringify(viaRest.body);
    assert.ok(text.includes(TWO_A) && text.includes(TWO_B),
      `the refusal must name the spaces the caller can choose between: ${text}`);

    const session = await openMcpSession(pairToken);
    try {
      const viaMcp = await session.callTool('save_fact', { fact: `pair mcp ${RUN}` });
      assert.ok(viaMcp?.isError, `the tool door accepted what REST refused: ${JSON.stringify(viaMcp)}`);
    } finally {
      session?.close?.();
    }
  });

  it('and that token IS shown `space` as required', async () => {
    const schema = await schemaFor(pairToken, 'save_fact');
    assert.ok((schema.required ?? []).includes('space'),
      'a token with two reachable spaces must still be told to name one');
  });

  it('naming one still works, so the requirement is not a blanket refusal', async () => {
    const r = await post(INSTANCES.a, pairToken, '/api/save_fact', { space: TWO_B, fact: `pair named ${RUN}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const back = await readCollection(INSTANCES.a, pairToken, TWO_B, 'facts', { limit: 50 });
    assert.ok((back.results ?? []).some(x => x.fact === `pair named ${RUN}`), 'the named write did not land');
  });
});

describe('a READ is a different question and does not move', () => {
  it('an omitted `space` still means every space the token can reach', async () => {
    /*
     * The failure this prevents is the tempting generalisation: "omitted means the one space" applied to
     * a read would turn a cross-space search into a single-space one the day a token gains a second
     * space — silently, and looking like a smaller corpus rather than a narrower search.
     *
     * Asserted on the PAIR token, because that is where the two rules would visibly disagree.
     */
    await post(INSTANCES.a, pairToken, '/api/save_fact', { space: TWO_A, fact: `read-scope a ${RUN}` });
    await post(INSTANCES.a, pairToken, '/api/save_fact', { space: TWO_B, fact: `read-scope b ${RUN}` });

    const r = await post(INSTANCES.a, pairToken, '/api/filter', { collection: 'facts', limit: 200 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const facts = (r.body?.data?.results ?? []).map(x => x.fact);
    assert.ok(facts.includes(`read-scope a ${RUN}`) && facts.includes(`read-scope b ${RUN}`),
      'an omitted `space` on a read must still span every reachable space, not default to one');
  });
});
