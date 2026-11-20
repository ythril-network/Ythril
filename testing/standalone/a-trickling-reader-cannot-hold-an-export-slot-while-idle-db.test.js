/**
 * A reader that takes nothing frees its export slot and is cut, and a cut or a refusal leaves one log line naming the space and the rule and
 * no record (bundle-269 review, finding 9; the second drive, finding A; lens finding 8).
 *
 * One reader takes nothing for the first window (what the buffers took at the start is not what it took), one takes nothing at all, one is
 * judged too slow while the log is read, and one is refused for want of a slot on both doors. Over a real loopback socket at production's
 * numbers scaled together; the drives, the scaling and why a slow reader is released once the server has closed its side are in
 * `_rdf-trickle-readers.mjs`. The rate rows and the gzip rows are the two other files of the rule
 * (`a-trickling-reader-cases-are-held-once-across-their-files` holds that each case is in exactly one).
 *
 * Run: node --test testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-while-idle-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { elapse } from '../_shared/sleep.mjs';
import { openTrickle, readAt, SPACE } from './_rdf-trickle-readers.mjs';

const skip = await mongoSkipReason();
const log = await import('../../server/dist/util/log.js');

describe('a trickling reader cannot hold an export slot, while idle', { skip, timeout: 600_000 }, () => {
  let t;
  before(async () => { t = await openTrickle('rdf_export_trickle_idle'); });
  after(async () => { await t?.close(); });

  it('a reader that takes nothing for the first window is judged by what it took, not by what the buffers took, and is told', async () => {
    const r = readAt(t.url, t.tok.key, { bytesPerSecond: Infinity, holdMs: t.verdictWithin() });
    await r.headed;
    await waitFor(t.slotFree, t.verdictWithin(), 100, () => 'a reader that took nothing still holds its slot: the buffers\' fill was counted as taken');
    await t.assertToldTooSlow(await r.done);
  });

  // Lens finding 8. A slow or idle cut and a refusal for want of a slot left only the audit row: an operator reading the log saw nothing
  // of a reader that kept being cut or of a caller that kept being turned away. One line each, naming the space and the rule and holding
  // no record (an export streams records: a name, a value, an id must never reach the log).
  /** The log lines written while `work` runs. */
  async function linesWhile(work) {
    const lines = [];
    const off = log.subscribeLogLines(l => lines.push(l));
    try { await work(); } finally { off(); }
    return lines;
  }
  const NO_RECORD = /Big \d|xxxx|b00\d{4}/;

  it('a reader judged too slow leaves one log line naming the space and the rule, and no record', async () => {
    const lines = await linesWhile(async () => {
      const r = readAt(t.url, t.tok.key, { bytesPerSecond: t.pace.minBytesPerSecond * 0.1 });
      await r.headed;
      await waitFor(t.slotFree, t.verdictWithin(), 100, () => 'the slow reader still holds its slot');
      await t.releaseOnceServerClosed(r);
      await t.assertToldTooSlow(await r.done);
    });
    const cut = lines.filter(l => /RDF export of space .* cut/.test(l));
    assert.equal(cut.length, 1, `the cut of a slow reader left ${cut.length} log lines: ${JSON.stringify(lines.slice(-5))}`);
    assert.ok(cut[0].includes(SPACE), `the line does not name the space: ${cut[0]}`);
    assert.match(cut[0], /too slowly/);
    assert.doesNotMatch(lines.join('\n'), NO_RECORD, 'a record reached the log');
  });

  it('a refusal for want of a slot leaves one log line, whichever door was refused, and no record', async () => {
    t.act.rdfExportBusySaid?.forgetAll();
    const hold = readAt(t.url, t.tok.key, { bytesPerSecond: 0 });
    try {
      await hold.headed;
      const lines = await linesWhile(async () => {
        const rest = await t.d.exportRest(t.tok.key, SPACE, { format: 'nquads', limit: 1 });
        assert.equal(rest.status, 429, `REST answered ${rest.status}: the slot is not held`);
        const mcp = await t.d.exportMcp(t.tok.key, { space: SPACE, format: 'nquads', limit: 1 });
        assert.equal(mcp.isError, true, `MCP answered: ${mcp.text.slice(0, 200)}`);
        assert.match(mcp.text, /rdf_export_busy|429/);
      });
      const busy = lines.filter(l => /RDF export of space .* refused/.test(l));
      assert.equal(busy.length, 1, `two refused calls (one per door) left ${busy.length} log lines (said once per window): ${JSON.stringify(lines.slice(-5))}`);
      assert.ok(busy[0].includes(SPACE), `the line does not name the space: ${busy[0]}`);
      assert.match(busy[0], /slot/);
      assert.doesNotMatch(lines.join('\n'), NO_RECORD, 'a record reached the log');
    } finally {
      hold.release();
      await hold.done;
    }
  });

  it('a reader that takes nothing at all frees its slot, and its connection is cut once the ending had its time', async () => {
    const r = readAt(t.url, t.tok.key, { bytesPerSecond: 0 });
    try {
      await r.headed;
      await waitFor(t.slotFree, t.verdictWithin(), 100, () => 'a reader that takes nothing still holds its slot');
      // What it still takes after the ending's time is what its connection held when the server closed it: never a whole transfer.
      await elapse(t.endingWaitMs + 2_000, 'ttl elapses: the ending\'s wait must run out before the reader takes anything');
    } finally { r.release(); }
    const got = await r.done;
    assert.equal(got.status, 200);
    assert.equal(got.complete, false, 'the connection of a reader that took nothing was not cut');
  });
});
