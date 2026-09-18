/**
 * Per-space text level, end to end.
 *
 * Text is the fifth and last of the analysis ladders, and the one that decides what a search can
 * actually find:
 *
 *   off    the file is stored and its content is never indexed — nothing in it is findable
 *   embed  one vector for the whole document: finds the FILE
 *   chunk  a vector per section: finds the PASSAGE, which is what makes a recall quotable
 *   auto   as much as possible, i.e. chunk
 *
 * `embed` is a real trade rather than a degraded `chunk`: one vector per document costs a fraction of
 * the storage and index time, and on short notes it loses almost nothing. It matters on long
 * documents, where an averaged vector still answers "which file mentions this?" but no longer answers
 * "where does it say that?".
 *
 * Run: node --test testing/integration/text-level.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, patch, get, delWithBody, readCollection } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const RUN = Date.now();
let token;

// Several headed sections, each comfortably past the section chunker's minimum body length —
// short sections get merged into their neighbours, which would make `chunk` and `embed`
// indistinguishable and the comparison below meaningless.
const body = (topic) =>
  `This section concerns ${topic}. `.repeat(12) +
  `It exists to give the chunker enough material that ${topic} is kept as its own passage ` +
  `rather than being folded into an adjacent section for being too short to stand alone.`;

const DOC = [
  '# Alpha', '', body('alpha'), '',
  '# Beta', '', body('beta'), '',
  '# Gamma', '', body('gamma'), '',
].join('\n');

const b64 = (s) => Buffer.from(s).toString('base64');

async function makeSpace(id, textAnalysis) {
  const created = await post(INSTANCES.a, token, '/api/spaces', { id, label: id });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  if (textAnalysis) {
    const set = await patch(INSTANCES.a, token, `/api/spaces/${id}`, { textAnalysis });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  return id;
}

const upload = (space, name, content) =>
  post(INSTANCES.a, token, `/api/files/${space}?path=${encodeURIComponent(name)}`, {
    content: b64(content), encoding: 'base64',
  });

/** Poll until the file leaves `pending`, then report its final state.
 *  The metadata endpoint returns a LIST (`{ files: [...] }`) even when filtered to one path. */
async function settle(space, name) {
  let last;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const r = await readCollection(INSTANCES.a, token, space, 'files', { path: name });
    last = (r.results ?? [])[0];
    const status = last?.embeddingStatus;
    if (status && status !== 'pending' && status !== 'processing') return last;
  }
  throw new Error(`file ${space}/${name} never settled (last seen: ${JSON.stringify(last ?? null)})`);
}

const created = [];

describe('per-space text level', () => {
  before(() => { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); });
  after(async () => {
    for (const id of created) {
      await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    }
  });

  it('the level round-trips, shows on the spaces list, and clears with null', async () => {
    const id = await makeSpace(`text-rt-${RUN}`, 'embed');
    created.push(id);

    const list = await get(INSTANCES.a, token, '/api/spaces');
    const space = (list.body?.spaces ?? []).find(s => s.id === id);
    assert.equal(space?.textAnalysis, 'embed', 'the level must be visible to the UI');

    const cleared = await patch(INSTANCES.a, token, `/api/spaces/${id}`, { textAnalysis: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body?.space?.textAnalysis, undefined, 'null clears the override');
  });

  it('an unknown level is refused', async () => {
    const id = await makeSpace(`text-bad-${RUN}`);
    created.push(id);
    const r = await patch(INSTANCES.a, token, `/api/spaces/${id}`, { textAnalysis: 'summarise' });
    assert.equal(r.status, 400, `expected a validation error, got ${r.status}`);
  });

  it('chunk splits the document into several passages', async () => {
    const id = await makeSpace(`text-chunk-${RUN}`, 'chunk');
    created.push(id);
    await upload(id, 'doc.md', DOC);
    const meta = await settle(id, 'doc.md');
    assert.ok(meta.chunkCount > 1, `expected several chunks, got ${meta.chunkCount}`);
  });

  it('embed keeps the document whole — one unit, not zero', async () => {
    // The distinction that matters: `embed` must still index the file. If it produced no units it
    // would be indistinguishable from `off`, and a space set to `embed` would silently lose search.
    const id = await makeSpace(`text-embed-${RUN}`, 'embed');
    created.push(id);
    await upload(id, 'doc.md', DOC);
    const meta = await settle(id, 'doc.md');
    assert.equal(meta.chunkCount, 1, `expected exactly one unit, got ${meta.chunkCount}`);
  });

  it('off indexes nothing, and the file still reaches a terminal state', async () => {
    const id = await makeSpace(`text-off-${RUN}`, 'off');
    created.push(id);
    await upload(id, 'doc.md', DOC);
    const meta = await settle(id, 'doc.md');
    assert.equal(meta.chunkCount ?? 0, 0, 'nothing may be indexed');
    assert.notEqual(meta.embeddingStatus, 'pending', 'it must not sit pending forever');
  });

  it('the file itself is still stored and readable when text is off', async () => {
    // `off` is about indexing, not storage. Losing the file would be a different feature.
    const id = `text-off-${RUN}`;
    const r = await get(INSTANCES.a, token, `/api/files/${id}?path=${encodeURIComponent('doc.md')}`);
    assert.equal(r.status, 200, 'the file must still be retrievable');
  });
});
