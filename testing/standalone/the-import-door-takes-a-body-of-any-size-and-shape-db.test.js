/**
 * The admin import door takes an export of any size, reads it only for a caller let in, refuses what is malformed before it writes, and
 * says what it holds (bundle-40 slice b, `Q-267`, `Q-227`; plan 2R R1 as amended by 2R3).
 *
 * ## The rules this file holds
 *
 *  1. **An export over 10 MB restores through the door** (export -> wipe -> import). The global JSON parser refuses every body above 10 MB
 *     (`app.ts:149`) and the import route sat behind it, so the backup of a large space could be exported and never restored.
 *  2. **A malformed body after a first page is answered 400, nothing is written, no act is registered, no spool is kept.** A body that is
 *     valid for a page and broken after it is the case a streaming reader can get wrong: it has already landed the first page. Seen over
 *     10 MB (red on the base: 413) and small (PIN: the base answers 400).
 *  3. **The byte ceiling counts INFLATED bytes and is `importBodyMaxBytes`; a document-count ceiling is `importMaxDocuments`:** above either, 413.
 *  4. **A caller is let in before the body is read:** an unauthenticated large body is 401 and leaves no spool file.
 *  5. **gzip, deflate and br bodies are inflated** (a body that is small compressed and over 10 MB inflated restores; a small one is a PIN:
 *     the base inflates it); **a body that is not JSON is 415** (the base answered 200 with every count zero).
 *  6. **A repeated id across a page boundary keeps the highest seq, and of equal seqs the earliest** (PIN at the door: the base lands a family in
 *     one call, so it already does; the red form is `an-export-body-is-indexed-and-paged-without-holding-its-ids.test.js`).
 *  7. **The export envelope names the instance that wrote it** (`instanceId`).
 *  8. **A disk without room answers 507, a client that goes away mid-body, and a gzip or br body that does not inflate (400), each leave no
 *     spool and no act** (bundle-40 pre-ship T5). The disk is filled through the door's free-space reader (`setImportFreeSpaceForTest`), never
 *     for real. The client and the inflate rows are PINs: they hold on 505b5790c; the 507 row is red there only for want of the seam.
 *
 * ## What is red on the base, and what is a PIN
 *
 * Rows 1, 2 (large), 3, 4, 5 (inflated size, 415) and 7 are red on 6c64a7112. The PINs say so in their titles: the rewrite must not lose them.
 *
 * ## How it is driven
 *
 * The real application on loopback (`_import-door.mjs`), the harness Mongo, `node:http` for the body. An import may answer 200 with its result or
 * 202 with the act queued (plan R1); a test that reads the stored rows waits for the act to end first (`settled`).
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/the-import-door-takes-a-body-of-any-size-and-shape-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openImportDoor, exportText, paddedFacts, fact, encoded, idsOf } from './_import-door.mjs';
import { untilRunnerIdle } from './_space-act-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'bigimport';
const T = { timeout: 180_000 };
const MB = 1024 * 1024;
/** Facts of 4 000 bytes: 3 000 of them are a body of about 12 MB, over the global parser's 10 MB. */
const PAD = 4000;
const OVER_10_MB_COUNT = 3000;

let door, runner;

/** The import has ended: nothing standing, whatever the door answered (200 inline, or 202 queued). */
async function settled() {
  runner ??= await import('../../server/dist/spaces/space-act-runner.js');
  await untilRunnerIdle(runner, door.loader);
}
const answeredOk = (r) => r.status === 200 || r.status === 202;

describe('the import door takes a body of any size and shape (real MongoDB, real route)', { skip }, () => {
  before(async () => { door = await openImportDoor({ suite: 'importdoorbody', spaces: [{ id: SPACE, label: 'Big', folders: [] }] }); });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(SPACE);
    door.loader.mutateConfig(cfg => { delete cfg.importBodyMaxBytes; delete cfg.importMaxDocuments; });
  });

  it('an export over 10 MB restores through the import door: export, wipe, import', T, async () => {
    await door.coll(SPACE, 'facts').insertMany(Array.from({ length: OVER_10_MB_COUNT }, (_, i) => {
      const f = fact(`trip-${String(i).padStart(5, '0')}`, i + 1, { padBytes: PAD });
      return { ...f, spaceId: SPACE };
    }));
    const out = await door.exportSpace(SPACE);
    assert.equal(out.status, 200, `export answered ${out.status}`);
    assert.ok(out.text.length > 10 * MB, `fixture check: the export is ${out.text.length} bytes, not over the 10 MB the global parser allows`);
    const before = await idsOf(door, SPACE);
    assert.equal(before.length, OVER_10_MB_COUNT, 'fixture check: the space did not hold what was seeded');
    await door.wipe(SPACE);
    assert.deepEqual(await idsOf(door, SPACE), [], 'fixture check: the wipe left rows');
    const res = await door.post(SPACE, out.text);
    assert.ok(answeredOk(res), `the import of a ${(out.text.length / MB).toFixed(1)} MB export answered ${res.status}: ${res.text.slice(0, 200)}`);
    await settled();
    assert.deepEqual(await idsOf(door, SPACE), before, 'the space the large export restored is not the space it was exported from');
  });

  describe('a malformed body after a first page is refused 400 with nothing written, no act and no spool', () => {
    const FIRST_PAGE = 600; // more than one page of 500
    const cases = {
      'a later family that is not an array': () => ({ tail: '"entities":"not an array"' }),
      'a body cut off inside a later family': () => ({ tail: '"entities":[{"_id":"cut",', unclosed: true }),
      'a body that is never closed after its last family': () => ({ unclosed: true }),
    };
    for (const [name, build] of Object.entries(cases)) {
      for (const [size, count, pad] of [['over 10 MB', OVER_10_MB_COUNT, PAD], ['PIN: small', FIRST_PAGE, 0]]) {
        it(`${size}: ${name}`, T, async () => {
          const body = exportText({ facts: paddedFacts(count, pad, { idPrefix: 'late' }) }, build());
          const res = await door.post(SPACE, body);
          assert.equal(res.status, 400, `a malformed body (${(body.length / MB).toFixed(1)} MB) was answered ${res.status}: ${res.text.slice(0, 160)}`);
          await settled();
          assert.deepEqual(await idsOf(door, SPACE), [], 'a body that failed validation had its first page written');
          assert.deepEqual(door.importActs(), [], 'a refused body registered an import act');
          assert.deepEqual(door.spoolFiles(), [], 'a refused body left its spool on disk');
        });
      }
    }
  });

  describe('the ceilings answer 413 and write nothing', () => {
    it('a body over importBodyMaxBytes', T, async () => {
      door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 1 * MB; });
      const body = exportText({ facts: paddedFacts(500, PAD, { idPrefix: 'cap' }) }); // about 2 MB, under the global 10 MB
      assert.ok(body.length > 1.5 * MB && body.length < 8 * MB, `fixture check: ${body.length} bytes`);
      const res = await door.post(SPACE, body);
      assert.equal(res.status, 413, `a ${(body.length / MB).toFixed(1)} MB body over a 1 MB importBodyMaxBytes was answered ${res.status}`);
      await settled();
      assert.deepEqual(await idsOf(door, SPACE), [], 'a body over the ceiling was written');
      assert.deepEqual(door.spoolFiles(), [], 'a body over the ceiling left its spool');
    });

    for (const encoding of ['gzip', 'br']) {
      it(`${encoding}: INFLATED bytes count against importBodyMaxBytes, not the bytes on the wire`, T, async () => {
        door.loader.mutateConfig(cfg => { cfg.importBodyMaxBytes = 1 * MB; });
        const plain = exportText({ facts: paddedFacts(500, PAD, { idPrefix: 'bomb' }) });
        const wire = encoded(plain, encoding);
        assert.ok(wire.length < 0.5 * MB && plain.length > 1.5 * MB, `fixture check: ${wire.length} on the wire, ${plain.length} inflated`);
        const res = await door.post(SPACE, wire, { encoding });
        assert.equal(res.status, 413, `a ${encoding} body of ${plain.length} inflated bytes over a 1 MB ceiling was answered ${res.status}`);
        await settled();
        assert.deepEqual(await idsOf(door, SPACE), [], 'an inflated body over the ceiling was written');
      });
    }

    it('a body of more documents than importMaxDocuments', T, async () => {
      door.loader.mutateConfig(cfg => { cfg.importMaxDocuments = 100; });
      const res = await door.post(SPACE, exportText({ facts: Array.from({ length: 150 }, (_, i) => fact(`many-${i}`, i + 1)) }));
      assert.equal(res.status, 413, `150 documents over a ceiling of 100 were answered ${res.status}`);
      await settled();
      assert.deepEqual(await idsOf(door, SPACE), [], 'a body over the document ceiling was written');
      assert.deepEqual(door.importActs(), [], 'a body over the document ceiling registered an act');
    });
  });

  it('an unauthenticated large body is answered 401 and no spool file is made', T, async () => {
    const body = exportText({ facts: paddedFacts(OVER_10_MB_COUNT, PAD, { idPrefix: 'anon' }) });
    assert.ok(body.length > 10 * MB, 'fixture check: the body is not over 10 MB');
    const res = await door.post(SPACE, body, { token: null });
    assert.equal(res.status, 401, `an unauthenticated ${(body.length / MB).toFixed(1)} MB body was answered ${res.status} (the body was read before the caller was let in)`);
    assert.deepEqual(door.spoolFiles(), [], 'an unauthenticated body left a spool file');
    assert.deepEqual(await idsOf(door, SPACE), []);
  });

  describe('a body is inflated by its Content-Encoding, and a body that is not JSON is 415', () => {
    for (const encoding of ['gzip', 'br']) {
      it(`${encoding}: a body over 10 MB inflated (a few KB on the wire) restores`, T, async () => {
        const plain = exportText({ facts: paddedFacts(OVER_10_MB_COUNT, PAD, { idPrefix: `inflated-${encoding}` }) });
        const wire = encoded(plain, encoding);
        assert.ok(plain.length > 10 * MB && wire.length < 2 * MB, `fixture check: ${plain.length} inflated, ${wire.length} on the wire`);
        const res = await door.post(SPACE, wire, { encoding });
        assert.ok(answeredOk(res), `a ${encoding} body of ${(plain.length / MB).toFixed(1)} MB inflated was answered ${res.status}: ${res.text.slice(0, 160)}`);
        await settled();
        assert.equal((await idsOf(door, SPACE)).length, OVER_10_MB_COUNT, 'the inflated body did not land whole');
      });
    }

    for (const encoding of ['gzip', 'deflate', 'br']) {
      it(`PIN: a small ${encoding} body is inflated and restores`, T, async () => {
        const res = await door.post(SPACE, encoded(exportText({ facts: [fact('small-1', 1), fact('small-2', 2)] }), encoding), { encoding });
        assert.ok(answeredOk(res), `a small ${encoding} body was answered ${res.status}: ${res.text.slice(0, 160)}`);
        await settled();
        assert.deepEqual(await idsOf(door, SPACE), ['small-1', 'small-2']);
      });
    }

    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
      it(`${contentType} is answered 415 and writes nothing`, T, async () => {
        const res = await door.post(SPACE, exportText({ facts: [fact('typed-1', 1)] }), { contentType });
        assert.equal(res.status, 415, `a ${contentType} body was answered ${res.status}: ${res.text.slice(0, 160)} (it landed nothing and said 200 with zeros)`);
        assert.deepEqual(await idsOf(door, SPACE), []);
      });
    }
  });

  it('PIN: a repeated id across a page boundary keeps the highest seq, and of equal seqs the earliest', T, async () => {
    // 1 200 documents: pages of 500 put the three copies of `dup` on three pages, and the two equal-seq copies of `tie` on two.
    const docs = [fact('dup', 5, { over: { description: 'first, seq 5' } }), fact('tie', 7, { over: { description: 'first' } })];
    for (let i = 0; i < 700; i++) docs.push(fact(`filler-${i}`, 100 + i));
    docs.push(fact('dup', 9, { over: { description: 'middle, seq 9' } }));
    for (let i = 700; i < 1100; i++) docs.push(fact(`filler-${i}`, 100 + i));
    docs.push(fact('dup', 6, { over: { description: 'last, seq 6' } }), fact('tie', 7, { over: { description: 'second' } }));
    const res = await door.post(SPACE, exportText({ facts: docs }));
    assert.ok(answeredOk(res), `answered ${res.status}: ${res.text.slice(0, 160)}`);
    await settled();
    const dup = await door.coll(SPACE, 'facts').findOne({ _id: 'dup' });
    const tie = await door.coll(SPACE, 'facts').findOne({ _id: 'tie' });
    assert.deepEqual([dup?.seq, dup?.description], [9, 'middle, seq 9'], 'a repeated id did not keep its highest seq');
    assert.equal(tie?.description, 'first', 'of two copies at an equal seq the earlier did not stand');
    assert.equal(await door.coll(SPACE, 'facts').countDocuments({}), 1102, 'a repeated id was stored twice, or a document was lost');
  });

  describe('a full disk, a client that goes away and a body that does not inflate leave no spool and no act', () => {
    /** Until `cond()` holds, bounded by turns (a 15 ms timer each): throws naming `what` when it never does. */
    const until = async (cond, what) => {
      // waits-differently: the server's side of a closed socket is observed by its effect on disk, which no event of this process announces.
      for (let i = 0; i < 400; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 15)); }
      throw new Error(`never: ${what}`);
    };

    it('a disk without room for the body answers 507 and makes no spool', T, async () => {
      const transfer = await import('../../server/dist/api/admin-space-transfer.js');
      transfer.setImportFreeSpaceForTest(() => 1024);
      try {
        const res = await door.post(SPACE, exportText({ facts: paddedFacts(10, 1000, { idPrefix: 'full' }) }));
        assert.equal(res.status, 507, `a body larger than the free disk was answered ${res.status}: ${res.text.slice(0, 160)}`);
      } finally { transfer.setImportFreeSpaceForTest(null); }
      assert.deepEqual(door.spoolFiles(), [], 'a body refused for want of disk left a spool');
      assert.deepEqual(door.importActs(), [], 'a body refused for want of disk registered an act');
      assert.deepEqual(await idsOf(door, SPACE), []);
    });

    it('PIN: a client that goes away mid-body leaves no spool and no act', T, async () => {
      const body = Buffer.from(exportText({ facts: paddedFacts(OVER_10_MB_COUNT, PAD, { idPrefix: 'gone' }) }));
      const req = http.request(`${door.base}/api/admin/spaces/${SPACE}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: `Bearer ${door.adminKey}` },
      });
      req.on('error', () => { /* the test cut it */ });
      req.write(body.subarray(0, 2 * MB));
      await until(() => door.spoolFiles().length === 1, 'the door began a spool for the body being sent');
      req.destroy();
      await until(() => door.spoolFiles().length === 0, 'the spool of a body whose client went away was removed');
      await settled();
      assert.deepEqual(door.importActs(), [], 'a body whose client went away registered an act');
      assert.deepEqual(await idsOf(door, SPACE), []);
    });

    for (const encoding of ['gzip', 'br']) {
      it(`PIN: a ${encoding} body that does not inflate answers 400 and leaves no spool`, T, async () => {
        const good = encoded(exportText({ facts: [fact('broken-1', 1), fact('broken-2', 2)] }), encoding);
        const broken = Buffer.concat([good.subarray(0, 6), Buffer.from('this is not what the encoding promised'.repeat(20))]);
        const res = await door.post(SPACE, broken, { encoding });
        assert.equal(res.status, 400, `a ${encoding} body that does not inflate was answered ${res.status}: ${res.text.slice(0, 160)}`);
        await settled();
        assert.deepEqual(door.spoolFiles(), [], `a ${encoding} body that does not inflate left a spool`);
        assert.deepEqual(door.importActs(), []);
        assert.deepEqual(await idsOf(door, SPACE), []);
      });
    }
  });

  it('the export envelope carries the instance that wrote it (instanceId)', T, async () => {
    await door.coll(SPACE, 'facts').insertOne({ ...fact('env-1', 1), spaceId: SPACE });
    const out = await door.exportSpace(SPACE);
    assert.equal(out.status, 200);
    assert.equal(out.json?.instanceId, door.instanceId(), `the export envelope names ${JSON.stringify(out.json?.instanceId)}, not this instance`);
    assert.equal(out.json?.spaceId, SPACE, 'fixture check: the envelope no longer names the space');
  });
});
