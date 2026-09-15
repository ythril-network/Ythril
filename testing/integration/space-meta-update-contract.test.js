/**
 * The refusal contract of `PATCH /api/spaces/:id` — characterization, ahead of an extraction.
 *
 * ## Why this file exists before any refactor
 *
 * B-2: five capabilities were reachable over REST and not over MCP, and two of the five turned out to be thin
 * wrappers (`retry_embed_file` #842, `list_tokens` #843). The remaining three are not. `schema_update` is one
 * of them: `updateSpace()` exists, but this route wraps it in a chain of refusals, and an MCP tool that called
 * `updateSpace()` directly would skip every one — the *two surfaces, one rule, one weaker* defect, reintroduced by
 * the fix for it.
 *
 * So the chain has to move into something both surfaces call, and the move has to be provably behaviour-preserving.
 * These tests pin the chain against the UNMOVED handler. They are their own PR for the reason the #316→#317 pair
 * was: a characterization test written in the same commit as the change it guards proves nothing, because nobody
 * can tell whether it was written to describe the old behaviour or the new one.
 *
 * ## What is pinned, and why each one
 *
 *  - **The statuses**, per refusal: 404 · 400 malformed `If-Match` · 412 stale `If-Match` · 400 strict-parse ·
 *    422 broken schema-library `$ref`. Five different numbers, and an extraction that collapses any two of them
 *    into one is a breaking change for a caller branching on them.
 *  - **The ORDER**, which is the part a refactor silently loses. A request carrying two faults must answer for the
 *    earlier one, because the checks are not independent: the precondition exists to protect a caller from
 *    overwriting an edit they never saw, and a body validated before the precondition would report a body problem
 *    for a request that was never allowed to be applied at all.
 *  - **That a refusal changes NOTHING** — same `version`, same meta. The handler takes an audit snapshot mid-chain
 *    and applies three groups of local settings (dupe rules, record TTL, documentExtraction) before the meta path;
 *    once that logic lives in a function that returns a plan, "refused" and "partly applied" become easy to
 *    confuse, and `version` is the observable that tells them apart.
 *  - **The server-owned strip**, which is a behaviour with no schema: `version`, `updatedAt` and `previousVersions`
 *    come out of our own GET response and are stripped from an incoming body rather than rejected by `.strict()`.
 *    It lives at the call site, so an extraction can move the parse and leave the strip behind — and the failure
 *    is a 400 on the most ordinary thing a client does, which is read, edit one field, and write back.
 *
 * Deliberately NOT re-pinned here: merge-vs-replace `typeSchemas` semantics (`spaces.test.js`), the record-TTL
 * merge (`record-ttl.test.js`), scoped-admin authorisation (`spaces.test.js`), and the pure precondition function
 * (`standalone/meta-precondition.test.js`). This file is the refusal chain and the order of it, nothing else.
 *
 * Run: node --test testing/integration/space-meta-update-contract.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `meta-contract-${RUN}`;

let token;

/** The two observables that separate "refused" from "partly applied". */
async function metaNow() {
  const r = await get(INSTANCES.a, token, `/api/spaces/${SPACE}/meta`);
  assert.equal(r.status, 200, `reading meta failed: ${JSON.stringify(r.body)}`);
  return { version: r.body.version ?? 0, validationMode: r.body.validationMode, body: r.body };
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `Meta contract ${RUN}` });
  assert.equal(r.status, 201, `could not create the test space: ${JSON.stringify(r.body)}`);
  // One real write, so `version` is not 0 for the whole file. A precondition test against version 0 cannot
  // distinguish "matched" from "no meta has ever been written", which is the one case `If-Match: 0` is for.
  const w = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: { purpose: 'pinning the refusal chain' } });
  assert.ok([200, 202].includes(w.status), `seed write failed: ${w.status} ${JSON.stringify(w.body)}`);
});

after(async () => {
  await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('PATCH /api/spaces/:id — each refusal keeps its own status', () => {
  it('404 for a space that does not exist, ahead of every other check', async () => {
    // The body below would also fail the strict parse and the precondition. A 404 is the only correct answer:
    // nothing else in the chain is meaningful for a space that is not there, and reporting a body problem
    // would send the caller to fix the wrong thing.
    const r = await patch(INSTANCES.a, token, `/api/spaces/no-such-space-${RUN}`,
      { validationMdoe: 'strict' }, { 'If-Match': '99' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /not found/i);
  });

  it('400 for a malformed If-Match, naming what the header should have carried', async () => {
    // Ignoring an unparseable precondition would hand back exactly the false safety the header was asked for.
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { label: 'nope' }, { 'If-Match': 'abc' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /If-Match/);
    assert.equal((await metaNow()).version, before.version, 'a refused write must not bump the version');
  });

  it('412 for a stale If-Match, and the body says both versions', async () => {
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { label: 'nope' },
      { 'If-Match': String(before.version + 7) });
    assert.equal(r.status, 412, `a failed If-Match is 412, not 409: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.expectedVersion, before.version + 7);
    assert.equal(r.body.currentVersion, before.version);
    assert.equal((await metaNow()).version, before.version);
  });

  it('400 for an unknown key — .strict() is what makes a typo visible', async () => {
    // `validationMdoe` is the specific reason the body is strict rather than permissive: it looks like it turned
    // validation on, and a permissive parse would accept it, report 200, and leave the space wide open.
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: { validationMdoe: 'strict' } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const after = await metaNow();
    assert.equal(after.version, before.version);
    assert.equal(after.validationMode, before.validationMode, 'the misspelling must not have been applied either');
  });

  it('422 for a broken schema-library $ref, naming the missing entry', async () => {
    // 422 rather than 400: the body is well-formed and the reference is resolvable in principle — it just is not
    // there. An unresolvable ref used to degrade to an empty schema, so in a strict space the type lost every
    // constraint while the call reported success.
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, {
      // `entity`, not `entities`. The knowledge-type keys are singular, and `.strict()` on TypeSchemasZ means the
      // plural spelling answers 400 from the parse — which would make this test pass for the wrong reason on a
      // build where the $ref check had been removed entirely.
      meta: { typeSchemas: { entity: { widget: { $ref: `library:absent-entry-${RUN}` } } } },
    });
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /Schema library[\s\S]*not found/);
    assert.match(r.body.error, new RegExp(`absent-entry-${RUN}`), 'the message must name the entry, not just "invalid schema"');
    assert.equal((await metaNow()).version, before.version);
  });
});

describe('PATCH /api/spaces/:id — the order of the chain is part of the contract', () => {
  it('a stale If-Match beats a broken body: the precondition is evaluated first', async () => {
    // The ordering pin. Both faults are present; the answer must be 412. A precondition evaluated after
    // validation is not a precondition — it reports a body problem for a write that was never allowed to happen,
    // and the caller re-reads, re-applies, and hits the real conflict on the second attempt instead of the first.
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`,
      { meta: { validationMdoe: 'strict' } }, { 'If-Match': String(before.version + 7) });
    assert.equal(r.status, 412, `expected the precondition to win, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('a stale If-Match beats a broken $ref too', async () => {
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`,
      { meta: { typeSchemas: { entity: { widget: { $ref: 'library:also-absent' } } } } },
      { 'If-Match': String(before.version + 7) });
    assert.equal(r.status, 412, JSON.stringify(r.body));
  });

  it('the strict parse beats the $ref check: a typo is reported as a typo', async () => {
    // Both are body faults, so this one is about which message the caller gets. The parse runs first, which means
    // an unknown key is never reported as a schema-library problem — the two failures send you to different files.
    //
    // The typo goes INSIDE `meta`, and that placement is not incidental: `SpaceMetaBody` is `.strict()` while
    // `UpdateSpaceBody` is not, so a top-level unknown key is DROPPED rather than refused and this request would
    // have reached the $ref check and answered 422. The asymmetry is real and is filed separately; here it only
    // decides where a typo has to sit for the ordering to be observable at all.
    const before = await metaNow();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, {
      meta: { validationMdoe: 'strict', typeSchemas: { entity: { widget: { $ref: 'library:also-absent' } } } },
    });
    assert.equal(r.status, 400, `expected the strict parse to win, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal((await metaNow()).version, before.version);
  });
});

describe('PATCH /api/spaces/:id — accept what we emit', () => {
  /**
   * The meta a client would send back: what `GET /meta` gave us, plus all three server-owned names.
   *
   * The three are added explicitly rather than relied upon to be in the response, because a test that pins the
   * strip must not be able to pass by sending nothing worth stripping — and whether `version` has been written
   * yet depends on the instance (a networked space answers a meta change with 202 and a vote).
   *
   * The editable fields are PICKED rather than spread. `GET /meta` returns the stored meta plus `spaceId`,
   * `spaceName` and `stats`, and `SpaceMetaBody` is `.strict()` — so spreading the response would make this test
   * fail the day that endpoint grows a field, and the failure would look like the strip had broken.
   */
  async function roundTrippedMeta() {
    const { body, version } = await metaNow();
    const editable = {};
    for (const k of ['purpose', 'usageNotes', 'validationMode', 'strictLinkage', 'suppressEmbeddings']) {
      if (body[k] !== undefined) editable[k] = body[k];
    }
    return { ...editable, version, updatedAt: new Date().toISOString(), previousVersions: [] };
  }

  it('a body round-tripped from GET /meta is accepted, not 400ed', async () => {
    // The most ordinary client sequence there is: read, change one field, write back. All three of these come out
    // of our own response, and `.strict()` alone would reject them — so they are STRIPPED at the call site. That
    // strip is a behaviour with no schema behind it, which is exactly the kind an extraction leaves behind.
    const sent = await roundTrippedMeta();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: { ...sent, purpose: 'edited once' } });
    assert.ok([200, 202].includes(r.status), `round-trip rejected: ${r.status} ${JSON.stringify(r.body)}`);
    if (r.status === 200) {
      const after = await metaNow();
      assert.equal(after.body.purpose, 'edited once');
      assert.ok(after.version > sent.version, 'the server owns version: it advances, and the sent value is ignored');
    }
  });

  it('the strip covers only the three server-owned fields', async () => {
    // The narrowness IS the feature. A blanket "ignore anything unexpected inside meta" would swallow
    // `validationMdoe` as well, and the whole point of naming exactly three fields is that the fourth typo still
    // 400s. Asserted against the same round-tripped body as the test above, so the pair cannot drift apart into
    // "strict" and "permissive" halves that each look right alone.
    const sent = await roundTrippedMeta();
    const r = await patch(INSTANCES.a, token, `/api/spaces/${SPACE}`, { meta: { ...sent, validationMdoe: 'strict' } });
    assert.equal(r.status, 400, `a typo alongside the server-owned fields must still be refused: ${JSON.stringify(r.body)}`);
  });
});
