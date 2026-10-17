/**
 * One open path, one settle step, one writer of `appliedHere`, one reading of a space and of a wipe's types, one result for `addSpacesToNetwork`,
 * one rights decision for the wipe tool, one notice table — the source gates of bundle-106 PR A's open path and settle (design v5 section 6.2).
 *
 * ## The failure this prevents
 *
 * Nine sites opened a vote round and applied its result by hand, four sites concluded one, and two of the openers never evaluated (Q-453). Each gate
 * below is the RULE that the rewrite made true, asked over a DERIVED set with a floor, so a tenth opener or a fifth concluder cannot be written
 * without one of them failing. Each says what a hand-written copy would drop. None names a function it expects to find at a site without first
 * deriving the sites from the source.
 *
 * ## Written before the code (red on the base commit, a638e702)
 *
 * Every assertion below fails at the base for the reason the design gives: `settleRounds`, `proposeRound`, `settleSpaceAct`, `networkSpaceKey`,
 * `wipeTypesOf`, `networks/notify-members.ts` and the `{ added, failed }` result of `addSpacesToNetwork` do not exist yet, and the rights `why` and the
 * stale docblock are as they were. A floor that finds nothing FAILS: an empty derivation never passes.
 *
 * Run: node --test testing/standalone/every-round-is-opened-and-settled-by-one-function.test.js  (pure; no build, no Mongo)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { outermostFunctionAt } from './_source-helpers.mjs';
import { callSitesOf as callsOf, serverSources } from './_call-sites.mjs';

const { raw, blanked } = serverSources();

const exported = (file, name) => new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${name}\\b`).test(blanked.get(file) ?? '');
const filesOf = (calls) => [...new Set(calls.map(c => c.file))].sort();

describe('the open path and the settle step are written once (design v5 section 1.1 and 6.2 gates a-e, h)', () => {
  const SETTLE = 'server/src/networks/round-conclusion.ts';
  const PROPOSE = 'server/src/networks/propose-round.ts';

  it('the two functions exist where the design puts them (a rule about nothing passes every loop below)', () => {
    assert.ok(exported(SETTLE, 'settleRounds'), `${SETTLE} does not export settleRounds — the one settle step`);
    assert.ok(exported(SETTLE, 'SETTLE_VIAS'), `${SETTLE} does not export SETTLE_VIAS — the vocabulary of every via label`);
    assert.ok(exported(PROPOSE, 'proposeRound'), `${PROPOSE} does not export proposeRound — the one open path`);
  });

  it('(a) every concludeRoundIfReady call outside sync/governance.ts is inside settleRounds, but the forecast, which evaluates a scratch copy', () => {
    const sites = callsOf('concludeRoundIfReady').filter(c => c.file !== 'server/src/sync/governance.ts');
    assert.ok(sites.length >= 1, 'no concludeRoundIfReady call found outside governance.ts: re-anchor');
    const EXEMPT = { 'server/src/networks/round-forecast.ts': 'evaluates a scratch copy, never applies (P-32)' };
    const stray = sites.filter(c => c.fn !== 'settleRounds' && !(c.file in EXEMPT)).map(c => `${c.file} (${c.fn ?? 'module scope'})`);
    assert.deepEqual(stray, [], 'these conclude a round outside the one settle step, so what they conclude is applied by hand or not at all');
    for (const f of Object.keys(EXEMPT)) assert.ok(sites.some(c => c.file === f), `the exemption for ${f} is stale: it no longer calls concludeRoundIfReady`);
    assert.ok(sites.some(c => c.fn === 'settleRounds'), 'settleRounds does not conclude anything');
  });

  it('(b) every applyRoundConclusion call is inside settleRounds', () => {
    const sites = callsOf('applyRoundConclusion');
    assert.ok(sites.length >= 1, 'applyRoundConclusion is called nowhere');
    assert.deepEqual(sites.filter(c => c.fn !== 'settleRounds').map(c => `${c.file} (${c.fn ?? 'module scope'})`), []);
  });

  it('(c) every openRoundHere call is inside proposeRound', () => {
    const sites = callsOf('openRoundHere');
    assert.ok(sites.length >= 1, 'openRoundHere is called nowhere');
    assert.deepEqual(sites.filter(c => c.fn !== 'proposeRound').map(c => `${c.file} (${c.fn ?? 'module scope'})`), [],
      'a round opened outside proposeRound is a round nobody evaluated or applied (Q-453)');
  });

  it('(d) the callers of settleRounds are derived, and the five named sites are among them', () => {
    const where = filesOf(callsOf('settleRounds'));
    for (const f of ['sync/engine.ts', 'networks/round-expiry.ts', 'networks/vote-acts.ts', 'api/sync/votes.ts', 'networks/propose-round.ts']) {
      assert.ok(where.includes(`server/src/${f}`), `server/src/${f} does not call settleRounds`);
    }
  });

  it('(e) the callers of proposeRound are derived, and the six openers are among them', () => {
    const where = filesOf(callsOf('proposeRound'));
    for (const f of ['spaces/meta-update.ts', 'networks/network-acts.ts', 'networks/member-acts.ts', 'api/invite.ts', 'api/spaces.ts', 'spaces/wipe-vote.ts']) {
      assert.ok(where.includes(`server/src/${f}`), `server/src/${f} does not call proposeRound`);
    }
  });

  it('(h) every literal via a settleRounds call passes is a member of SETTLE_VIAS, and the vocabulary is the closed set of the design', () => {
    const src = blanked.get(SETTLE) ?? '';
    const vias = [...(/SETTLE_VIAS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map(m => m[1]);
    assert.ok(vias.length >= 5, `SETTLE_VIAS found ${vias.length} entries in ${SETTLE}: re-anchor`);
    for (const v of ['gossip', 'expiry', 'retry', 'local vote', 'peer vote', 'proposer']) assert.ok(vias.includes(v), `SETTLE_VIAS lacks '${v}'`);
    const literals = callsOf('settleRounds').flatMap(c => [...c.args.matchAll(/'([^']+)'/g)].map(m => m[1]));
    assert.ok(literals.length >= 5, `only ${literals.length} literal via(s) found across the settleRounds callers`);
    assert.deepEqual([...new Set(literals)].filter(v => !vias.includes(v)), []);
  });
});

describe('one writer of appliedHere, one reading of a network space, one reading of a wipe\'s types (design v5 section 2.1, 2.2 (4))', () => {
  it('every assignment to appliedHere is inside settleSpaceAct, and there is at least one', () => {
    const sites = [];
    for (const [file, text] of blanked) {
      for (const m of text.matchAll(/\.appliedHere\s*=(?!=)/g)) sites.push({ file, fn: outermostFunctionAt(file, raw.get(file), m.index)?.name ?? null });
    }
    assert.ok(sites.length >= 1, 'no assignment to appliedHere found: a floor of zero cannot pass');
    assert.deepEqual(sites.filter(s => s.fn !== 'settleSpaceAct').map(s => `${s.file} (${s.fn ?? 'module scope'})`), [],
      'a second writer of appliedHere is a round that is applied and never completed, or completed and never applied');
    assert.ok(exported('server/src/spaces/apply-wipe-round.ts', 'settleSpaceAct'), 'spaces/apply-wipe-round.ts does not export settleSpaceAct');
  });

  it('networkSpaceKey is the one place a round\'s network space is read from networkSpaceId and the alias table', () => {
    assert.ok(exported('server/src/sync/space-map.ts', 'networkSpaceKey'), 'sync/space-map.ts does not export networkSpaceKey');
    const readers = [];
    for (const [file, text] of blanked) {
      for (const m of text.matchAll(/networkSpaceId\s*\?\?/g)) readers.push({ file, fn: outermostFunctionAt(file, raw.get(file), m.index)?.name ?? null });
    }
    // util/signing.ts spells it to build the bsig fields, which is a different question (what a signature covers).
    assert.deepEqual(readers.filter(r => r.fn !== 'networkSpaceKey' && r.file !== 'server/src/util/signing.ts').map(r => `${r.file} (${r.fn})`), []);
    assert.ok(callsOf('networkSpaceKey').some(c => c.file === 'server/src/spaces/apply-wipe-round.ts'), 'apply-wipe-round.ts does not ask networkSpaceKey');
  });

  it('wipeTypesOf is the one reading of which types a wipe covers: exported from lifecycle, asked by both REST doors and the tool', () => {
    assert.ok(exported('server/src/spaces/lifecycle.ts', 'wipeTypesOf'), 'spaces/lifecycle.ts does not export wipeTypesOf');
    const where = filesOf(callsOf('wipeTypesOf'));
    for (const f of ['app.ts', 'spaces/delete-space-data.ts', 'spaces/wipe-vote.ts']) assert.ok(where.includes(`server/src/${f}`), `server/src/${f} does not canonicalise types through wipeTypesOf`);
  });
});

describe('addSpacesToNetwork returns its answer and every caller reads it or says why (X16)', () => {
  it('the function answers { added, failed } and never throws', () => {
    const src = blanked.get('server/src/networks/network-spaces.ts');
    const sig = /export\s+async\s+function\s+addSpacesToNetwork\s*\([\s\S]*?\)\s*:\s*Promise<([^{]*)>\s*\{/.exec(src)?.[1] ?? '';
    assert.match(sig, /added\s*:\s*string\[\]/, `its result type is ${sig.trim() || 'not found'}: design v5 section 1.4a — { added: string[]; failed?: string }`);
    assert.match(sig, /failed\s*\??\s*:\s*string/);
  });

  it('every caller reads .failed or carries the reason an announcement ignores it', () => {
    const sites = callsOf('addSpacesToNetwork').filter(c => !(c.fn === 'addSpacesToNetwork'));
    assert.ok(sites.length >= 3, `only ${sites.length} caller(s) of addSpacesToNetwork found: re-anchor`);
    const REASON = /an announcement: the exchange's other work must not be lost/;
    const unread = sites.filter(c => {
      const around = raw.get(c.file).slice(Math.max(0, c.at - 400), c.at + c.args.length + 900);
      return !/\.failed\b/.test(around) && !REASON.test(around);
    });
    assert.deepEqual(unread.map(c => `${c.file} (${c.fn})`), [], 'a swallowed failure answered as success (W16/X16)');
  });
});

describe('the wipe tool is a space-admin decision, decided in ONE place (D-41, X12)', () => {
  const tool = stripComments(fs.readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));
  const rights = fs.readFileSync('server/src/auth/space-rights.ts', 'utf8');

  it('delete_space_data carries spaceAdmin: true and no ROUTE_RIGHTS / TOOL_RIGHTS row, and the deleting module asks no rights helper', () => {
    const def = tool.slice(tool.indexOf("name: 'delete_space_data'"));
    assert.ok(def.length > 0, 'delete_space_data is not defined in mcp/tools/spaces.ts');
    assert.match(def.slice(0, def.indexOf('handle')), /spaceAdmin:\s*true/, 'the tool does not carry the spaceAdmin flag');
    const code = stripComments(rights);
    assert.doesNotMatch(code.replace(/NOT_AREA_SCOPED[\s\S]*$/, ''), /['"]delete_space_data['"]\s*:/, 'a rights row for delete_space_data area-scopes a door the design says is not');
    assert.doesNotMatch(stripComments(fs.readFileSync('server/src/spaces/delete-space-data.ts', 'utf8')), /auth\/(?:space-rights|tool-rights|rights)/, 'delete-space-data.ts asks a rights question of its own');
  });

  it('the stale sentence is gone and the D-41 sentence is where the rule is', () => {
    assert.doesNotMatch(rights, /`delete_space_data` is `admin: true`/, 'auth/space-rights.ts still says the tool is admin: true (it is spaceAdmin: true)');
    assert.match(rights, /D-41/, 'the /api/:tool NOT_AREA_SCOPED why does not carry the D-41 sentence');
    assert.match(fs.readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'), /D-41/, 'the flag\'s docblock at mcp/tools/spaces.ts does not carry the D-41 sentence');
  });
});

describe('a round that may pass at open is told to the members from ONE table (design v5 section 1.6)', () => {
  const MODULE = 'server/src/networks/notify-members.ts';

  it('the module exists, names its timeout, and every event it says wakes a receiver is in the receiver\'s sync trigger — and no other', () => {
    assert.ok(fs.existsSync(MODULE), `${MODULE} does not exist: the three copies of "tell the members to pull" are still three`);
    const src = blanked.get(MODULE) ?? '';
    assert.match(src, /export\s+const\s+NOTIFY_SEND_TIMEOUT_MS\s*=\s*5_?000\b/);
    const rows = [...src.matchAll(/event:\s*'(\w+)'[^}]*?wakes:\s*(true|false)/g)].map(m => ({ event: m[1], wakes: m[2] === 'true' }));
    assert.ok(rows.length >= 4, `only ${rows.length} event row(s) found in the table: the four events the design lists are the floor`);
    const receiver = blanked.get('server/src/api/notify.ts');
    const trigger = /export\s+const\s+(\w*(?:TRIGGER|WAKE)\w*)\s*=\s*(?:new\s+Set\()?\s*\[([^\]]*)\]/.exec(receiver);
    assert.ok(trigger, 'api/notify.ts exports no sync-trigger constant for the handler to read');
    const triggered = new Set([...trigger[2].matchAll(/'(\w+)'/g)].map(m => m[1]));
    for (const { event, wakes } of rows) assert.equal(triggered.has(event), wakes, `${event}: the table says wakes=${wakes} and the receiver's constant says ${triggered.has(event)}`);
  });
});

describe('the local fields of a round are the fields this instance keeps and never ships (X1, X8)', () => {
  it('LOCAL_ROUND_FIELDS names actLocalId and peersConcluded, and none of the retired spellings', () => {
    const src = blanked.get('server/src/networks/round-local-state.ts');
    const list = [...(/LOCAL_ROUND_FIELDS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '').matchAll(/'(\w+)'/g)].map(m => m[1]);
    assert.ok(list.length >= 5, 'LOCAL_ROUND_FIELDS not found: re-anchor');
    for (const f of ['actLocalId', 'peersConcluded']) assert.ok(list.includes(f), `LOCAL_ROUND_FIELDS lacks ${f}: a peer's copy would carry this instance's own act state`);
    for (const f of ['actAttempts', 'actRetryAt', 'skippedHere']) assert.ok(!list.includes(f), `${f} is void under v5: the act's retry clock is on its entry, and nothing skips a wipe`);
  });
});
