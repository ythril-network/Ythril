/**
 * `node scripts/trade.mjs --record <ref>...` writes ONE `Trade` chrono record per bundle to the Ythril instance
 * `YTHRIL_TEST_RUNS_URL` names, refuses what it cannot vouch for before it sends anything, and `--history` reads the records
 * back (Q-590, design rev 2 items 3, 4, 7, 8 and 9). `--type-schema` prints the declaration of the type.
 *
 * ## What this prevents
 *
 * Trade's figures are printed and lost: whether skipping the database tests locally pays off is a question about a TREND, and
 * a trend needs records. A recorder like that goes wrong quietly in these ways, each held below by running the real CLI over
 * a history of runs (`fake-gh-and-git-preload.mjs`) and a fake instance that keeps a store (`fake-ythril-tool-server.mjs`):
 *
 * 1. **Another type's record rewritten.** A `Test-Run` entry may hold `recordKey: trade:130`. Trade's find names its type.
 * 2. **A record that is half old.** Recording twice finds the first and replaces it, carrying EVERY field (the update merges).
 * 3. **A record that forgets runs.** `gh run list` shows the latest runs only; a re-record whose run ids miss one the stored
 *    record holds would erase it. It is KEPT, and the line says so.
 * 4. **A record written from a figure that is not one.** An unknown cut-over, a bundle with no counted run after it, and a
 *    run that is unread-budget, unplaced or missing a field make the bundle's figures wrong or partial: refused, named, exit 2,
 *    and not one call to the instance.
 * 5. **A recording nobody can tell failed.** Exit 2 for an unset destination, a failed write and CI; never 0.
 * 6. **A figure typed as text.** Every figure is a JSON number; the two counts that were run-id lists are counts.
 * 7. **A trend that averages averages.** `--history` sums failures over runs across records.
 *
 * ## The contract this file pins beyond the design's words
 *
 * - The identity is `properties.recordKey` = `trade:<String(Number(bundle))>`, the same property `Test-Run` uses.
 * - The properties written are exactly: recordKey, formatVersion, bundle, refs, runIds, cutoverSha, afterCounted,
 *   afterFailures, afterTimeouts, afterUnresolved, savedMinutes, costMinutes, netMinutes, calendarMinutes, supersededCount,
 *   neverStartedCount, beforeCounted, beforeFailures. Minutes are rounded to two decimals; `refs` and `runIds` are sorted,
 *   comma-joined, over EVERY run of the bundle that the listing holds (named or counted). Dates and times go in `startsAt` and
 *   `endsAt` of the entry and are not held here.
 * - A refusal prints, on stderr, a line starting `trade:` that names the bundle number and the reason's words: `unknown` beside
 *   `cut-over` (one line), `no counted`, or the kind `tradeReport` already names (`unread-budget`, `unplaced`, `missing-field`),
 *   every one that applies. An unknown cut-over is its own reason, not only the "no counted run" it also implies.
 * - A `kept` outcome is exit 0 and says `kept` and `no longer`; `inserted` and `replaced` are said by their word.
 * - A usage error's first stderr line is `trade: ` and names the flags; never `unknown argument`.
 *
 * Local server only. Run: node --test testing/standalone/trade-records-each-bundle-as-one-trade-record.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeYthril, FAKE_SPACE } from '../_shared/fake-ythril-tool-server.mjs';
import { TypeSchemasZ } from '../../server/dist/spaces/body-schemas.js';
import { getAllowedChronoTypes } from '../../server/dist/spaces/schema-validation.js';
import {
  runTrade, everything, SHAS, BUNDLE_130, BUNDLE_130_FIGURES, NUMBER_FIELDS, TEXT_FIELDS, tradeRun, dbStep, greenRuns,
} from '../_shared/trade-record-harness.mjs';

/** The whole module, not named imports: a name it does not export yet is a failed assertion in the test about it, not a file that cannot load. */
const trade = await import('../../scripts/trade.mjs');
const REF_130 = 'full-run/bundle-130';
const FIELDS = [...NUMBER_FIELDS, ...TEXT_FIELDS].sort();

async function withServer(body) {
  const server = await startFakeYthril();
  try { return await body(server); } finally { await server.close(); }
}
const record = (server, args = ['--record', REF_130], over = {}) => runTrade(args, { server, ...over });
const trades = (server) => server.store.filter(e => e.type === 'Trade');
const firstLine = (text) => text.split('\n').find(l => l.trim()) ?? '';

describe('--record writes one Trade record per bundle', () => {
  it('writes the bundle\'s figures, worked by hand from the counting rules, into a Trade entry keyed trade:130', async () => {
    await withServer(async (server) => {
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.equal(trades(server).length, 1, everything(r));
      const entry = trades(server)[0];
      assert.equal(server.callsTo('save_chrono')[0].args.space, FAKE_SPACE);
      assert.equal(entry.type, 'Trade');
      assert.deepEqual(Object.keys(entry.properties).sort(), FIELDS, 'the properties written are exactly the design\'s list');
      for (const [k, want] of Object.entries(BUNDLE_130_FIGURES)) assert.equal(entry.properties[k], want, k);
      assert.match(r.stdout, /inserted/, 'the line says what was done');
      assert.match(r.stdout, /130/);
    });
  });

  it('every figure goes over the wire as a JSON number, and the two counts that name runs are counts', async () => {
    await withServer(async (server) => {
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.callsTo('save_chrono').length, 1, everything(r));
      const sent = server.callsTo('save_chrono')[0].args.properties;
      for (const k of NUMBER_FIELDS) assert.ok(typeof sent[k] === 'number' && Number.isFinite(sent[k]), `${k} is ${typeof sent[k]} ${JSON.stringify(sent[k])}`);
      for (const k of TEXT_FIELDS) assert.equal(typeof sent[k], 'string', k);
      for (const k of ['savedMinutes', 'costMinutes', 'netMinutes', 'calendarMinutes']) assert.equal(Number(sent[k].toFixed(2)), sent[k], `${k} is rounded to two decimals`);
      assert.equal(sent.afterTimeouts, 1, 'afterTimeouts counts the timeouts (it was a list of run ids)');
      assert.equal(sent.afterUnresolved, 1, 'afterUnresolved counts the failures with no green step after them');
    });
  });

  it('recording twice leaves one record, and the second write carries every field (a field left out would keep its stale value)', async () => {
    await withServer(async (server) => {
      const first = await record(server);
      assert.equal(first.code, 0, everything(first));
      assert.equal(trades(server).length, 1, everything(first));
      assert.match(first.stdout, /inserted/);
      const properties = trades(server)[0].properties;
      properties.afterFailures = 99; // what an older recording left behind
      properties.neverStartedCount = 77;
      const second = await record(server);
      assert.equal(second.code, 0, everything(second));
      assert.match(second.stdout, /replaced/);
      assert.equal(trades(server).length, 1, 'one record, not two');
      assert.equal(server.callsTo('save_chrono').length, 1, 'the second recording is not a second insert');
      const updates = server.callsTo('update_chrono');
      assert.equal(updates.length, 1);
      assert.deepEqual(Object.keys(updates[0].args.properties).sort(), FIELDS, 'the update names every field');
      for (const [k, want] of Object.entries(BUNDLE_130_FIGURES)) assert.equal(trades(server)[0].properties[k], want, `${k} after the second write`);
    });
  });

  it('a re-record whose run ids miss one the stored record holds is KEPT, not replaced, and says why', async () => {
    await withServer(async (server) => {
      const first = await record(server);
      assert.equal(first.code, 0, everything(first));
      assert.equal(trades(server).length, 1);
      const stored = trades(server)[0].properties;
      stored.runIds = `${stored.runIds},9999`; // a run the listing no longer shows
      stored.afterCounted = 77;
      const before = structuredClone(server.store);
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(server.store, before, 'the stored record is as it was');
      assert.deepEqual([...server.callsTo('update_chrono'), ...server.callsTo('delete_chrono')], []);
      assert.equal(server.callsTo('save_chrono').length, 1);
      assert.match(r.stdout, /kept/);
      assert.match(r.stdout, /no longer/, 'it says the stored record holds runs the listing no longer shows');
    });
  });

  it('a re-record that holds every stored run id and more REPLACES (fewer stored ids are no reason to keep)', async () => {
    await withServer(async (server) => {
      const first = await record(server);
      assert.equal(first.code, 0, everything(first));
      assert.equal(trades(server).length, 1);
      const stored = trades(server)[0].properties;
      stored.runIds = '1001,1002';
      stored.afterCounted = 77;
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.match(r.stdout, /replaced/);
      assert.equal(trades(server)[0].properties.afterCounted, BUNDLE_130_FIGURES.afterCounted);
      assert.equal(trades(server)[0].properties.runIds, BUNDLE_130_FIGURES.runIds);
    });
  });

  it('a Test-Run record keyed trade:130 is untouched when Trade 130 is recorded (find by type AND key)', async () => {
    await withServer(async (server) => {
      server.seed({ type: 'Test-Run', title: 'a test run with a borrowed key', properties: { recordKey: 'trade:130', ms: 5, outcome: 'passed' } });
      const snapshot = structuredClone(server.store);
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.equal(trades(server).length, 1, everything(r));
      assert.deepEqual(server.store.filter(e => e.type === 'Test-Run'), snapshot, 'the Test-Run entry is exactly as it was');
      assert.deepEqual([...server.callsTo('update_chrono'), ...server.callsTo('delete_chrono')], []);
      assert.ok(server.callsTo('filter').every(c => c.args.filter?.type === 'Trade'), 'every read names the type');
    });
  });

  it('refs of one bundle collapse into one record keyed by the bundle: bundle-106-a0 and bundle-106-a are trade:106', async () => {
    await withServer(async (server) => {
      const runs = [...greenRuns(2001, 'full-run/bundle-106-a0', ['10:00:00']), ...greenRuns(2002, 'full-run/bundle-106-a', ['11:00:00'])];
      const r = await record(server, ['--record', 'full-run/bundle-106-a0', 'full-run/bundle-106-a'], { runs });
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.callsTo('save_chrono').length, 1, everything(r));
      assert.equal(trades(server).length, 1);
      const p = trades(server)[0].properties;
      assert.equal(p.recordKey, 'trade:106');
      assert.equal(p.bundle, '106');
      assert.deepEqual(p.refs.split(','), ['full-run/bundle-106-a', 'full-run/bundle-106-a0']);
      assert.equal(p.afterCounted, 2);
    });
  });

  it('the key is the bundle\'s number as a number: bundle-0106 is trade:106; two bundles asked for are two records', async () => {
    await withServer(async (server) => {
      const runs = [...greenRuns(3001, 'full-run/bundle-0106', ['10:00:00']), ...greenRuns(3002, 'full-run/b107', ['11:00:00'])];
      const r = await record(server, ['--record', 'full-run/bundle-0106', 'full-run/b107'], { runs });
      assert.equal(r.code, 0, everything(r));
      assert.deepEqual(trades(server).map(e => e.properties.recordKey).sort(), ['trade:106', 'trade:107'], everything(r));
    });
  });
});

describe('the entry\'s own dates are the counted runs\' dates', () => {
  it('startsAt is the first counted run\'s creation and endsAt the last completion of a counted run; a baseline run and the clock are neither', async () => {
    await withServer(async (server) => {
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      assert.equal(server.callsTo('save_chrono').length, 1, everything(r));
      const sent = server.callsTo('save_chrono')[0].args;
      // 1006 is the baseline (09:00) and ends the day's earliest; the counted runs are 1001 (created 10:00) ... 1007 (completed 14:30).
      assert.equal(sent.startsAt, '2026-10-20T10:00:00.000Z');
      assert.equal(sent.endsAt, '2026-10-20T14:30:00.000Z');
    });
  });

  it('a second recording writes the same dates, so a re-record is not a record of another moment', async () => {
    await withServer(async (server) => {
      assert.equal((await record(server)).code, 0);
      const r = await record(server);
      assert.equal(r.code, 0, everything(r));
      const update = server.callsTo('update_chrono')[0]?.args;
      assert.ok(update, everything(r));
      assert.equal(update.startsAt, '2026-10-20T10:00:00.000Z');
      assert.equal(update.endsAt, '2026-10-20T14:30:00.000Z');
    });
  });
});

describe('--record reads the listing until it no longer fills the limit, up to a ceiling', () => {
  const listCalls = (r) => r.calls.filter(c => c.file === 'gh' && c.args[0] === 'run' && c.args[1] === 'list').map(c => Number(c.args[c.args.indexOf('-L') + 1]));

  it('raises a limit the listing fills (the cut listing would read as a quiet history), then records every run of the bundle', async () => {
    await withServer(async (server) => {
      const r = await record(server, ['--record', REF_130, '--limit', '5']);
      assert.equal(r.code, 0, everything(r));
      const limits = listCalls(r);
      assert.equal(limits[0], 5, 'the first read asks for the limit it was given');
      assert.ok(limits.length >= 2, 'a listing that filled it was read again');
      for (let i = 1; i < limits.length; i++) assert.ok(limits[i] > limits[i - 1], `each read asks for more: ${limits.join(', ')}`);
      assert.ok(limits.at(-1) > BUNDLE_130.length, `the last read is wider than the history (${BUNDLE_130.length} runs): ${limits.join(', ')}`);
      assert.equal(trades(server).length, 1, everything(r));
      assert.equal(trades(server)[0].properties.runIds, BUNDLE_130_FIGURES.runIds, 'no run was cut off');
    });
  });

  it('a listing that still fills the ceiling is refused, naming --limit, with nothing sent', async () => {
    const ceiling = trade.RECORD_LIMIT_CEILING;
    assert.ok(Number.isInteger(ceiling) && ceiling >= 500 && ceiling <= 20_000, `trade exports RECORD_LIMIT_CEILING, a whole number from 500 to 20000 (it is ${ceiling})`);
    await withServer(async (server) => {
      const probes = Array.from({ length: ceiling + 1 }, (_, i) => tradeRun(900_000 + i, 'full-run/probe-x', SHAS.after, '10:00:00', []));
      const r = await record(server, ['--record', REF_130], { runs: probes, timeoutMs: 120_000 });
      assert.equal(r.code, 2, everything(r));
      assert.doesNotMatch(r.stderr, /unknown argument/);
      assert.match(firstLine(r.stderr), /^trade: .*--limit/, everything(r));
      assert.ok(listCalls(r).length >= 2 && listCalls(r).length <= 20, `read ${listCalls(r).length} times`);
      assert.equal(listCalls(r).at(-1), ceiling, 'the last read asked for the ceiling and it was still full');
      assert.deepEqual(server.calls, [], 'nothing was written, or even read, on the instance');
    });
  });
});

describe('a ref that is no bundle is refused before gh is asked anything', () => {
  it('--record full-run/probe-b85: exit 2 naming the ref, no gh call, no instance call', async () => {
    await withServer(async (server) => {
      const r = await record(server, ['--record', 'full-run/probe-b85']);
      assert.equal(r.code, 2, everything(r));
      const first = firstLine(r.stderr);
      assert.match(first, /^trade: /);
      assert.doesNotMatch(first, /unknown argument/);
      assert.match(first, /probe-b85/);
      assert.match(first, /no bundle/);
      assert.deepEqual(r.calls, []);
      assert.deepEqual(server.calls, []);
    });
  });
});

describe('a bundle trade cannot vouch for is refused, named, with exit 2 and not one call to the instance', () => {
  const REFUSED = [
    ['the cut-over is unknown', /unknown[^\n]*cut-over|cut-over[^\n]*unknown/i, { cutover: null }],
    ['the bundle has no counted run after the cut-over', /no counted/i, { runs: [tradeRun(4001, 'full-run/bundle-140', SHAS.before, '10:00:00', [dbStep('success', '10:00:00', '10:03:00')])] }, '140'],
    ['a run was left unread when the budget ended', /unread-budget/i, { runs: greenRuns(4101, 'full-run/bundle-150', ['10:00:00', '10:10:00']), budgetEndsAfterApiCalls: 1 }, '150'],
    ['a run\'s head cannot be placed against the cut-over', /unplaced/i, { runs: [...greenRuns(4201, 'full-run/bundle-160', ['10:00:00']), tradeRun(4202, 'full-run/bundle-160', 'd'.repeat(40), '11:00:00', [dbStep('success', '11:00:00', '11:03:00')])], unplaceable: ['d'.repeat(40)] }, '160'],
    ['a run lacks a field its figures need', /missing-field/i, { runs: [...greenRuns(4301, 'full-run/bundle-170', ['10:00:00']), tradeRun(4302, 'full-run/bundle-170', SHAS.after, '11:00:00', [dbStep('success', '11:00:00', null)])] }, '170'],
  ];
  for (const [why, reason, over, bundle = '130'] of REFUSED) {
    it(`${why}`, async () => {
      await withServer(async (server) => {
        const ref = `full-run/bundle-${bundle}`;
        const r = await record(server, ['--record', ref], over);
        assert.equal(r.code, 2, everything(r));
        assert.doesNotMatch(r.stderr, /unknown argument/, 'refused for its reason, not as a flag trade does not know');
        assert.match(r.stderr, /^trade: /m, everything(r));
        assert.match(r.stderr, reason, everything(r));
        assert.match(r.stderr, new RegExp(`\\b${bundle}\\b`), 'the refusal names the bundle');
        assert.deepEqual(server.calls, [], 'not one call reached the instance, not even a read');
      });
    });
  }
});

describe('exit 2: a recording that did not happen is never exit 0', () => {
  it('YTHRIL_TEST_RUNS_URL unset', async () => {
    await withServer(async (server) => {
      const r = await runTrade(['--record', REF_130], { server: undefined, env: {} });
      assert.equal(r.code, 2, everything(r));
      assert.doesNotMatch(r.stderr, /unknown argument/);
      assert.match(r.stderr, /^trade: [^\n]*YTHRIL_TEST_RUNS_URL/m, everything(r));
      assert.deepEqual(server.calls, []);
    });
  });

  it('YTHRIL_TEST_RUNS_TOKEN unset', async () => {
    await withServer(async (server) => {
      const r = await runTrade(['--record', REF_130], { env: { YTHRIL_TEST_RUNS_URL: server.url } });
      assert.equal(r.code, 2, everything(r));
      assert.doesNotMatch(r.stderr, /unknown argument/);
      assert.match(r.stderr, /^trade: [^\n]*YTHRIL_TEST_RUNS_TOKEN/m, everything(r));
      assert.deepEqual(server.calls, []);
    });
  });

  it('a write the instance refuses, and the token is not in what is printed', async () => {
    await withServer(async (server) => {
      server.respond = (call) => (call.tool === 'save_chrono' ? { status: 500, body: { ok: false, error: 'the store is down' } } : undefined);
      const r = await record(server);
      assert.equal(r.code, 2, everything(r));
      assert.doesNotMatch(r.stderr, /unknown argument/);
      assert.match(r.stderr, /^trade: /m, everything(r));
      assert.match(r.stderr, /500|store is down/, 'the failure says what the instance answered');
      assert.ok(server.callsTo('save_chrono').length >= 1, 'the write was attempted');
      assert.ok(!everything(r).includes(server.token));
      assert.equal(trades(server).length, 0);
    });
  });

  for (const name of ['GITHUB_ACTIONS', 'CI']) {
    it(`under ${name}: refused with the trade: prefix, and nothing is sent`, async () => {
      await withServer(async (server) => {
        const r = await record(server, ['--record', REF_130], { env: { [name]: 'true' } });
        assert.equal(r.code, 2, everything(r));
        assert.doesNotMatch(r.stderr, /unknown argument/);
        assert.match(r.stderr, new RegExp(`^trade: [^\\n]*refused[^\\n]*${name}`, 'm'), everything(r));
        assert.deepEqual(server.calls, [], 'CI never holds the token that writes records');
      });
    });
  }
});

describe('--record\'s arguments are checked before gh or the instance is asked anything', () => {
  const USAGE_ERRORS = [
    ['--record with no ref', ['--record'], /--record/, /ref/],
    ['--record followed by another option instead of a ref', ['--record', '--limit', '5'], /--record/, /ref/],
    ['--record together with --line', ['--record', REF_130, '--line', REF_130], /--record/, /--line/],
    ['--line before --record', ['--line', REF_130, '--record', REF_130], /--record/, /--line/],
  ];
  for (const [what, args, a, b] of USAGE_ERRORS) {
    it(`${what}: exit 2, a usage line naming the flags, no gh call, no instance call`, async () => {
      await withServer(async (server) => {
        const r = await record(server, args);
        assert.equal(r.code, 2, everything(r));
        const first = firstLine(r.stderr);
        assert.match(first, /^trade: /, everything(r));
        assert.doesNotMatch(first, /unknown argument/, 'trade knows the flag; it is the use that is refused');
        assert.match(first, a, first);
        assert.match(first, b, first);
        assert.deepEqual(r.calls, [], 'neither gh nor git was asked');
        assert.deepEqual(server.calls, []);
      });
    });
  }
});

describe('--type-schema prints the declaration of the Trade type', () => {
  it('one JSON document, the arguments of schema_update, with the FULL Trade type: every figure typed, the server\'s validator content', async () => {
    const r = await runTrade(['--type-schema']);
    assert.equal(r.code, 0, everything(r));
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.space, FAKE_SPACE);
    assert.equal(doc.typeSchemasMode, 'merge');
    const type = doc.typeSchemas.chrono.Trade;
    assert.ok(type, 'the Trade type is declared');
    assert.deepEqual(Object.keys(type.propertySchemas).sort(), FIELDS, 'declared properties are the ones --record writes');
    for (const k of NUMBER_FIELDS) assert.equal(type.propertySchemas[k].type, 'number', k);
    for (const k of TEXT_FIELDS) assert.equal(type.propertySchemas[k].type, 'string', k);
    for (const [k, p] of Object.entries(type.propertySchemas)) assert.ok(typeof p.description === 'string' && p.description.length > 10, `${k} has a description`);
    assert.equal(type.propertySchemas.recordKey.required, true);
    assert.ok(type.description && type.description.length > 20, 'the type says what it is');
    assert.equal(type.suppressEmbeddings, true);
    assert.equal(type.whenDuePasses, 'nothing');
    assert.ok(Number.isInteger(type.retention?.days) && type.retention.days > 0, 'a retention of nothing is no bound');
    const parsed = TypeSchemasZ.safeParse(doc.typeSchemas);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues).slice(0, 500));
    for (const d of getAllowedChronoTypes(undefined)) assert.ok(d in doc.typeSchemas.chrono, `the server's default chrono type ${d} is kept beside it`);
    assert.deepEqual(r.calls, [], 'printing a declaration asks neither gh nor git');
  });
});

describe('--history sums over records, it does not average their rates', () => {
  const trade = (server, key, over) => server.seed({ type: 'Trade', title: key, properties: { recordKey: key, formatVersion: 1, bundle: key.slice(6), refs: '', runIds: '', cutoverSha: SHAS.cutover, afterTimeouts: 0, afterUnresolved: 0, supersededCount: 0, neverStartedCount: 0, beforeCounted: 0, beforeFailures: 0, calendarMinutes: 0, ...over } });
  /** `label` and then the number as a whole token on the same line: 9 is not 9.5, and not 19. */
  const line = (label, n) => new RegExp(`${label}[^\\n]*(?<![\\d.])${n}(?:\\.0+)?(?!\\d|\\.\\d)`, 'i');

  it('failure rate is sum(afterFailures) / sum(afterCounted); means are over records with a counted run; another type is not a record', async () => {
    await withServer(async (server) => {
      trade(server, 'trade:201', { afterCounted: 1, afterFailures: 1, savedMinutes: 5.5, costMinutes: 1, netMinutes: 4.5 });
      trade(server, 'trade:202', { afterCounted: 9, afterFailures: 0, savedMinutes: 12.5, costMinutes: 3, netMinutes: 9.5 });
      trade(server, 'trade:203', { afterCounted: 0, afterFailures: 0, savedMinutes: 1000, costMinutes: 1000, netMinutes: 1000 }); // no counted run: not in any mean
      server.seed({ type: 'Test-Run', title: 'decoy', properties: { recordKey: 'trade:204', afterCounted: 100, afterFailures: 100, savedMinutes: 5000, costMinutes: 5000, netMinutes: 5000 } });
      const r = await runTrade(['--history'], { server });
      assert.equal(r.code, 0, everything(r));
      assert.doesNotMatch(everything(r), /unknown argument/);
      // 1 failure in 10 counted runs is 10 %; the mean of the two records' rates (100 % and 0 %) would be 50 %.
      assert.match(r.stdout, /(?<![\d.])10(?:\.0+)?\s*%/, r.stdout);
      assert.doesNotMatch(r.stdout, /(?<![\d.])50(?:\.0+)?\s*%/, 'a mean of means');
      assert.match(r.stdout, line('saved', 9), r.stdout);
      assert.match(r.stdout, line('cost', 2), r.stdout);
      assert.match(r.stdout, line('net', 7), r.stdout);
      assert.doesNotMatch(r.stdout, /1000|5000/, 'a record with no counted run, and a record of another type, are in no figure');
      assert.ok(server.callsTo('filter').length >= 1);
      assert.ok(server.callsTo('filter').every(c => c.args.filter?.type === 'Trade'), 'the read names the type');
      assert.deepEqual([...server.callsTo('save_chrono'), ...server.callsTo('update_chrono'), ...server.callsTo('delete_chrono')], [], 'reading writes nothing');
    });
  });
});
