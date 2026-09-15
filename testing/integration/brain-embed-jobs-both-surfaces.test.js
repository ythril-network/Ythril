/**
 * The brain embed queue is readable and retryable over REST **and** MCP — asserted together, in one file.
 *
 * ## Why one file rather than two
 *
 * The five capabilities the canary operator reported were all REST-only for the same reason: a route shipped, a tool was
 * going to follow, and it did not — five times. B-3's verify line is therefore not "the endpoint works" but *"any new
 * endpoint exists on BOTH surfaces from the first commit"*, and the only way to test THAT is to ask the same question
 * through both doors in the same run and compare the answers. Two files, each green on its own, is exactly the shape
 * that let the gap open in the first place.
 *
 * `embed-jobs-are-visible-db.test.js` pins the state machine — the reset, the `processing` refusal, the ordering, the
 * clamp — against a real Mongo with an unreachable model. This file does not re-assert any of it. It checks the two
 * surfaces, their refusals, and the rights each one demands.
 *
 * ## The queue is expected to be EMPTY here
 *
 * The integration stack has a reachable embedder, so records embed and jobs retire. That is not a weakness: an empty
 * queue still proves the shape (counts present, `jobs` an array, both surfaces agreeing), and the situation this feature
 * exists for — a record stuck without a vector — cannot be manufactured against a working embedder without lying to the
 * server. Forcing it is the DB suite's job, where the model really is unreachable.
 *
 * Run: node --test testing/integration/brain-embed-jobs-both-surfaces.test.js
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

const SPACE = `embedjobs-${RUN}`;
const MEMBER = `embedjobs-member-${RUN}`;
const PROXY = `embedjobs-proxy-${RUN}`;

let token;
let session;
const created = [];

const RECORDS = `/api/brain/spaces/${SPACE}/embedding-queue/records`;
const listRest = (qs = '') => get(INSTANCES.a, token, `${RECORDS}${qs}`);
const retryRest = (body, space = SPACE) =>
  post(INSTANCES.a, token, `/api/brain/spaces/${space}/embedding-queue/records/retry`, body);

async function makeSpace(id, body = {}) {
  const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id, ...body });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  created.push(id);
}

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  await makeSpace(SPACE);
  await makeSpace(MEMBER);
  await makeSpace(PROXY, { proxyFor: [MEMBER] });
  const mem = await post(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/memories`, { fact: `embed queue subject ${RUN}` });
  assert.equal(mem.status, 201, JSON.stringify(mem.body));
  session = await openMcpSession(token);
});

after(async () => {
  session?.close();
  for (const id of created.reverse()) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

describe('REST: the record half of the embedding queue', () => {
  it('answers with counts and a jobs array', async () => {
    const r = await listRest();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.counts).sort(), ['failed', 'pending', 'processing'],
      'all three counters are always present — a missing key is indistinguishable from zero to a caller that reads it');
    for (const k of ['pending', 'processing', 'failed']) {
      assert.equal(typeof r.body.counts[k], 'number', `${k} must be a number`);
    }
    assert.ok(Array.isArray(r.body.jobs), 'jobs is an array even when the queue is empty');
  });

  it('accepts a status filter and echoes which one it applied', async () => {
    const r = await listRest('?status=failed');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'failed',
      'the applied filter is echoed, so a caller can tell "no failures" from "my filter was ignored"');
    assert.ok(r.body.jobs.every(j => j.status === 'failed'));
  });

  it('REFUSES an unknown status instead of ignoring it', async () => {
    // The `skip` defect the fleet integrator reported on POST /query, and the memory `type` defect on PATCH, were both this shape:
    // a permissive body, a success status, and a silently dropped field. A caller who mistypes `failed` must not be
    // told the queue is fine.
    const r = await listRest('?status=broken');
    assert.equal(r.status, 400, `an unknown status was accepted: ${JSON.stringify(r.body)}`);
  });

  it('refuses a non-positive or non-numeric limit', async () => {
    for (const bad of ['0', '-5', 'lots', '2.5']) {
      const r = await listRest(`?limit=${bad}`);
      assert.equal(r.status, 400, `limit=${bad} was accepted: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await listRest('?limit=5')).status, 200, 'and a good one still works');
  });

  it('404s for a space that does not exist', async () => {
    const r = await get(INSTANCES.a, token, `/api/brain/spaces/no-such-space-${RUN}/embedding-queue/records`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('does not collide with the MEDIA queue endpoint it nests under', async () => {
    // `/embedding-queue/media` and `/embedding-queue/records` are different answers about different halves of the same
    // subsystem. If the nested path ever shadowed its parent, the F9 Overview panel would silently start reading brain
    // counts as media counts — the two shapes are similar enough that nothing would throw.
    const media = await get(INSTANCES.a, token, `/api/brain/spaces/${SPACE}/embedding-queue/media`);
    assert.equal(media.status, 200, JSON.stringify(media.body));
    assert.ok('complete' in media.body, 'the media summary has a `complete` counter; the record listing does not');
    assert.ok(!('jobs' in media.body), 'and it does not carry a jobs array');
    assert.ok(!('counts' in (await listRest()).body.jobs), 'sanity: the record listing is the nested shape');
  });
});

describe('REST: the retry refuses what it cannot act on', () => {
  it('rejects an unknown recordType', async () => {
    const r = await retryRest({ recordType: 'sandwich', recordId: 'abc' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /recordType/);
  });

  it('rejects a missing or blank recordId', async () => {
    assert.equal((await retryRest({ recordType: 'memory' })).status, 400);
    assert.equal((await retryRest({ recordType: 'memory', recordId: '   ' })).status, 400);
  });

  it('404s for a record with no job, and says which space it looked in', async () => {
    const r = await retryRest({ recordType: 'memory', recordId: `no-such-${RUN}` });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.result, 'not_found', 'the outcome is machine-readable, not only prose');
    assert.match(r.body.error, new RegExp(SPACE), 'the space is named — a proxy retry can land in a member space');
  });

  it('refuses a PROXY space without a target, and names the members', async () => {
    // A proxy space stores nothing of its own, so "retry this record here" has no meaning until a member is named.
    const r = await retryRest({ recordType: 'memory', recordId: 'anything' }, PROXY);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(MEMBER), 'the refusal must say which member to retry in');
  });

  it('accepts a proxy retry that names the member', async () => {
    const r = await retryRest({ recordType: 'memory', recordId: `no-such-${RUN}`, targetSpace: MEMBER }, PROXY);
    // 404 because that record has no job — the point is that it got PAST the proxy check and looked in the member.
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, new RegExp(MEMBER), 'it looked in the member space, not in the proxy');
  });
});

describe('MCP: the same two capabilities, through the other door', () => {
  it('offers BOTH tools — the whole point of shipping them together', async () => {
    const names = (await session.listTools()).map(t => t.name);
    assert.ok(names.includes('list_embed_jobs'), `list_embed_jobs not offered: ${names.join(', ')}`);
    assert.ok(names.includes('retry_embed_record'), `retry_record_embedding not offered: ${names.join(', ')}`);
  });

  it('list_embed_jobs reports the same counts REST does', async () => {
    // Both surfaces call `getEmbedJobCounts`/`listEmbedJobs`. Asserting they AGREE is what makes that a fact rather
    // than an intention: a second copy of the query would drift, and this is where it would show.
    const rest = await listRest();
    const mcp = await session.callTool('list_embed_jobs', { space: SPACE });
    assert.ok(!mcp?.isError, `refused: ${JSON.stringify(mcp)}`);
    assert.deepEqual(mcp.structuredContent.counts, rest.body.counts,
      'the two surfaces must answer the same question with the same numbers');
    assert.match(mcp.content[0].text, /pending/i, 'and a human-readable line, because a model reads the text');
  });

  it('list_embed_jobs honours the status filter', async () => {
    const r = await session.callTool('list_embed_jobs', { space: SPACE, status: 'failed' });
    assert.ok(!r?.isError, JSON.stringify(r));
    assert.equal(r.structuredContent.status, 'failed');
    assert.ok(r.structuredContent.jobs.every(j => j.status === 'failed'));
  });

  it('retry_record_embedding reports not_found verbatim rather than as an error', async () => {
    // `not_found` is an ANSWER: the record has no job, which usually means it embedded fine. Reporting it as a tool
    // error would make an agent retry or escalate over the queue being healthy.
    const r = await session.callTool('retry_embed_record', {
      space: SPACE, recordType: 'memory', recordId: `no-such-${RUN}`,
    });
    assert.ok(!r?.isError, `a not_found outcome must not be a tool error: ${JSON.stringify(r)}`);
    assert.equal(r.structuredContent.result, 'not_found');
  });

  it('retry_record_embedding rejects an unknown recordType', async () => {
    const r = await session.callTool('retry_embed_record', {
      space: SPACE, recordType: 'sandwich', recordId: 'abc',
    });
    assert.ok(r?.isError, `an unknown recordType was accepted: ${JSON.stringify(r)}`);
  });

  it('refuses a proxy retry with no target, with the same message REST gives', async () => {
    const mcp = await session.callTool('retry_embed_record', {
      space: PROXY, recordType: 'memory', recordId: 'anything',
    });
    assert.ok(mcp?.isError, JSON.stringify(mcp));
    const text = JSON.stringify(mcp);
    assert.ok(text.includes(MEMBER), 'both surfaces route through resolveWriteTarget, so both name the members');
  });
});

describe('rights: reading the queue is knowledge:read, retrying is knowledge:write', () => {
  let readerToken;
  let writerToken;

  before(async () => {
    // Scoped to this space only, so a leak shows up as a 403 rather than as a pass on the admin token's reach.
    // The rights matrix is `.strict()` and every field is required, so a partial object is a 400 rather than a
    // defaulted token — which is the safe direction, and worth knowing before writing a test that assumes otherwise.
    const NONE = { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none' };
    const mk = async (name, knowledge) => {
      const rights = {
        instanceAdmin: false,
        createSpaces: false,
        // An empty floor, deliberately: `floor` is instance-wide in effect, so any rung here would grant the same
        // access in every space and the per-space assertions below would pass for the wrong reason.
        floor: { ...NONE },
        perSpace: { [SPACE]: { ...NONE, knowledge } },
      };
      // `rights` ALONE — the API refuses `rights` together with the legacy `spaces`/`admin`/`readOnly` fields rather
      // than silently preferring one, so the allowlist here IS the `perSpace` key set.
      const r = await post(INSTANCES.a, token, '/api/tokens', { name: `${name}-${RUN}`, rights });
      assert.equal(r.status, 201, `token create failed: ${JSON.stringify(r.body)}`);
      // `token` is the RECORD; `plaintext` is the secret, returned only here and never again.
      return r.body.plaintext;
    };
    readerToken = await mk('embedjobs-reader', 'read');
    writerToken = await mk('embedjobs-writer', 'write');
  });

  it('a knowledge:read token can LIST', async () => {
    // Deliberate: an operator who cannot fix the queue still has every reason to see it. Hiding the diagnosis behind
    // write rights is how a stalled queue becomes a mystery.
    const r = await get(INSTANCES.a, readerToken, RECORDS);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('a knowledge:read token can NOT retry', async () => {
    const r = await post(INSTANCES.a, readerToken, `${RECORDS}/retry`, { recordType: 'memory', recordId: 'x' });
    assert.equal(r.status, 403, `a read token performed a write: ${JSON.stringify(r.body)}`);
  });

  it('a knowledge:write token CAN retry', async () => {
    const r = await post(INSTANCES.a, writerToken, `${RECORDS}/retry`, { recordType: 'memory', recordId: `no-such-${RUN}` });
    assert.equal(r.status, 404, `expected to reach the queue and find no job, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('neither token reaches another space', async () => {
    const r = await get(INSTANCES.a, readerToken, `/api/brain/spaces/${MEMBER}/embedding-queue/records`);
    assert.ok(r.status === 403 || r.status === 404, `a scoped token read another space's queue: ${r.status}`);
  });
});

describe('the listing pages, and echoes what it applied', () => {
  // The queue is empty on this stack (the embedder works), so what HTTP can prove here is the CONTRACT: the parameters are
  // accepted, refused correctly, and echoed. The tiling across the 200-row cap is asserted in
  // `embed-jobs-are-visible-db.test.js`, where jobs can be made to fail — that is the only place a 250-job backlog exists.
  it('echoes limit and skip', async () => {
    const r = await listRest('?limit=5&skip=10');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.limit, 5);
    assert.equal(r.body.skip, 10);
  });

  it('defaults skip to 0 and reports it', async () => {
    const r = await listRest();
    assert.equal(r.body.skip, 0, 'a caller must be able to tell where the page started without guessing');
  });

  it('refuses a negative or fractional skip rather than reading it as 0', async () => {
    for (const bad of ['-1', '2.5', 'lots']) {
      assert.equal((await listRest(`?skip=${bad}`)).status, 400, `skip=${bad} was accepted`);
    }
  });

  it('a skip past the end is an empty page, not the last one', async () => {
    const r = await listRest('?skip=100000');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.jobs, []);
    assert.ok(r.body.counts, 'and the counts still come back, so the caller knows whether there was anything at all');
  });
});
