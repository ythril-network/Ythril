/**
 * A deleted file's sidecar comes back to NONE of the peers that held it, down a chain A - B - C (bundle-71, Q-349).
 *
 * ## The defect
 *
 * A converts an `.html` upload in-process: it writes `_converted/<f>.md` and derived rows for it. Derived rows never
 * replicate, but the sidecar's BYTES do, as an ordinary file: B pulls them from A and keeps a top-level row for them
 * (seq 0, authored by the peer whose bytes landed first), and C does the same from B. When A deletes `<f>`, its tombstone names
 * `<f>` only. B and C remove the sidecar's bytes with the file (`removeFileHere`) but not the row that arrived with them, and any
 * instance that still holds the sidecar bytes re-advertises them while nothing refuses them: the deleted file's text outlives it.
 *
 * ## The rule
 *
 * A file's deletion takes its sidecars with it on EVERY instance: after A deletes `<f>` and the three instances have synced
 * until nothing more moves, none of A, B or C holds `<f>`, its `_converted/` Markdown, or a row for either — and they still do not
 * after more rounds. "Not yet" is told from "never" by a sentinel written on A AFTER the delete: once it has reached C, every
 * round that could have carried a sidecar back has run.
 *
 * ## Which file type
 *
 * `.html`: its converter (jsdom + Readability + Turndown) runs in the server process, so the stack needs no document sidecar
 * service (`testing/integration/file-conversion.test.js` relies on the same, "HTML ... in-process, no sidecar").
 *
 * ## Shape
 *
 * Two mirrored closed networks sharing B (`mirroredNetwork` with `containers`): A-B and B-C. C never talks to A, so what C
 * holds of the sidecar came from B, and what it must lose it loses through B.
 *
 * Run: node --test --test-concurrency=1 testing/sync/a-deleted-files-sidecar-reaches-no-peer.test.js
 * Pre-requisite: the test stack up (`npm run test:up`), with the c instance set up.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, reqJson, createTestSpace, mirroredNetwork, waitFor } from './helpers.js';
import { spaceFootprint } from '../_shared/space-footprint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const FILE = `sidecar-chain-${RUN}.html`;
const CONVERTED = `_converted/${FILE}.md`;
const SENTINEL = `sentinel-${RUN}.txt`;
const HTML = `<!DOCTYPE html><html><head><title>Test Article</title></head><body>
  <article>
    <h1>Article Title</h1>
    <p>This is a test article paragraph with enough text to be meaningful content for embedding.</p>
    <h2>Second Section</h2>
    <p>This section has additional content that will appear as a second chunk in the pipeline.</p>
  </article>
</body></html>`;

const read = (x) => fs.readFileSync(path.join(CONFIGS, x, 'token.txt'), 'utf8').trim();
let tA, tB, tC, space, netAB, netBC;
const WHO = () => ({ a: [INSTANCES.a, tA, 'a'], b: [INSTANCES.b, tB, 'b'], c: [INSTANCES.c, tC, 'c'] });

async function upload(base, token, p, body) {
  const r = await fetch(`${base}/api/files/${space.id}?path=${encodeURIComponent(p)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
/** Whether `p`'s BYTES are served by that instance (the download route reads the disk, whatever the rows say). */
async function hasBytes(base, token, p) {
  const r = await fetch(`${base}/api/files/${space.id}?path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.status === 200;
}
/** The rows the instance's own store holds for the space, read out of its Mongo (the listing hides derived trees). */
const rowIds = (x) => spaceFootprint(x, space.id).fileIds;
/** The file's own row, its chunks and its sidecars' rows: every id that names the file. */
const mine = (ids) => ids.filter(id => id.includes(FILE));

/** One round of every network, from both ends of each, each waited for. */
async function round() {
  for (const [base, token, net] of [[INSTANCES.a, tA, netAB], [INSTANCES.b, tB, netAB], [INSTANCES.b, tB, netBC], [INSTANCES.c, tC, netBC]]) {
    await post(base, token, `/api/networks/${net.networkId}/sync?wait=true`, {});
  }
}
/** Round until `condition` holds; the timeout says what it waited for. */
async function converge(condition, what, timeout = 120_000) {
  await waitFor(async () => { await round(); return condition(); }, timeout, 1_000, () => `still waiting for: ${what}`, { what });
}
/** Everything the three instances hold of the file, by instance and by kind. */
async function holdings() {
  const out = {};
  for (const [base, token, x] of Object.values(WHO())) {
    out[x] = { rows: mine(rowIds(x)), bytes: [] };
    for (const p of [FILE, CONVERTED]) if (await hasBytes(base, token, p)) out[x].bytes.push(p);
  }
  return out;
}

before(async () => {
  [tA, tB, tC] = ['a', 'b', 'c'].map(read);
  space = await createTestSpace('sidecar-chain', [[INSTANCES.a, tA], [INSTANCES.b, tB], [INSTANCES.c, tC]]);
  netAB = await mirroredNetwork({ label: `sidecar-ab-${RUN}`, spaces: [space.id], a: [INSTANCES.a, tA], b: [INSTANCES.b, tB] });
  netBC = await mirroredNetwork({
    label: `sidecar-bc-${RUN}`, spaces: [space.id], a: [INSTANCES.b, tB], b: [INSTANCES.c, tC], containers: ['ythril-b', 'ythril-c'],
  });
});

after(async () => {
  await netBC?.remove();
  await netAB?.remove();
  await space?.remove();
});

describe('a deleted file\'s sidecar reaches no peer of the chain', () => {
  it('the file and its converted Markdown reach B from A, and C from B (the starting state is reached)', async () => {
    const up = await upload(INSTANCES.a, tA, FILE, { content: Buffer.from(HTML).toString('base64'), encoding: 'base64', inputFormat: 'html' });
    assert.equal(up.status, 202, `upload on A: ${JSON.stringify(up.body)}`);
    // A converts in-process; the sidecar's bytes exist on A once the conversion has run.
    await waitFor(() => hasBytes(INSTANCES.a, tA, CONVERTED), 90_000, 1_000, () => `A never wrote ${CONVERTED}: the conversion did not run, so there is no sidecar to follow`,
      { what: `A's conversion of ${FILE} to write ${CONVERTED}` });
    await converge(async () => {
      const h = await holdings();
      return ['b', 'c'].every(x => h[x].bytes.includes(FILE) && h[x].bytes.includes(CONVERTED) && h[x].rows.includes(CONVERTED));
    }, `${FILE} and ${CONVERTED} (bytes and a row) on B and on C`);
    const h = await holdings();
    for (const x of ['b', 'c']) {
      assert.ok(h[x].rows.includes(CONVERTED), `${x}: no row for the arrived sidecar — the case this test is about was not reached: ${JSON.stringify(h[x])}`);
    }
  });

  it('after A deletes the file, none of A, B or C holds it or its sidecar — bytes or rows — and none gets it back', async () => {
    const del = await reqJson(INSTANCES.a, tA, `/api/files/${space.id}?path=${encodeURIComponent(FILE)}`, { method: 'DELETE' });
    assert.equal(del.status, 204, `delete on A: ${JSON.stringify(del.body)}`);

    // The deletion has reached the far end of the chain once C no longer serves the file's bytes.
    await converge(async () => !(await hasBytes(INSTANCES.c, tC, FILE)) && !(await hasBytes(INSTANCES.b, tB, FILE)),
      `the deletion of ${FILE} to reach B and C`);

    // A sentinel written AFTER the delete: once it is on C, every round that could have carried a sidecar back has run.
    const s = await upload(INSTANCES.a, tA, SENTINEL, { content: `sentinel ${RUN}`, encoding: 'utf8' });
    assert.ok([201, 202].includes(s.status), `sentinel on A: ${JSON.stringify(s.body)}`);
    await converge(async () => (await hasBytes(INSTANCES.c, tC, SENTINEL)) && (await hasBytes(INSTANCES.b, tB, SENTINEL)),
      `the sentinel ${SENTINEL} to reach B and C — without it, "no sidecar" cannot be told from "nothing synced since"`);
    // And a few rounds more, so a sidecar one end still advertised has had every chance to be pulled back.
    for (let i = 0; i < 3; i++) await round();

    assert.deepEqual(await holdings(), { a: { rows: [], bytes: [] }, b: { rows: [], bytes: [] }, c: { rows: [], bytes: [] } },
      'what each instance still holds of the deleted file: its row, its sidecar\'s row (the one arrived bytes made) or either one\'s bytes');
  });
});
