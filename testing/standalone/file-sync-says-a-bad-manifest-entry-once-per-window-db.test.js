/**
 * A peer's manifest entries that leave the space are said once per window, with their count, however many cycles meet them (Q-415).
 *
 * The pull skips an entry whose path leaves the space (`../../other-space/x`) and touches nothing. It used to warn once per entry on every cycle, so a
 * manifest of fifty such entries filled the log with a hundred lines in two cycles while the operator needed one. They are now collected and said once
 * for the peer through the shared reporter (one line per window, the count in it, every occurrence counted).
 *
 *  1. Two cycles over a manifest with many escaping entries: one line that names the step and the count, and no per-entry "File sync error" line.
 *  2. The good entry of the same manifest is still fetched: a bad neighbour stops nothing.
 *
 * Seen red on the base: two cycles say one line per entry each (a hundred lines for fifty entries) and none names the step.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27117 YTHRIL_TEST_MONGO_CREDS=ythril:ythril-test-pw node --test testing/standalone/file-sync-says-a-bad-manifest-entry-once-per-window-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'badmanifest';
const ESCAPING = 50;
const MODIFIED = '2026-10-01T00:00:00.000Z';
const GOOD = 'good.txt';
const GOOD_BYTES = 'the one entry that stays in the space';
const sha = (s) => createHash('sha256').update(s).digest('hex');

let door;

describe('a manifest of entries that leave the space is said once per window', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'badmanifest', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    door.seedPeerFile(S, GOOD, GOOD_BYTES);
    const entries = Array.from({ length: ESCAPING }, (_, i) => ({ path: `../../elsewhere/escape-${i}.txt`, sha256: sha(`x${i}`), size: 3, modifiedAt: MODIFIED }));
    door.state.manifest = (_req, res) => {
      res.json({ spaceId: S, manifest: [...entries, { path: GOOD, sha256: sha(GOOD_BYTES), size: Buffer.byteLength(GOOD_BYTES), modifiedAt: MODIFIED }] });
    };
  });

  it('two cycles say one line with the count, and no line per entry', async () => {
    const { lines } = await logLinesDuring(async () => { await door.sync(); await door.sync(); });
    const outside = lines.filter(l => l.includes('File manifest entry outside the space'));
    const perEntry = lines.filter(l => l.includes('File sync error for'));
    assert.equal(outside.length, 1, `said ${outside.length} times: ${JSON.stringify(outside)}`);
    assert.match(outside[0], new RegExp(`count: ${ESCAPING}\\b`), 'the line does not carry the count');
    assert.deepEqual(perEntry, [], `${perEntry.length} per-entry lines were said`);
  });

  it('the entry inside the space is fetched in spite of its neighbours', async () => {
    await door.sync();
    assert.equal(door.localFileExists(S, GOOD), true, 'the good file was not pulled');
  });
});
