/**
 * The audit log names who a refused call was and counts what it holds (bundle-270, Q-754, fix round D1 and D2).
 *
 * ## What it holds
 *
 * - A call a guard refuses (the rights guard's 403 for a rung the token lacks, its 403 for a space the token does not reach) leaves a row that
 *   names the token that was refused, as a call refused later does (D1). The guards refuse before they attach the token to the request, and the
 *   audit middleware read only the attached one, so every such row said nobody called: an operator could not tell which credential kept
 *   being turned away. A credential that did not resolve names nobody, as before.
 * - The audit read's `total` never disagrees with the entries it answers (D2): the total was cached for 30 seconds per filter, so rows written
 *   after one read were in the entries of the next and not in its total (7 entries, `total: 5`, `hasMore: false`). A row that lands clears
 *   the cached totals.
 *
 * Run: node --test testing/standalone/the-audit-log-names-the-token-of-a-refused-call-and-counts-its-rows-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { untilAuditWritesLanded } from './_audit-rows.mjs';
import { openSchemaRdfImportDoors, spaceWith } from './_schema-rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const OP = 'schema.rdf.import';
const REACHED = 'auditrefreach';
const ELSEWHERE = 'auditrefelse';
const COUNTED = 'auditrefcount';

describe('the audit log names the token of a refused call and counts its rows (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, admin, reader, other;
  before(async () => {
    d = await openSchemaRdfImportDoors({
      suite: 'audit_refused_token',
      spaces: [spaceWith(REACHED, undefined), spaceWith(ELSEWHERE, undefined), spaceWith(COUNTED, undefined)],
    });
    admin = await d.mint('audit-refused-admin', {}, { admin: true });
    reader = await d.mint('audit-refused-reader', { [REACHED]: d.row({ knowledge: 'write', schema: 'read' }) });
    other = await d.mint('audit-refused-other', { [ELSEWHERE]: d.row({ knowledge: 'write', schema: 'admin' }) });
  });
  after(async () => { await d?.close(); });

  const rowsOf = async (filter) => {
    await untilAuditWritesLanded();
    return d.col('audit_log').find(filter).sort({ timestamp: 1 }).toArray();
  };
  const post = (key, space, query) => fetch(`${d.server.url}/api/spaces/${space}/schema-rdf${query}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'text/turtle' }, body: ' \n', signal: AbortSignal.timeout(60_000),
  });
  const put = (key, space) => fetch(`${d.server.url}/api/spaces/${space}/schema`, {
    method: 'PUT', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ typeSchemas: {} }), signal: AbortSignal.timeout(60_000),
  });

  it('a call the rights guard refuses for a rung is audited with the token, on two operations', async () => {
    const dry = await post(reader.key, REACHED, '?mode=expand&dryRun=true');
    assert.equal(dry.status, 403, 'the schema: read token was not refused');
    const written = await put(reader.key, REACHED);
    assert.equal(written.status, 403, 'the schema: read token was not refused');
    const rows = await rowsOf({ spaceId: REACHED, status: 403 });
    assert.equal(rows.length, 2, `${rows.length} refusal rows: ${JSON.stringify(rows.map(r => [r.method, r.path]))}`);
    for (const row of rows) {
      assert.equal(row.tokenId, reader.id, `${row.method} ${row.path}: the refusal row names ${row.tokenId}, not the token refused`);
      assert.equal(row.tokenLabel, 'audit-refused-reader', `${row.method} ${row.path}: the row names no label`);
      assert.equal(row.authMethod, 'pat', `${row.method} ${row.path}: the row names no method`);
    }
  });

  it('a call refused for a space the token does not reach is audited with the token', async () => {
    const seen = (await rowsOf({ spaceId: REACHED, operation: OP })).length;
    const answer = await post(other.key, REACHED, '?mode=expand&dryRun=true');
    assert.ok(answer.status === 403 || answer.status === 404, `the token of another space was not refused: ${answer.status}`);
    const rows = (await rowsOf({ spaceId: REACHED, operation: OP })).slice(seen);
    assert.equal(rows.length, 1, `${rows.length} new rows: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].status, answer.status);
    assert.equal(rows[0].tokenId, other.id, `the refusal row names ${rows[0].tokenId}, not the token refused`);
  });

  it('a credential that does not resolve is audited naming nobody', async () => {
    const answer = await post('not-a-token-at-all', ELSEWHERE, '?mode=expand');
    assert.equal(answer.status, 401);
    const rows = await rowsOf({ operation: 'auth.failed' });
    assert.ok(rows.length >= 1, 'the failed credential left no row');
    assert.ok(rows.every(r => r.tokenId === null), 'a credential that resolved to nothing was given a name');
  });

  it('the audit read answers a total that agrees with its entries after new rows landed', async () => {
    const read = async () => {
      const r = await fetch(`${d.server.url}/api/admin/audit-log?operation=${OP}&spaceId=${COUNTED}&limit=1000`, { headers: { Authorization: `Bearer ${admin.key}` } });
      assert.equal(r.status, 200);
      return r.json();
    };
    await untilAuditWritesLanded();
    const first = await read();
    assert.equal(first.entries.length, 0, 'the space had rows before the test wrote any');
    for (let i = 0; i < 2; i++) assert.equal((await post(admin.key, COUNTED, '?mode=expand&dryRun=true')).status, 200);
    await untilAuditWritesLanded();
    const second = await read();
    assert.equal(second.entries.length, 2, `the entries: ${JSON.stringify(second.entries.map(e => e.status))}`);
    assert.equal(second.total, second.entries.length, `${second.entries.length} entries with total ${second.total}`);
    assert.equal(second.hasMore, false);
  });
});
