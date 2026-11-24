/**
 * The admin import (`POST /api/admin/spaces/:spaceId/import`) refuses an upload that stalls or trickles, answers it so a client still sending
 * reads the code, cools the refused caller down, and keeps every other refusal it answers (bundle-270, Q-953; tests 1, 2, 7, 8, 9, 10, 13, 16).
 *
 * ## What it holds
 *
 * The door holds the instance's one import slot from before the body is spooled until it answered, and read the body with no idle bound and no
 * rate: a sender that stopped, or sent a byte a second, kept every other import out until Node's request timeout. Now:
 *
 * - an upload silent for the idle bound is `408 space_import_upload_stalled` (test 1), one under the rate over a window is
 *   `408 space_import_upload_too_slow` (test 2); each with `Connection: close`, read whole by a client that is still sending (tests 9, 16);
 *   neither leaves a spool or an act (test 10), and an import right after, by another caller, lands;
 * - the refused caller's next import within one window is `429` with `Retry-After`; another caller's is not (test 13);
 * - a client that goes away mid-upload gets no answer, no 500 is logged, the spool is removed and the door is free (test 7);
 * - a body over the inflated ceiling, from a client still sending, is still answered `413` (test 8: the reader never destroys the request);
 * - every other refusal that comes before the body is read, and a server fault partway through reading it, closes the connection of a client
 *   still sending as the pace refusals do (F1, F2): both 415s, the 409 of a door held, the 507, a fault; the guide's table says every refusal;
 * - only a pace refusal starts the cooldown: a caller refused 413 or 400 sends again at once and is answered by the door, not 429 (F4).
 *
 * The pace is set through the knob (`setUploadPaceForTest`), windows of a few hundred milliseconds, and reset after every case.
 *
 * Run: node --test testing/standalone/the-admin-import-refuses-an-upload-that-stalls-or-trickles-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openImportDoor, exportText, fact, idsOf } from './_import-door.mjs';
import { untilRunnerIdle } from './_space-act-harness.mjs';
import { pacedSender, setPace, resetPace, retryAfterOf, answeredWithin } from './_upload-pace.mjs';

const skip = await mongoSkipReason();
const SPACE = 'importpace';
const T = { timeout: 60_000 };
/** A pace no case of the closing set meets: the sender is refused for the rule under test, never for its pace. */
const UNHURRIED = { idleMs: 60_000, windowMs: 60_000, minBytesPerSecond: 1 };

let door, other, runner, logs;

/** The import has ended: nothing standing. */
async function settled() {
  runner ??= await import('../../server/dist/spaces/space-act-runner.js');
  await untilRunnerIdle(runner, door.loader);
}

/** A good export of two facts. */
const goodBody = () => exportText({ facts: [fact('pace-1', 1), fact('pace-2', 2)] });

/** An upload to the import door by `token`: the head of an export, then `piece` every `everyMs` (null: nothing more). */
function upload(token, { everyMs = null, piece = ' '.repeat(8) } = {}) {
  return pacedSender(`${door.base}/api/admin/spaces/${SPACE}/import`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, first: '{"facts":[', piece, everyMs,
  });
}

/** An upload by `token` that keeps sending (a few bytes every 40 ms) with `headers` over a JSON upload's. */
function sending(token, headers = {}) {
  return pacedSender(`${door.base}/api/admin/spaces/${SPACE}/import`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, first: '{"facts":[', piece: ' '.repeat(8), everyMs: 40,
  });
}

/** The answer of a sender still sending: its status, `Connection: close`, and that the sender read it whole. */
async function closedAnswer(sender, status, what) {
  const answer = await answeredWithin(sender, 15_000, what);
  sender.stop();
  assert.equal(answer.reset, false, `the sender still sending never read the answer: ${answer.error}`);
  assert.equal(answer.status, status, `${what}: ${answer.status} ${answer.text.slice(0, 200)}`);
  assert.match(String(answer.headers.connection ?? ''), /close/i, 'the refused sender keeps its connection');
  return answer;
}

describe('the admin import refuses an upload that stalls or trickles (real route, real MongoDB)', { skip }, () => {
  before(async () => {
    door = await openImportDoor({ suite: 'importpace', spaces: [{ id: SPACE, label: 'Pace', folders: [] }] });
    const tokens = await import('../../server/dist/auth/tokens.js');
    other = (await tokens.createToken({ name: 'other-admin', admin: true })).plaintext;
    const log = await import('../../server/dist/util/log.js');
    logs = { lines: [], stop: log.subscribeLogLines(l => logs.lines.push(l)) };
  });
  after(async () => { resetPace(); logs?.stop(); await door?.close(); });
  afterEach(async () => { resetPace(); await settled(); await door.wipe(SPACE); logs.lines.length = 0; });

  it('a silent upload is 408 space_import_upload_stalled with Connection: close, read whole; no spool; the next import lands (tests 1, 9, 10, 16)', T, async () => {
    setPace({ idleMs: 600, windowMs: 10_000, minBytesPerSecond: 1 });
    const up = upload(door.adminKey);
    const answer = await answeredWithin(up, 15_000, 'the stalled upload to be answered (the idle bound is 600 ms here)');
    up.stop();
    assert.equal(answer.reset, false, `the stalled sender never read the answer: ${answer.error}`);
    assert.equal(answer.status, 408, `a stalled upload answered ${answer.status}: ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, 'space_import_upload_stalled');
    assert.match(String(answer.headers.connection ?? ''), /close/i, 'the stalled sender keeps its connection');
    await waitFor(() => door.spoolFiles().length === 0, 5_000, 25, undefined, { what: 'the refused upload\'s spool to be removed' });
    assert.deepEqual(door.importActs(), [], 'a refused upload registered an act');
    const next = await door.post(SPACE, goodBody(), { token: other });
    assert.equal(next.status, 200, `the import after the refusal: ${next.status} ${next.text.slice(0, 200)}`);
    await settled();
    assert.deepEqual(await idsOf(door, SPACE), ['pace-1', 'pace-2']);
  });

  it('a trickling upload is 408 space_import_upload_too_slow with Connection: close while it still sends; the next import is taken (tests 2, 9, 10, 16)', T, async () => {
    setPace({ idleMs: 5_000, windowMs: 500, minBytesPerSecond: 4_096 });
    const up = upload(door.adminKey, { everyMs: 40 });
    const answer = await answeredWithin(up, 15_000, 'the trickling upload to be answered (the window is 500 ms here)');
    up.stop();
    assert.equal(answer.reset, false, `the trickling sender never read the answer: ${answer.error}`);
    assert.equal(answer.status, 408, `a trickling upload answered ${answer.status}: ${answer.text.slice(0, 200)}`);
    assert.equal(answer.json?.code, 'space_import_upload_too_slow');
    assert.match(String(answer.headers.connection ?? ''), /close/i);
    await waitFor(() => door.spoolFiles().length === 0, 5_000, 25, undefined, { what: 'the refused upload\'s spool to be removed' });
    assert.deepEqual(door.importActs(), []);
    const next = await door.post(SPACE, goodBody(), { token: other });
    assert.equal(next.status, 200, `the import after the refusal: ${next.status} ${next.text.slice(0, 200)}`);
  });

  it('the refused caller is 429 with Retry-After for one window, another caller is not (test 13)', T, async () => {
    setPace({ idleMs: 400, windowMs: 20_000, minBytesPerSecond: 1 });
    const up = upload(door.adminKey);
    assert.equal((await answeredWithin(up, 15_000, 'the stalled upload to be answered')).status, 408);
    up.stop();
    // The same caller's next upload is answered before its body is read: a sender that never ends shows it.
    const again = upload(door.adminKey);
    const cooled = await answeredWithin(again, 15_000, 'the refused caller\'s next import to be answered');
    again.stop();
    assert.equal(cooled.status, 429, `the refused caller's next import within the window: ${cooled.status} ${cooled.text.slice(0, 200)}`);
    assert.equal(cooled.json?.code, 'space_import_upload_cooldown');
    const seconds = retryAfterOf(cooled);
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 20, `Retry-After: ${cooled.headers['retry-after']}`);
    const another = await door.post(SPACE, goodBody(), { token: other });
    assert.equal(another.status, 200, `another caller was cooled down too: ${another.status} ${another.text.slice(0, 200)}`);
  });

  it('a client that goes away mid-upload gets no answer, logs no 500, leaves no spool and frees the door (test 7)', T, async () => {
    const up = upload(door.adminKey, { everyMs: 5, piece: ' '.repeat(4_096) });
    await waitFor(() => door.spoolFiles().length === 1, 10_000, 15, undefined, { what: 'the door to begin a spool for the body being sent' });
    up.stop();
    await waitFor(() => door.spoolFiles().length === 0, 10_000, 15, undefined, { what: 'the spool of a body whose client went away to be removed' });
    const next = await door.post(SPACE, goodBody(), { token: other });
    assert.equal(next.status, 200, `the door after a client went away: ${next.status} ${next.text.slice(0, 200)}`);
    assert.deepEqual(logs.lines.filter(l => /5xx|\[ERROR\]/.test(l)), [], 'a client going away was logged as a server failure');
  });

  it('a body over the inflated ceiling from a client still sending is answered 413, read whole (test 8)', T, async () => {
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    try {
      const up = upload(door.adminKey, { everyMs: 5, piece: ' '.repeat(16 * 1024) });
      const answer = await answeredWithin(up, 15_000, 'the upload over the ceiling to be answered');
      up.stop();
      assert.equal(answer.reset, false, `the sender over the ceiling never read the answer: ${answer.error}`);
      assert.equal(answer.status, 413, `${answer.status} ${answer.text.slice(0, 200)}`);
      assert.equal(answer.json?.code, undefined, 'the ceiling\'s refusal gained a code');
    } finally { door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; }); }
    await waitFor(() => door.spoolFiles().length === 0, 5_000, 25, undefined, { what: 'the spool of a body over the ceiling to be removed' });
  });

  it('a body that is not JSON is 415 with Connection: close, read whole by a client still sending (F1)', T, async () => {
    setPace(UNHURRIED);
    await closedAnswer(sending(door.adminKey, { 'Content-Type': 'text/plain' }), 415, 'the upload of another content type to be answered');
  });

  it('an encoding no import inflates is 415 with Connection: close, read whole by a client still sending (F1)', T, async () => {
    setPace(UNHURRIED);
    await closedAnswer(sending(door.adminKey, { 'Content-Encoding': 'zstd' }), 415, 'the upload of another encoding to be answered');
  });

  it('an import while another is being received is 409 space_being_imported with Connection: close, read whole by a client still sending (F1)', T, async () => {
    setPace(UNHURRIED);
    const first = upload(door.adminKey, { everyMs: 40 });
    try {
      await waitFor(() => door.spoolFiles().length === 1, 10_000, 15, undefined, { what: 'the first upload to hold the door and begin a spool' });
      const answer = await closedAnswer(sending(other), 409, 'the second upload to be answered');
      assert.equal(answer.json?.code, 'space_being_imported');
    } finally { first.stop(); }
  });

  it('a disk without room is 507 with Connection: close, read whole by a client still sending (F1)', T, async () => {
    setPace(UNHURRIED);
    const transfer = await import('../../server/dist/api/admin-space-transfer.js');
    // A chunked body declares no length, so the reader reports less than nothing: any body is refused.
    transfer.setImportFreeSpaceForTest(() => -1);
    try { await closedAnswer(sending(door.adminKey), 507, 'the upload to a full disk to be answered'); } finally { transfer.setImportFreeSpaceForTest(null); }
  });

  it('a fault while the body is still arriving is 500 with Connection: close, read whole by a client still sending (F2)', T, async () => {
    setPace(UNHURRIED);
    const transfer = await import('../../server/dist/api/admin-space-transfer.js');
    transfer.setImportFreeSpaceForTest(() => { throw new Error('injected fault before the body is read'); });
    try { await closedAnswer(sending(door.adminKey), 500, 'the upload met by a fault to be answered'); } finally { transfer.setImportFreeSpaceForTest(null); }
  });

  it('a caller refused 413 or 400 is answered by the door at once again, not 429: only a pace refusal cools a caller down (F4)', T, async () => {
    door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 64 * 1024; });
    try {
      for (const round of [1, 2]) {
        const over = upload(door.adminKey, { everyMs: 5, piece: ' '.repeat(16 * 1024) });
        const answer = await answeredWithin(over, 15_000, `the upload over the ceiling to be answered (round ${round})`);
        over.stop();
        assert.equal(answer.status, 413, `round ${round} of the same caller over the ceiling: ${answer.status} ${answer.text.slice(0, 200)}`);
      }
    } finally { door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; }); }
    for (const round of [1, 2]) {
      const malformed = await door.post(SPACE, '[1,2');
      assert.equal(malformed.status, 400, `round ${round} of the same caller with a malformed body: ${malformed.status} ${malformed.text.slice(0, 200)}`);
    }
    await waitFor(() => door.spoolFiles().length === 0, 5_000, 25, undefined, { what: 'the spools of the refused bodies to be removed' });
  });
});
