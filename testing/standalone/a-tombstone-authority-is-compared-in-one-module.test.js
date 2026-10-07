/**
 * Whether a peer's tombstone may delete a held object is compared in ONE module: `sync/deletion-authority.ts`.
 *
 * ## The finding this holds
 *
 * "May this tombstone delete that record?" was written twice and had begun to diverge: `applyPeerTombstones` compared
 * the delivering peer with the issuer and the issuer with the record's author, and the file-tombstone door compared
 * nothing at all (it accepted any peer's path, which is Q-242). The arrival side asks a neighbouring question (does a
 * held tombstone refuse a record arriving now) and spells its half again. Bundle-51 puts the delete question in one
 * place (`authorises`, `deleteBound`), where both doors, the admin import and the repair read it. A second spelling
 * elsewhere is the next copy, and the weaker copy wins silently.
 *
 * ## What counts as a tombstone-authority comparison
 *
 * Read out of the syntax tree, never matched as text — so a sentence in a comment, a string, a log line or a docblock
 * (every one of which says these words) is not a finding:
 *
 *   - a call to `tombstoneGoverns` (the issuer-versus-author question); or
 *   - `===` / `!==` / `==` / `!=` between two operands of DIFFERENT parties:
 *       ISSUER  (`issuer`, `.issuer`)
 *       AUTHOR  (`author`, `.author.instanceId`, and a variable initialised from one)
 *       PEER    (`peerInstanceId`, `deliverer` — the authenticated deliverer)
 *       STAMP   (`deliveredBy` — the stored record of who delivered it)
 *     issuer-with-peer is the proof, issuer-with-author is authorship, author-or-stamp-with-peer is the upstream
 *     ground. Two operands of the SAME party (`a.peerInstanceId === b.peerInstanceId`, a token lookup) ask something else.
 *
 * ## The one reasoned exemption
 *
 * `upsert-plan.ts` keeps the ARRIVAL-side question — `heldTombstoneRefuses`, which decides whether a tombstone already
 * held refuses a version that arrives now, for a record (`tombSeqFor`) and for a file's metadata (`shadowDecision`) alike —
 * and the definition of `tombstoneGoverns` it shares with `authorises`. They are a
 * different question (refuse an arrival; not delete a held object), named here by function so the exemption cannot
 * widen to the file. If a second arrival-side site appears it fails this gate and is either moved into the module or
 * argued for here.
 *
 * ## Mutation that turns it red
 *
 * Paste `if (issuer !== auth.peerInstanceId) { … }` or a `tombstoneGoverns(…)` call into any route, sync step or import
 * under `server/src` other than the module — the offending file and line are named. Move `tombstoneGoverns`'s call
 * back into `tombstone-apply.ts`: red. Delete the module's own comparisons (a stub): the floor test goes red.
 *
 * Run: node --test testing/standalone/a-tombstone-authority-is-compared-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { authorityComparisons } from './_authority-comparisons.mjs';

const MODULE = 'server/src/sync/deletion-authority.ts';

/** Function-level exemptions: `file` -> the names of the top-level functions whose comparisons are another question. */
const EXEMPT = new Map([
  ['server/src/sync/upsert-plan.ts', new Map([
    ['heldTombstoneRefuses', 'the ARRIVAL side: does a tombstone already held refuse a record or file version arriving now'],
    ['tombstoneGoverns', 'the one spelling of "same instance, or either unknown" that `authorises` and `heldTombstoneRefuses` share'],
  ])],
]);

describe('the detector reads the syntax tree and finds the shapes this gate is about', () => {
  const flagged = {
    'a peer against an issuer': 'function f(auth, issuer) { return auth.peerInstanceId === issuer; }',
    'an issuer against a peer, negated': 'function f(issuer, auth) { if (issuer !== auth.peerInstanceId) return 1; }',
    'a call to tombstoneGoverns': 'function f(i, a) { return tombstoneGoverns(i, a); }',
    'an author alias against a deliverer': 'function f(doc, deliveredBy) { const author = doc.author?.instanceId; return author === deliveredBy; }',
    'an author against an issuer': 'function f(held, doc) { return held.issuer === doc.author?.instanceId; }',
    'a stamp against a peer': 'function f(target, delivery) { return target.deliveredBy === delivery.peerInstanceId; }',
  };
  const benign = {
    'two peers of one party (a token lookup)': 'function f(x, t) { return x.peerInstanceId === t.peerInstanceId; }',
    'an author against a member id (a seq watermark, not authority)': 'function f(doc, member) { return doc.author?.instanceId === member.instanceId; }',
    'a claimed id against a record': 'function f(record, claimedId) { return record.peerInstanceId === claimedId; }',
    'a line comment': '// if (issuer !== auth.peerInstanceId) tombstoneGoverns(a, b)\nfunction f() {}',
    'a block comment': '/* tombstoneGoverns(a, b); author === deliveredBy */\nfunction f() {}',
    'a string': 'const s = "issuer !== peerInstanceId, tombstoneGoverns(a, b)";',
    'a template literal': 'const s = `${x} tombstoneGoverns(a, b)`;',
  };
  for (const [name, src] of Object.entries(flagged)) {
    it(`flags ${name}`, () => assert.equal(authorityComparisons('x.ts', src).length, 1, src));
  }
  for (const [name, src] of Object.entries(benign)) {
    it(`does not flag ${name}`, () => assert.deepEqual(authorityComparisons('x.ts', src), [], src));
  }
});

describe('the module owns the comparisons', () => {
  const sources = trackedSources('server/src', { floor: 200, untracked: true });

  it('scans the whole of server/src, and the module is among what it scans and holds the comparisons itself', () => {
    assert.ok(sources.length >= 200, `only ${sources.length} files scanned`);
    assert.ok(sources.includes(MODULE), `${MODULE} does not exist (or is not under server/src)`);
    const own = authorityComparisons(MODULE, readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    // The issuer proof, the authorship check and the stamp check: a module that holds fewer than these three is a stub,
    // and a gate over a stub passes everything.
    assert.ok(own.length >= 3, `${MODULE} holds ${own.length} tombstone-authority comparison(s); the rule needs it to hold the issuer proof, the authorship check and the upstream stamp check:\n${own.map(o => `  line ${o.line}: ${o.what}`).join('\n')}`);
  });

  it('no other file in server/src compares them, bar the named arrival-side functions', () => {
    const findings = [];
    for (const file of sources) {
      if (file === MODULE) continue;
      const exempt = EXEMPT.get(file);
      for (const f of authorityComparisons(file, readFileSync(join(REPO_ROOT, file), 'utf8'))) {
        if (exempt && f.fn !== undefined && exempt.has(f.fn)) continue;
        findings.push(`${file}:${f.line} ${f.what}${f.fn ? ` (in ${f.fn})` : ''}`);
      }
    }
    assert.deepEqual(findings, [],
      'a tombstone-authority comparison outside sync/deletion-authority.ts — ask `authorises` (and bound the write with `deleteBound`) instead of spelling the rule again:\n  '
      + findings.join('\n  '));
  });

  it('every exemption still names a function that exists in a file that exists', () => {
    for (const [file, fns] of EXEMPT) {
      assert.ok(sources.includes(file), `the exempt file ${file} is gone`);
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const fn of fns.keys()) assert.match(text, new RegExp(`function\\s+${fn}\\b`), `${file} no longer has ${fn}; drop the exemption`);
    }
  });
});
