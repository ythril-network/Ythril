/**
 * Every reason sentence the sync API guide quotes is the code's own word for word, and the guide quotes every one (bundle-39, the 6.3.1 docs lens S1).
 *
 * ## The defect it prevents
 *
 * A waited sync answers each member with a `reason`: one of a closed list of sentences of ours (`REASONS` in `server/src/sync/cycle-outcome.ts`).
 * `docs/integration-guide/09-sync-api.md` quoted three of them in prose, and none was the code's: "failed while landing the peer's page" where the
 * code says "failed while exchanging with the peer", and "the peer did not answer" where it says "the peer did not answer, or answered an error".
 * A client that matches on a reason, or a reader who greps the log for one, was sent after a sentence the server never writes. The 6.3.1 documentation
 * lens found it by reading; nothing compared a quoted sentence with the list, so a reworded reason (or a reason added, like `store-down` and
 * `no-token`, which the prose never named) would drift the same way.
 *
 * ## What it holds
 *
 * The anchor is the guide's MEMBER-OUTCOME TABLE: the table whose header row's first cell is "member `outcome`" and whose third column is headed
 * "`reason`". Its rows are `| `outcome` | the member's turn | "sentence"; "sentence" |`: each double-quoted run in a row's third cell is one quoted
 * reason sentence, and a row may carry several (a `local-fault` has three). The gate holds, against `REASONS` read from the built server:
 *
 *  - (a) every quoted sentence is a `REASONS` value, character for character;
 *  - (b) every `REASONS` value is quoted in the table, so a reason added to the code must be added to the guide;
 *  - (c) each sentence stands in the row of its own outcome (a `REASONS` key that is not a member outcome, `store-down` and `no-token`, is a reason
 *    of `local-fault`: the code's `stopped()` and the no-token path say so), and every member outcome has a row;
 *  - (d) a floor: the table is found and quotes at least as many sentences as `REASONS` has values, so a reworded header or a table that lost its
 *    third column fails loudly instead of passing over nothing.
 *
 * The rule is also run on synthetic text (a planted wrong sentence, a dropped reason, a sentence in the wrong row, a missing table), so weakening it
 * fails here without waiting for a page to drift.
 *
 * ## Red at b73cf9225
 *
 * The guide's table has no `reason` column and its prose quotes sentences that are not the code's: (b) names every reason missing and (d) the floor.
 *
 * Run: node --test testing/standalone/every-quoted-sync-reason-is-the-codes-own.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { REASONS, MEMBER_OUTCOMES } from '../../server/dist/sync/cycle-outcome.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = 'docs/integration-guide/09-sync-api.md';

/** The outcome a `REASONS` key belongs to: the key itself, or `local-fault` for the two local faults that carry a reason of their own. */
const outcomeOfKey = (key) => (MEMBER_OUTCOMES.includes(key) ? key : 'local-fault');

/** The member-outcome table's rows, as { outcome, quoted[] }; null when the table is not found. */
function memberOutcomeRows(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const head = lines.findIndex(l => {
    if (!l.trim().startsWith('|')) return false;
    const c = cells(l);
    return c.length >= 3 && c[0] === 'member `outcome`' && c[2].includes('`reason`');
  });
  if (head < 0) return null;
  const rows = [];
  for (let i = head + 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const c = cells(lines[i]);
    const outcome = (c[0].match(/^`([^`]+)`$/) ?? [])[1] ?? c[0];
    rows.push({ outcome, quoted: [...(c[2] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1]) });
  }
  return rows;
}

/** The problems between the guide's table and the code's reasons; empty when they agree. */
function reasonProblems(md, reasons, outcomes) {
  const rows = memberOutcomeRows(md);
  if (!rows) return ['the member-outcome table (header "member `outcome`" ... "`reason`") is not in the guide'];
  const problems = [];
  const values = new Set(Object.values(reasons));
  const quotedAll = rows.flatMap(r => r.quoted);
  if (quotedAll.length < Object.keys(reasons).length) problems.push(`the table quotes ${quotedAll.length} sentences, fewer than the ${Object.keys(reasons).length} reasons the code has`);
  for (const r of rows) for (const q of r.quoted) if (!values.has(q)) problems.push(`row \`${r.outcome}\` quotes "${q}", which is not a reason the code writes`);
  for (const [key, sentence] of Object.entries(reasons)) {
    const own = outcomes.includes(key) ? key : 'local-fault';
    const row = rows.find(r => r.outcome === own);
    if (!row) problems.push(`no row for outcome \`${own}\``);
    else if (!row.quoted.includes(sentence)) problems.push(`row \`${own}\` does not quote "${sentence}" (reason \`${key}\`)`);
  }
  for (const o of outcomes) if (!rows.some(r => r.outcome === o)) problems.push(`no row for outcome \`${o}\``);
  return problems;
}

describe('every quoted sync reason is the code\'s own', () => {
  const md = readFileSync(resolve(ROOT, GUIDE), 'utf8');

  it('the guide quotes exactly the reasons the code writes, each in its own outcome\'s row', () => {
    assert.deepEqual(reasonProblems(md, REASONS, MEMBER_OUTCOMES), []);
  });

  it('the table is found and carries a quote for every reason (floor)', () => {
    const rows = memberOutcomeRows(md);
    assert.ok(rows, 'the member-outcome table is not found');
    assert.ok(rows.flatMap(r => r.quoted).length >= Object.keys(REASONS).length);
    assert.ok(rows.length >= MEMBER_OUTCOMES.length);
  });

  it('the code\'s keys map to outcomes as this gate assumes (a new non-outcome key needs a decision here)', () => {
    for (const key of Object.keys(REASONS)) {
      if (!MEMBER_OUTCOMES.includes(key)) assert.ok(['store-down', 'no-token'].includes(key), `REASONS key '${key}' is not a member outcome: say which outcome's row carries it`);
      assert.ok(MEMBER_OUTCOMES.includes(outcomeOfKey(key)));
    }
  });

  describe('the rule on synthetic text', () => {
    const table = (cells) => ['| member `outcome` | the member\'s turn | its `reason`, word for word |', '|---|---|---|', ...cells].join('\r\n');
    const reasons = { success: 'it went well', 'store-down': 'the store is down' };
    const outcomes = ['success', 'local-fault'];
    const good = table(['| `success` | ok | "it went well" |', '| `local-fault` | us | "the store is down" |']);

    it('passes a table that quotes the code\'s words in the right rows', () => {
      assert.deepEqual(reasonProblems(good, reasons, outcomes), []);
    });
    it('fails a planted wrong sentence', () => {
      const bad = good.replace('"it went well"', '"it went fine"');
      const p = reasonProblems(bad, reasons, outcomes);
      assert.ok(p.some(x => x.includes('"it went fine"') && x.includes('not a reason the code writes')), p.join('\n'));
      assert.ok(p.some(x => x.includes('does not quote "it went well"')), p.join('\n'));
    });
    it('fails a reason the table omits', () => {
      const bad = table(['| `success` | ok | "it went well" |', '| `local-fault` | us | |']);
      assert.ok(reasonProblems(bad, reasons, outcomes).some(x => x.includes('does not quote "the store is down"')));
    });
    it('fails a sentence in another outcome\'s row', () => {
      const bad = table(['| `success` | ok | "it went well"; "the store is down" |', '| `local-fault` | us | |']);
      assert.ok(reasonProblems(bad, reasons, outcomes).some(x => x.includes('row `local-fault` does not quote')));
    });
    it('fails an outcome with no row', () => {
      const bad = table(['| `success` | ok | "it went well" |']);
      assert.ok(reasonProblems(bad, reasons, outcomes).some(x => x.includes('no row for outcome `local-fault`')));
    });
    it('fails when the table is not there', () => {
      assert.ok(reasonProblems('no table here', reasons, outcomes).some(x => x.includes('is not in the guide')));
      assert.ok(reasonProblems(good.replace('`reason`', 'why'), reasons, outcomes).some(x => x.includes('is not in the guide')));
    });
  });
});
