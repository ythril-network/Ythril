/**
 * `file_stamp_report` writes nothing on this instance — not a row, not the counter, not a file, not a watermark, not a
 * collection — on ANY verdict path, through EITHER door; the one thing it records is its own audit entry (`Q-433`, plan
 * rev 4 items 15 and 18; the owner's D-26 = A, report only).
 *
 * ## Why this is a behaviour, not a reading of the source
 *
 * `the-conversion-preview-cannot-write` reads a function's source for the calls it makes. That cannot say this: the
 * report reaches a peer through the sync client, whose neighbours (`pullFamily`) advance the receive watermark and store
 * the page; reads a space through helpers that stamp, hash-cache and queue; and ends in answers whose every branch
 * (a refusal, a hung peer, a deadline) is a path a write could hide on. So the question is asked of the RESULT: the
 * whole space — every collection it has (derived from the database, not listed, so a collection a new feature adds is
 * compared too), the counter row, the files tree on disk, the networks' configuration with its watermarks and the
 * configuration file — is taken before and after a run, and compared whole. A count would pass a report that wrote one
 * row and removed another.
 *
 * ## Both doors
 *
 * The shared function the doors call (`fileStampReport`), and the tool through `callTool` — the dispatch both the MCP
 * transport and `POST /api/file_stamp_report` use. The tool door cannot be handed a deadline or a clock (a caller does
 * not choose how long the instance waits on its peers), so the two scenarios that inject one run on the shared function
 * only; every other scenario runs on both.
 *
 * ## Every verdict path
 *
 * One scenario per way a peer can answer (rows, a server error, a refusal, a peer without the route, no credentials, a
 * refused address, a peer that never answers, a clock past the deadline). Together they must come out with each reason
 * the report can give end to end — a scenario that stopped reaching its path would pass this file about nothing, so the
 * reasons seen are held to a set.
 *
 * ## The exception, stated
 *
 * "Writes nothing" means: nothing on this instance except its own audit entry, which is one `file.stamps.reported` for
 * each call that came through a door, written as an ACT and not as a read (a report that spends the instance's peer
 * credentials is not a read of space data).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-file-stamp-report-writes-nothing-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openStampDoor, PEER, PEER_AUTHOR, PEER_CREATED, sha256Of, bytesOf } from './_file-stamp-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'stampwn';
const AUDIT_OPERATION = 'file.stamps.reported';
/** What the tool is called, as every door names it. */
const TOOL = 'file_stamp_report';

/** The reasons the scenarios must reach end to end: every reason a peer's answer can produce. */
const REACHED = ['LIKELY', 'PEER_SAYS_SELF', 'RELAYED', 'PEER_ROW_INCOMPLETE', 'PEER_HOLDS_NOTHING', 'CREATED_NOT_EARLIER',
  'CREATED_UNPARSABLE', 'HASH_UNKNOWN', 'HASH_DIFFERS', 'EDITED_HERE', 'PEER_UNREACHABLE', 'PEER_REFUSED', 'PEER_TOO_OLD',
  'PEER_ADDRESS_REFUSED', 'NO_CREDENTIALS', 'NOT_CHECKED_BEFORE_DEADLINE'];

let stamp, door, loader, callTool, ADMIN, REASONS;
let served;
let parked;
/** Every reason an answer gave, by the scenario that gave it. */
const seen = new Set();

before(async () => {
  stamp = await openStampDoor({ suite: 'stampwn', space: S });
  door = stamp.door;
  loader = await import('../../server/dist/config/loader.js');
  ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  await seedSpace();
});
after(async () => {
  for (const res of parked ?? []) { try { res.status(500).end(); } catch { /* already gone */ } }
  await stamp?.close();
});

/** One row for each way a row can be judged, a few that are excluded, files on disk for some, and a counter. */
async function seedSpace() {
  served = [];
  parked = [];
  await stamp.s1('a/likely.txt');
  await stamp.s1('a/own.txt', { peer: { author: stamp.selfAuthor } });
  await stamp.s1('a/relay.txt', { peer: { author: { instanceId: 'a-third-instance', instanceLabel: 'Third' } } });
  await stamp.s1('a/close.txt', { peer: { createdAt: '2026-07-31T23:59:30.000Z' } });
  await stamp.s1('a/bytes.txt', { peer: { sha256: sha256Of('other bytes') } });
  await stamp.s1('a/edited.txt', { ours: { description: 'written here' }, peer: { description: 'written there' } });
  await stamp.s1('a/nohash.txt', { ours: { sha256: undefined } });
  await stamp.s1('a/garbled.txt', { peer: { createdAt: 'garbage' } });
  await stamp.s1('a/authorless.txt', { peer: { author: undefined } });
  await stamp.ours('a/unheld.txt');
  // Excluded rows, which a report must leave exactly as they are.
  await stamp.s1('x/moved.txt', { ours: { syncBase: undefined } });
  await stamp.s1('x/deleted.txt', { ours: { deletedAt: '2026-08-15T00:00:00.000Z' } });
  await stamp.s1('x/peer-authored.txt', { ours: { author: PEER_AUTHOR, seq: 9_999_999 } });
  // More peer rows than one page holds, for the deadline between requests.
  await door.seedPeerRecords(stamp.remote, 'filemeta', Array.from({ length: 700 }, (_, i) => build.filemeta(stamp.remote,
    `filler/f${String(i).padStart(4, '0')}.txt`, 100_000 + i, { author: PEER_AUTHOR, createdAt: PEER_CREATED, updatedAt: PEER_CREATED })));
  for (const p of ['a/likely.txt', 'a/own.txt', 'x/moved.txt']) door.writeLocalFile(S, p, bytesOf(p));
  await door.setCounter(S, 5_000);
}

// ── the snapshot: everything this instance holds that a report could have written ────────────────────────────────────

/** Every file under `root`, with its size, mtime and content hash — a rewrite that kept the bytes still moves the mtime. */
function treeOf(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { out[`${path.relative(root, abs)}/`] = true; walk(abs); continue; }
      const st = fs.statSync(abs);
      out[path.relative(root, abs)] = { size: st.size, mtimeMs: st.mtimeMs, sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') };
    }
  };
  walk(root);
  return out;
}

/** The whole instance-side state of the space and of what a report touches beside it. */
async function snapshot() {
  await door.settled();
  const db = door.mongo.getDb();
  const all = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort();
  const own = all.filter(n => n.startsWith(`${S}_`));
  const collections = {};
  for (const name of own) collections[name] = JSON.parse(JSON.stringify(await door.mongo.col(name).find({}).sort({ _id: 1 }).toArray()));
  return {
    // Every collection of the DATABASE, so a collection created for the report's own use is a difference too — but for
    // the audit log, which is the stated exception and which other callers create on first write.
    databaseCollections: all.filter(n => n !== 'audit_log'),
    collections,
    counter: await door.mongo.col('ythril_counters').findOne({ _id: S }),
    files: treeOf(door.localFilesRoot(S)),
    networks: JSON.parse(JSON.stringify(door.config().networks)),
    configFile: fs.readFileSync(process.env['CONFIG_PATH'], 'utf8'),
  };
}

/** What differs, named — so a failure says WHICH write a report made. */
function differences(before, after) {
  const out = [];
  for (const k of Object.keys(before)) {
    if (k === 'collections') {
      for (const name of new Set([...Object.keys(before.collections), ...Object.keys(after.collections)])) {
        if (JSON.stringify(before.collections[name]) !== JSON.stringify(after.collections[name])) out.push(`collection ${name}`);
      }
    } else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}

// ── the doors ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const answerOf = (out) => out.result.structuredContent ?? JSON.parse(out.result.content.map(c => c.text ?? '').join('\n'));
let serial = 0;

const DOORS = {
  'the shared function': { injectable: true, run: (opts) => stamp.report(opts) },
  'the tool door (callTool, as MCP and POST /api/file_stamp_report reach it)': {
    injectable: false,
    audited: true,
    async run(opts) {
      const out = await callTool({
        name: TOOL, args: { space: S, ...(opts.limit ? { limit: opts.limit } : {}) },
        caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: `stamp-writes-${++serial}`, tokenLabel: 'stamp-writes' },
      });
      assert.ok(!out.result.isError, `the tool refused an instance admin: ${out.status} ${JSON.stringify(out.result.content)}`);
      return answerOf(out);
    },
  },
};

// ── the scenarios: each a way a peer can answer ────────────────────────────────────────────────────────────────────────

const serving = (behave = (_req, _res, serve) => serve()) => {
  door.state.family = async (req, res, family) => {
    served.push({ ...req.query });
    await behave(req, res, () => door.serveFamily(req, res, family), served.length);
  };
};
const fails = (status) => (_req, res) => { res.status(status).json({ error: 'scripted refusal' }); };

const SCENARIOS = [
  { name: 'the peer serves its rows', arrange: () => serving(), run: {} },
  { name: 'the peer answers 500', arrange: () => serving(fails(500)), run: {} },
  { name: 'the peer refuses the token (401)', arrange: () => serving(fails(401)), run: {} },
  { name: 'the peer has no such route (404)', arrange: () => serving(fails(404)), run: {} },
  {
    name: 'no token is held for the peer',
    arrange: () => { delete loader.getSecrets().peerTokens[PEER]; serving(); },
    restore: () => { loader.getSecrets().peerTokens[PEER] = 'pull-door-token'; },
    run: {},
  },
  {
    name: 'the member address is refused',
    arrange: () => { door.member().url = 'http://127.0.0.1:9'; serving(); },
    restore: (original) => { door.member().url = original.url; },
    run: {},
  },
  {
    name: 'the peer never answers, and a deadline is injected', injectable: true,
    arrange: () => serving((_req, res) => { parked.push(res); return new Promise(() => {}); }),
    run: { deadlineMs: 300 },
  },
  {
    name: 'the injected clock is past the deadline after the first page', injectable: true,
    arrange: () => {
      let t = Date.parse('2026-10-01T00:00:00.000Z');
      serving(async (_req, _res, serve) => { await serve(); t += 61_000; });
      return { now: () => t };
    },
    run: { deadlineMs: 60_000 },
  },
];

describe('file_stamp_report writes nothing on this instance', { skip }, () => {
  it('the fixture is the space it claims: rows to report, rows to exclude, files on disk, a counter', async () => {
    const files = await stamp.files().find({}).toArray();
    assert.ok(files.length >= 13, `only ${files.length} rows were seeded`);
    assert.ok(files.some(f => f.deletedAt) && files.some(f => f.author.instanceId === PEER) && files.some(f => !f.syncBase));
    assert.equal(Object.keys(treeOf(door.localFilesRoot(S))).filter(k => !k.endsWith('/')).length, 3);
    assert.equal((await door.mongo.col('ythril_counters').findOne({ _id: S })).seq, 5_000);
  });

  for (const [doorName, d] of Object.entries(DOORS)) {
    describe(doorName, () => {
      for (const scenario of SCENARIOS) {
        if (scenario.injectable && !d.injectable) continue;
        it(`${scenario.name}: the space, the counter, the files tree and the configuration are the same after`, async () => {
          const original = { url: door.member().url };
          const injected = scenario.arrange() ?? {};
          const auditedBefore = await door.mongo.col('audit_log').countDocuments({ operation: AUDIT_OPERATION });
          const before = await snapshot();
          let answer, after;
          // The arrangement stays in force until AFTER the second snapshot: it is part of the state both snapshots hold.
          try {
            answer = await d.run({ ...scenario.run, ...injected });
            after = await snapshot();
          } finally { scenario.restore?.(original); }

          assert.deepEqual(differences(before, after), [], `a report wrote to this instance: ${differences(before, after).join(', ')}`);
          assert.ok(Array.isArray(answer.rows) && answer.rows.length >= 10, `the run reported ${answer.rows?.length} rows: it did not look at the space`);
          for (const r of answer.rows) seen.add(r.reason);
          if (d.audited) {
            await waitFor(async () => (await door.mongo.col('audit_log').countDocuments({ operation: AUDIT_OPERATION })) === auditedBefore + 1,
              10_000, 100, `no ${AUDIT_OPERATION} entry for the call`, { what: 'the audit entry of the call' });
            assert.equal(await door.mongo.col('audit_log').countDocuments({ operation: AUDIT_OPERATION }), auditedBefore + 1,
              'more than one audit entry for one call');
          }
        });
      }
    });
  }

  it('between them the scenarios reached every reason a peer\'s answer can produce, so none of the above passed about a path it never took', async () => {
    ({ FILE_STAMP_REASONS: REASONS } = await import('../../server/dist/files/file-stamp-report.js'));
    const names = REACHED.map(key => {
      assert.ok(key in REASONS, `FILE_STAMP_REASONS has no ${key}`);
      return [key, REASONS[key]];
    });
    const missing = names.filter(([, text]) => !seen.has(text)).map(([key]) => key);
    assert.deepEqual(missing, [], `no scenario ended in: ${missing.join(', ')}`);
  });
});
