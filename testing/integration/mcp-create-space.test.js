/**
 * `save_space` over MCP — the same refusals as the route, because it is the same function.
 *
 * ## What only this file can check
 *
 * The chain itself is pinned by `space-create-contract.test.js` against `POST /api/spaces`, and both surfaces now call
 * `planSpaceCreate`. Re-asserting all of it here would be testing one function through two doors.
 *
 * What only this file can check is that the tool goes through that door at all — and for this capability that matters
 * more than for the others, because `createSpace()` has existed all along. A tool calling it directly would pass a
 * "did it create a space?" test while producing spaces a REST caller could not: un-seeded, no validation, or proxying
 * a space that does not exist. Every assertion below is one of those.
 *
 * Run: node --test testing/integration/mcp-create-space.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let token;
let session;
const created = [];

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

const idFor = (what) => `mcp-create-${what}-${RUN}`;
const meta = (id) => get(INSTANCES.a, token, `/api/spaces/${id}/meta`);

async function makeSpace(args) {
  const r = await session.callTool('save_space', args);
  if (!r?.isError && args.id) created.push(args.id);
  return r;
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  session = await openMcpSession(token);
});

after(async () => {
  session?.close();
  for (const id of created) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('create_space is offered and creates', () => {
  it('appears in tools/list for an admin token', async () => {
    const names = (await session.listTools()).map(t => t.name);
    assert.ok(names.includes('save_space'), `not offered: ${names.join(', ')}`);
  });

  it('creates a space and SEEDS the strict posture — the check a direct createSpace() call would skip', async () => {
    // The whole reason the chain was extracted. `createSpace()` has always existed, so a tool could have called it on
    // day one — and produced a space with no validation and no strict linkage, silently different from every space a
    // REST caller creates.
    const id = idFor('seeded');
    const r = await makeSpace({ id, label: `MCP created ${RUN}` });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);

    const m = await meta(id);
    assert.equal(m.status, 200, 'the space must be readable over REST — one store, two surfaces');
    assert.equal(m.body.validationMode, 'strict');
    assert.equal(m.body.strictLinkage, true);
  });

  it('derives the id from the label when none is given', async () => {
    const r = await session.callTool('save_space', { label: `Derived Slug ${RUN}` });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    const derived = r?.structuredContent?.id;
    assert.ok(derived, `the reply must name the id it chose: ${JSON.stringify(r)}`);
    created.push(derived);
    assert.match(derived, /^[a-z0-9-]+$/, 'a derived id must be a valid slug');
    assert.equal((await meta(derived)).status, 200);
  });

  it('an explicit meta wins over the seeded defaults', async () => {
    const id = idFor('explicit-meta');
    const r = await makeSpace({ id, label: 'Explicit meta', meta: { validationMode: 'off' } });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    assert.equal((await meta(id)).body.validationMode, 'off');
  });

  it('a proxy space is left UN-seeded, because it stores nothing to validate', async () => {
    const member = idFor('proxy-member');
    const proxy = idFor('proxy');
    assert.ok(!(await makeSpace({ id: member, label: 'Proxy member' }))?.isError);
    const r = await makeSpace({ id: proxy, label: 'Proxy over member', proxyFor: [member] });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    assert.equal((await meta(proxy)).body.validationMode, undefined);
  });
});

describe('create_space is held to the ROUTE rules, not looser ones', () => {
  it('REFUSES a proxy member that does not exist', async () => {
    // A direct `createSpace()` call would have accepted this and left a proxy pointing at nothing.
    const id = idFor('proxy-missing');
    const r = await makeSpace({ id, label: 'Proxy missing', proxyFor: [`no-such-${RUN}`] });
    assert.ok(r?.isError, `accepted: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /400/);
    assert.match(r.content[0].text, /not found/i);
    assert.equal((await meta(id)).status, 404, 'a refusal must not leave the space behind');
  });

  it('REFUSES proxy nesting', async () => {
    const base = idFor('nest-base');
    const level1 = idFor('nest-1');
    const level2 = idFor('nest-2');
    assert.ok(!(await makeSpace({ id: base, label: 'Nest base' }))?.isError);
    assert.ok(!(await makeSpace({ id: level1, label: 'Nest 1', proxyFor: [base] }))?.isError);

    const r = await makeSpace({ id: level2, label: 'Nest 2', proxyFor: [level1] });
    assert.ok(r?.isError, `accepted: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /nesting/i);
    assert.equal((await meta(level2)).status, 404);
  });

  it('REFUSES a $ref to a schema-library entry that does not exist', async () => {
    // 422, and the reason this refusal matters most on CREATE: the seeded posture is `strict`, so an unresolvable ref
    // would leave that type with no constraints at all while its schema looked authored.
    const id = idFor('broken-ref');
    const r = await makeSpace({
      id, label: 'Broken ref',
      meta: { typeSchemas: { entity: { widget: { $ref: `library:absent-${RUN}` } } } },
    });
    assert.ok(r?.isError, `accepted: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /422/);
    assert.match(r.content[0].text, new RegExp(`absent-${RUN}`));
    assert.equal((await meta(id)).status, 404);
  });

  it('reports a taken id as a CONFLICT, distinct from a failure', async () => {
    // 409 rather than a generic error, because "the id is taken" is often a successful retry whose response was lost.
    // An agent that can tell the two apart stops retrying; one that cannot keeps going.
    const id = idFor('conflict');
    assert.ok(!(await makeSpace({ id, label: 'First' }))?.isError);
    const r = await session.callTool('save_space', { id, label: 'Second' });
    assert.ok(r?.isError, `a duplicate id was accepted: ${JSON.stringify(r)}`);
    assert.match(r.content[0].text, /409/);
    assert.equal(r?.structuredContent?.outcome, 'conflict', 'the outcome must be machine-readable, not only prose');
  });

  it('REFUSES a descriptor width outside the bounds — it cannot be changed afterwards', async () => {
    const id = idFor('dims');
    const r = await makeSpace({ id, label: 'Bad dims', faceDescriptorDims: 32 });
    assert.ok(r?.isError, `accepted: ${JSON.stringify(r)}`);
    assert.equal((await meta(id)).status, 404);
  });

  it('ACCEPTS the widths real recognisers use, so the bounds test is not vacuous', async () => {
    const id = idFor('dims-512');
    const r = await makeSpace({ id, label: 'Good dims', faceDescriptorDims: 512 });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
  });

  it('REFUSES an unknown parameter rather than silently dropping it', async () => {
    const r = await session.callTool('save_space', { label: 'Typo', validationMdoe: 'strict' });
    assert.ok(r?.isError, `a misspelled parameter was accepted: ${JSON.stringify(r)}`);
  });
});
