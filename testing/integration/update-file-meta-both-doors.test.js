/**
 * A file's metadata can be changed from MCP without resending the file.
 *
 * ## Why the tool exists
 *
 * `write_file` accepts `description`, `tags` and `properties` — but only alongside `content`. The metadata-only
 * edit was `PATCH /api/brain/spaces/:spaceId/files`, which had no tool, so correcting a tag on a 40 MB PDF meant
 * re-uploading it, and correcting one on a file whose bytes the caller does not have was impossible.
 *
 * Every knowledge type has an `update_*` tool for exactly this reason. Files were the one that did not.
 * Found by `scripts/surface-matrix.mjs`. Filed as B-23.
 *
 * ## What these assertions defend
 *
 * The point is not that a 200 comes back. It is that the bytes are NOT touched — that is the whole feature — and
 * that a field the caller omitted survives, because a patch that silently clears what it was not asked about is
 * the failure mode a metadata editor has.
 *
 * Run: node --test testing/integration/update-file-meta-both-doors.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, readCollection } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `file-meta-${RUN}`;
const FILE = `notes/report-${RUN}.md`;
const BODY = `# Report ${RUN}\n\nThe original bytes, which must survive a metadata edit.\n`;

let tokenA;
const token = () => tokenA;

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const created = await post(INSTANCES.a, token(), '/api/spaces', { id: SPACE, label: `File meta ${RUN}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const up = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: BODY, encoding: 'utf8' }),
  });
  assert.ok(up.ok, `uploading the fixture file: ${up.status} ${await up.text()}`);

  // A description and a tag to start from, so "the field you did not pass survives" has something to survive.
  const seeded = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent(FILE)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'the original description', tags: ['keep-me'] }),
  });
  assert.ok(seeded.ok, `seeding metadata: ${seeded.status} ${await seeded.text()}`);
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

const readFileBytes = async () => {
  const r = await fetch(`${INSTANCES.a}/api/files/${SPACE}?path=${encodeURIComponent(FILE)}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  assert.ok(r.ok, `reading the file back: ${r.status}`);
  return r.text();
};

describe('update_file_meta edits metadata and leaves the bytes alone', () => {
  it('the MCP tool changes tags without touching the content', async (t) => {
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('update_file_meta', {
        space: SPACE, path: FILE, tags: ['edited-by-mcp'],
      });
      const text = JSON.stringify(res ?? {});
      assert.doesNotMatch(text, /Unknown tool/i, 'the tool is missing — rebuild the test image');
      assert.doesNotMatch(text, /isError|error/i, `the call must succeed: ${text.slice(0, 250)}`);

      // The bytes: the whole reason this tool exists.
      assert.equal(await readFileBytes(), BODY, 'a metadata edit must not rewrite the file');

      // And the field nobody mentioned survives.
      const meta = await readCollection(INSTANCES.a, token(), SPACE, 'files', { path: FILE });
      assert.equal(meta.status, 200, JSON.stringify(meta.body));
      // One shape now. The two-shape read was for the list route's `{files}` beside a single-record
      // answer, and `filter` has neither: it is always a page, and an empty one is a real outcome.
      const [record] = meta.results;
      assert.ok(record, `no metadata record came back: ${JSON.stringify(meta.body)}`);
      assert.deepEqual(record.tags, ['edited-by-mcp'], `tags must be replaced: ${JSON.stringify(record)}`);
      assert.equal(record.description, 'the original description',
        'a field the patch did not mention must survive — silently clearing it is the failure mode here');
    } finally {
      session?.close();
    }
  });

  it('an unknown path is refused rather than silently creating a record', async (t) => {
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('update_file_meta', {
        space: SPACE, path: `no/such/file-${RUN}.md`, tags: ['x'],
      });
      const text = JSON.stringify(res ?? {});
      assert.match(text, /No file metadata record/i,
        `patching a path with no record must fail: ${text.slice(0, 250)}`);
    } finally {
      session?.close();
    }
  });

  it('REST and MCP agree on the record they return', async (t) => {
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const viaMcp = await session.callTool('update_file_meta', {
        space: SPACE, path: FILE, description: 'set through MCP',
      });
      const mcpRecord = viaMcp?.structuredContent;
      const viaRest = await fetch(`${INSTANCES.a}/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent(FILE)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'set through MCP' }),
      });
      assert.ok(viaRest.ok, `REST patch: ${viaRest.status}`);
      const restRecord = await viaRest.json();

      // Same fields, same values, from one implementation. `updatedAt` moves between the two calls, so it is
      // compared by presence rather than by value — comparing it would fail for the one reason that is fine.
      for (const k of ['path', 'description', 'tags', 'spaceId']) {
        assert.deepEqual(mcpRecord?.[k], restRecord[k], `${k} differs between the doors`);
      }
      assert.ok(mcpRecord?.['updatedAt'] && restRecord.updatedAt, 'both must stamp updatedAt');
    } finally {
      session?.close();
    }
  });
});
