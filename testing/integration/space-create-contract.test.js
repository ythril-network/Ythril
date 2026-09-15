/**
 * The refusal contract of `POST /api/spaces` — characterization, ahead of an extraction.
 *
 * ## Why this lands before the code moves
 *
 * B-2's last two capabilities are `save_space` and `reindex`, and `save_space` is the 9-refusal one:
 * `createSpace()` exists in `spaces/lifecycle.ts`, but this route wraps it in checks that an MCP tool calling
 * `createSpace()` directly would skip — proxy member existence, proxy nesting, the schema-library `$ref`, and the
 * strict-flag seeding. That is the *two surfaces, one rule, one weaker* defect the whole item is about, and it would
 * be reintroduced by the fix for it.
 *
 * So the chain moves into something both surfaces call, and this is the net under it. Its own PR against the unmoved
 * route, for the reason the `PATCH` pair had: a characterization test written in the same commit as the change it
 * guards cannot show which behaviour it was describing.
 *
 * ## What is pinned here, and what is already pinned elsewhere
 *
 * `spaces.test.js` already covers the happy paths and two refusals — auto-slug and explicit id, the strict-posture
 * defaults, an explicit `meta` overriding them, the extraction-mode cap, `409` on a duplicate id, and `400` on
 * invalid slug characters. None of that is repeated.
 *
 * What is NOT covered anywhere, and is exactly what an extraction can drop:
 *
 *  - **the two proxy refusals**, which are the only checks that read OTHER spaces to validate this one;
 *  - **`422` for a broken schema-library `$ref` at CREATE time.** `broken-library-ref-refused-everywhere.test.js`
 *    asserts the call site exists by reading source; nothing asserted the route actually answers 422. A source gate
 *    and a runtime test fail for different reasons, and this route is the one that had the defect;
 *  - **that a refused create leaves NO SPACE BEHIND.** This is the ordering guarantee, and it is the one a
 *    plan/apply split is most likely to lose: validate, create, then check would return the right status while
 *    stranding a space the caller has to clean up. Every refusal below asserts a `404` from the follow-up `GET`.
 *  - **`faceDescriptorDims` bounds**, because a space's descriptor width cannot be changed after creation. A value
 *    that slips through here is unfixable without deleting the space.
 *
 * Run: node --test testing/integration/space-create-contract.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();

let token;
const created = [];

/** A space id nobody else in this run will use. */
const idFor = (what) => `create-${what}-${RUN}`;

async function create(body) {
  const r = await post(INSTANCES.a, token, '/api/spaces', body);
  if (r.status === 201) created.push(r.body.space?.id ?? body.id);
  return r;
}

/** Did the route leave anything behind? A refusal must answer 404 here. */
async function exists(id) {
  const r = await get(INSTANCES.a, token, `/api/spaces/${id}/meta`);
  return r.status !== 404;
}

before(() => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
});

after(async () => {
  for (const id of created) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('POST /api/spaces — the proxy refusals, which read other spaces to validate this one', () => {
  it('400 when a proxy member does not exist, and no space is created', async () => {
    const id = idFor('proxy-missing');
    const r = await create({ id, label: 'Proxy missing member', proxyFor: [`no-such-space-${RUN}`] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /not found/i);
    assert.equal(await exists(id), false, 'a refused create must not leave the space behind');
  });

  it('400 when a proxy member is itself a proxy — nesting is refused, and nothing is created', async () => {
    // Needs a real member and a real proxy over it, so this is the one case that cannot be checked without
    // building two spaces first. That is also why it is the refusal most likely to be dropped by an extraction:
    // it is the only one whose input is the rest of the config rather than the request body.
    const member = idFor('proxy-base');
    const firstProxy = idFor('proxy-level1');
    const nested = idFor('proxy-level2');

    assert.equal((await create({ id: member, label: 'Proxy base' })).status, 201);
    assert.equal((await create({ id: firstProxy, label: 'Proxy level 1', proxyFor: [member] })).status, 201);

    const r = await create({ id: nested, label: 'Proxy level 2', proxyFor: [firstProxy] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /nesting/i, 'the message must say WHY, not just that it failed');
    assert.equal(await exists(nested), false);
  });

  it('the wildcard proxy is accepted — it is a sentinel, not a member list', async () => {
    // `['*']` must skip per-member validation entirely. An extraction that validated it as a member id would
    // refuse every wildcard proxy space, and the refusal would read as "space '*' not found".
    const id = idFor('proxy-wildcard');
    const r = await create({ id, label: 'Proxy wildcard', proxyFor: ['*'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

describe('POST /api/spaces — the schema-library $ref, at create time', () => {
  it('422 for a $ref to an entry that does not exist, naming it, and no space is created', async () => {
    // The reported defect this route once had: the create reported success and stored an EMPTY schema, so in a
    // strict space — which is the posture this very handler seeds — one mistyped ref left the type with no
    // constraints while its schema looked authored. The three editing routes answered 422 already; only this one
    // did not, and it is the one people make the mistake on, because the space and its schema arrive together.
    const id = idFor('broken-ref');
    const r = await create({
      id, label: 'Broken ref',
      meta: { typeSchemas: { entity: { widget: { $ref: `library:absent-${RUN}` } } } },
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /Schema library[\s\S]*not found/);
    assert.match(r.body.error, new RegExp(`absent-${RUN}`));
    assert.equal(await exists(id), false, 'the ref check must run BEFORE the space is created');
  });

  it('the check does not fire on an inline schema that merely looks like one', async () => {
    // Non-vacuity: the same shape WITHOUT a `$ref` must be accepted, or the test above would pass on a route that
    // refused every typeSchemas payload.
    const id = idFor('inline-schema');
    const r = await create({
      id, label: 'Inline schema',
      meta: { typeSchemas: { entity: { widget: { propertySchemas: { region: { type: 'string' } } } } } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
});

describe('POST /api/spaces — faceDescriptorDims, which a populated gallery can never change', () => {
  // It is changeable afterwards ONLY while the space has never held a face descriptor — see
  // `face-width-refused-by-state-not-surface.test.js`. So for a space that will hold photographs, a value
  // accepted here is effectively permanent, which is why the bounds are pinned at runtime and not just in the
  // schema: by the time the first face is stored there is no second chance to refuse it.
  for (const [what, dims] of [['too small', 32], ['too large', 8192], ['fractional', 128.5]]) {
    it(`400 for a ${what} descriptor width, and no space is created`, async () => {
      const id = idFor(`dims-${dims}`.replace('.', '-'));
      const r = await create({ id, label: `Dims ${dims}`, faceDescriptorDims: dims });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(await exists(id), false);
    });
  }

  it('accepts the two widths today’s recognisers actually use', async () => {
    // 128 (MobileFaceNet class) and 512 (ArcFace, AdaFace, FaceNet, EdgeFace). Bounds rather than an enum was a
    // deliberate call — pinning an enum would make the next model a code change — so the test names the real values
    // without asserting they are the only legal ones.
    for (const dims of [128, 512]) {
      const id = idFor(`dims-ok-${dims}`);
      const r = await create({ id, label: `Dims ok ${dims}`, faceDescriptorDims: dims });
      assert.equal(r.status, 201, `${dims} should be accepted: ${JSON.stringify(r.body)}`);
    }
  });
});

describe('POST /api/spaces — a refusal is complete, never partial', () => {
  it('a body carrying TWO faults answers for the parse first', async () => {
    // Ordering, the part a refactor loses silently. `validationMdoe` inside `meta` fails the strict parse; the
    // `$ref` would fail the library check. The parse runs first, so an unknown key is never reported as a
    // schema-library problem — the two failures send the caller to different files.
    const id = idFor('two-faults');
    const r = await create({
      id, label: 'Two faults',
      meta: { validationMdoe: 'strict', typeSchemas: { entity: { w: { $ref: 'library:also-absent' } } } },
    });
    assert.equal(r.status, 400, `expected the strict parse to win, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(await exists(id), false);
  });

  it('a proxy space is left un-seeded, while a normal one gets the strict posture', async () => {
    // The seeding decision is a REFUSAL's mirror image and belongs in the same extracted function: a proxy space
    // holds no data of its own, so defaulting it to strict would be enforcing a schema on records it never stores.
    const plain = idFor('seed-plain');
    const proxy = idFor('seed-proxy');
    assert.equal((await create({ id: plain, label: 'Seed plain' })).status, 201);
    assert.equal((await create({ id: proxy, label: 'Seed proxy', proxyFor: ['*'] })).status, 201);

    const plainMeta = await get(INSTANCES.a, token, `/api/spaces/${plain}/meta`);
    assert.equal(plainMeta.body.validationMode, 'strict', 'a new space enforces its schema from day one');
    assert.equal(plainMeta.body.strictLinkage, true);

    const proxyMeta = await get(INSTANCES.a, token, `/api/spaces/${proxy}/meta`);
    assert.equal(proxyMeta.body.validationMode, undefined, 'a proxy space is not seeded — it stores nothing to validate');
  });
});
