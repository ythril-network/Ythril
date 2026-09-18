/**
 * `filter` finds a file by PATH the way the list route did — same spelling tolerance, on both doors.
 *
 * ## What this is about, and why it is not "just a predicate"
 *
 * `filter: { path: "docs/a.md" }` has always worked as a raw equality, so the gap `B-9` step 3b-i closes
 * is not the lookup. It is the NORMALISATION. `GET .../files?path=` runs the path through `toDocId` —
 * backslashes become forward slashes and a leading slash is stripped — so `/docs/a.md` and `docs\a.md`
 * both find the record that is stored as `docs/a.md`.
 *
 * Through a bare predicate they find NOTHING, and they find it silently: an empty page reads exactly like
 * "no such file". A caller reading a path off their own filesystem hits this on Windows every time.
 *
 * So deleting the route without this would remove a forgiving behaviour and replace it with an exact match
 * that looks like an answer. That is the shape `3a` already paid for once — a route does work around the
 * query, and none of it is visible in the path or the response.
 *
 * ## Why both doors, record for record
 *
 * A normalisation applied on one door and not the other is the defect this whole row is about, and it is
 * invisible from either side alone: each answers plausibly, and the difference only shows when somebody
 * asks both. The `_id` sets are compared rather than the counts — a count can match while the rows differ.
 *
 * Run: node --test testing/integration/a-file-path-is-normalised-on-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `filepath-${RUN}`;
/** Stored exactly like this. Every spelling below has to reach it. */
const STORED = `notes/${RUN}/report.md`;

let token;
let mcp;
let fileId;

/*
 * `/api/brain/filter`, not `/api/filter`. Both are real doors; the generic `/api/<tool-name>` route
 * dispatches through `callTool`, so the MCP half below already covers it, and it wraps its answer in
 * `{ok, text, data}`. This one returns the envelope directly, which keeps the comparison readable.
 */
const viaRest = async (args) => {
  const res = await fetch(`${INSTANCES.a}/api/brain/filter`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.json() };
};

const viaMcp = async (args) => {
  const r = await mcp.callTool('filter', args);
  return { isError: !!r?.isError, body: r?.structuredContent ?? {}, text: r?.content?.[0]?.text ?? '' };
};

const idsOf = (rows) => (rows ?? []).map(r => r._id).sort();

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  const created = await post(INSTANCES.a, token, '/api/spaces', { id: SPACE, label: `File path ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const up = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(STORED)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `report body ${RUN}`, encoding: 'utf8' }),
  });
  // `202` is the ordinary answer: an upload is accepted and the metadata record is written behind it.
  assert.ok([200, 201, 202].includes(up.status), `upload: ${up.status}`);

  // A second file, so "found it" cannot be "returned everything".
  const other = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(`notes/${RUN}/other.md`)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'other body', encoding: 'utf8' }),
  });
  assert.ok([200, 201, 202].includes(other.status), `second upload: ${other.status}`);

  /*
   * POLLED, because an upload answers 202 and the metadata record is written behind it. A single read
   * here would race the writer and fail as though the feature were broken — and the raw `filter: {path}`
   * predicate used for the seed is deliberately the one that already works, so this waits for the RECORD
   * rather than for the capability under test.
   */
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !fileId) {
    const seed = await viaRest({ space: SPACE, collection: 'files', filter: { path: STORED }, limit: 5 });
    assert.equal(seed.status, 200, JSON.stringify(seed.body));
    fileId = seed.body.results?.[0]?._id;
    if (!fileId) await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(fileId, 'the fixture file metadata never appeared');
});

after(async () => {
  await mcp?.close?.();
  const r = await delWithBody(INSTANCES.a, token, `/api/spaces/${SPACE}`, { confirm: true })
    .catch(err => ({ status: 0, body: String(err) }));
  if (![200, 204].includes(r.status)) {
    console.error(`cleanup: space '${SPACE}' was not deleted (${r.status})`, JSON.stringify(r.body));
  }
});

describe('a file path is normalised the same way on both doors', () => {
  /** Every spelling a caller plausibly holds, and the one the record is stored under. */
  const SPELLINGS = [
    ['exact', STORED],
    ['a leading slash', `/${STORED}`],
    ['backslashes, as Windows hands them over', STORED.replace(/\//g, '\\')],
    ['both at once', `\\${STORED.replace(/\//g, '\\')}`],
  ];

  for (const [label, spelling] of SPELLINGS) {
    it(`finds the file by ${label}, on REST and on MCP`, async () => {
      const rest = await viaRest({ space: SPACE, collection: 'files', path: spelling, limit: 5 });
      assert.equal(rest.status, 200, JSON.stringify(rest.body));
      assert.deepEqual(idsOf(rest.body.results), [fileId],
        `REST did not resolve ${JSON.stringify(spelling)} to the stored path`);

      const mcpR = await viaMcp({ space: SPACE, collection: 'files', path: spelling, limit: 5 });
      assert.equal(mcpR.isError, false, mcpR.text);
      assert.deepEqual(idsOf(mcpR.body.results), [fileId],
        `MCP did not resolve ${JSON.stringify(spelling)} to the stored path`);
    });
  }

  it('a path that matches nothing returns NOTHING, not everything', async () => {
    // The direction that hides a mistake: a normalisation bug that produced an empty predicate would make
    // every case above pass on a space with one file and return the whole collection here.
    const rest = await viaRest({ space: SPACE, collection: 'files', path: 'notes/nope.md', limit: 5 });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(rest.body.results, []);

    const mcpR = await viaMcp({ space: SPACE, collection: 'files', path: 'notes/nope.md', limit: 5 });
    assert.equal(mcpR.isError, false, mcpR.text);
    assert.deepEqual(mcpR.body.results ?? [], []);
  });

  it('it COMPOSES with a filter rather than replacing it', async () => {
    // `Object.assign` over the caller's predicate is this repo's silent-widening defect. A predicate that
    // cannot match, plus a path that can, must answer nothing — if it answers the file, the path won.
    const impossible = { description: '__no-such-description__' };
    const rest = await viaRest({ space: SPACE, collection: 'files', path: STORED, filter: impossible, limit: 5 });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    assert.deepEqual(rest.body.results, [], 'the caller predicate was dropped');

    const mcpR = await viaMcp({ space: SPACE, collection: 'files', path: STORED, filter: impossible, limit: 5 });
    assert.equal(mcpR.isError, false, mcpR.text);
    assert.deepEqual(mcpR.body.results ?? [], [], 'the caller predicate was dropped on MCP');
  });

  it('sending BOTH spellings is refused rather than resolved', async () => {
    /*
     * `path` and `filter: { path }` are two spellings of one question and only the argument is
     * normalised. Letting the argument win means a caller's predicate is silently dropped; ANDing them
     * returns nothing whenever the raw spelling was the un-normalised one, which reads as "no such file"
     * for a file that is right there. Neither is an answer, so the call is refused — the same call
     * `recall` made about its two filter grammars.
     */
    const args = { space: SPACE, collection: 'files', path: STORED, filter: { path: STORED }, limit: 5 };
    const rest = await viaRest(args);
    assert.equal(rest.status, 400, JSON.stringify(rest.body));

    const mcpR = await viaMcp(args);
    assert.equal(mcpR.isError, true, 'MCP resolved a conflict REST refuses');
    assert.equal(mcpR.text.replace(/^Error: /, ''), rest.body.error,
      `the two doors refuse differently:
  REST: ${rest.body.error}
  MCP:  ${mcpR.text}`);
  });
  it('a non-files collection is REFUSED, with the same sentence on both doors', async () => {
    /*
     * Refused rather than ignored, for the reason every other argument here is: a silently dropped `path`
     * hands back the whole collection to a caller who believes they narrowed it. And the two doors say it
     * word for word, because a caller comparing them should not have to work out that two wordings mean
     * the same thing.
     */
    const rest = await viaRest({ space: SPACE, collection: 'facts', path: STORED, limit: 5 });
    assert.equal(rest.status, 400, JSON.stringify(rest.body));

    const mcpR = await viaMcp({ space: SPACE, collection: 'facts', path: STORED, limit: 5 });
    assert.equal(mcpR.isError, true, 'MCP accepted a path on facts');
    // The `Error: ` prefix is how the MCP door wraps EVERY thrown handler error, so it is the envelope
    // rather than a second wording. What has to match is the sentence inside it.
    assert.equal(mcpR.text.replace(/^Error: /, ''), rest.body.error,
      `the two doors refuse differently:\n  REST: ${rest.body.error}\n  MCP:  ${mcpR.text}`);
  });
});
