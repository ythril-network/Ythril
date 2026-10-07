/**
 * Every caller of the tombstone applies hands it a delivery that `deliveryOf` built.
 *
 * ## The rule
 *
 * `applyPeerTombstones` (records) and `applyPeerFileTombstones` (files) take the same third argument: the
 * `Delivery` of the page — who delivered it, whether it is a trusted admin relay, and whether the deliverer is this
 * space's direct upstream. That last bit is derived from THIS instance's own config for the space the door admitted,
 * and it is what turns a delivery into the power to delete what the deliverer relayed (D-14). `deliveryOf` is the only
 * thing that derives it.
 *
 * A caller that writes the argument itself — `{ peerInstanceId: member.instanceId }`, which is exactly what the pull
 * door does today, or `{ peerInstanceId: callerPeerId, trustedRelay }`, which is what the push route does — decides
 * `upstream` by omission (`undefined`, so false) or, worse, by a copy of the rule that drifts from the module's. It is
 * the same rule, written once per door, and the weaker copy wins silently: the pull door and the push door would stop
 * deciding alike, which is the defect `push-and-pull-decide-alike-db` exists to catch from the outside and this gate
 * catches at the call.
 *
 * ## What counts as "from deliveryOf"
 *
 * Read from the syntax tree (`_delivery-arguments.mjs`). For each call of either apply anywhere under `server/src`
 * (found by name, so a third door written next year is covered the day it exists), the third argument is either a call
 * to `deliveryOf` — or to one of the two one-line wrappers the doors use, `deliveryOfMember` (the pull side) and
 * `deliveryOfRequest` (the push side) — or an identifier whose every declaration in the file is initialised from one.
 * A wrapper is accepted only while its own definition returns a `deliveryOf(…)` call in every branch (the last block
 * below), so naming a function "deliveryOf…" does not make a hand-built delivery acceptable. A delivery that arrives
 * as a PARAMETER is a finding: the gate cannot see where it came from, and the door that calls the function that takes
 * it is where the answer has to be.
 *
 * ## Floors
 *
 * Each apply has two doors (the push route and the pull step), so fewer than two calling files means the scan lost
 * one, not that the rule holds. The gate also holds that both applies exist and take the delivery as their third
 * parameter.
 *
 * ## Mutation that turns it red
 *
 * Replace the argument at either door by an object literal, or by a variable assigned one; build the delivery in a
 * helper and pass it down as a parameter; add a third caller that does either. Each is named by file and line. The
 * checker's own table below is the proof it sees each shape.
 *
 * Run: node --test testing/standalone/every-tombstone-apply-takes-its-delivery-from-deliveryOf.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { parseSource, ts, unwrapExpression } from '../_shared/syntax-tree.mjs';
import { deliveryArgumentsOf, APPLIES, DELIVERY_PARAM, DELIVERY_BUILDERS } from './_delivery-arguments.mjs';
import { calleeNameOf } from './_expression-names.mjs';

/** The two doors each apply has: the push route and the pull step. A floor, not a count of what the repo holds. */
const DOORS = 2;

describe('the checker reads the syntax tree and sees the shapes this gate is about', () => {
  const good = {
    'a direct deliveryOf call': 'async function f(){ await applyPeerTombstones(s, raw, deliveryOf(cfg, s, auth), w); }',
    'a const initialised from deliveryOf': 'async function f(){ const delivery = deliveryOf(cfg, s, auth); await applyPeerFileTombstones(s, raw, delivery, w); }',
    'an awaited-through const': 'async function f(){ const d = await deliveryOf(cfg, s, auth); return applyPeerTombstones(s, raw, d, w); }',
    'a call through a namespace import': 'async function f(){ const d = deliveryOf(cfg, s, auth); return t.applyPeerTombstones(s, raw, d, w); }',
    'the pull side\'s wrapper, direct': 'async function f(){ await applyPeerTombstones(s, raw, deliveryOfMember(s, member), w); }',
    'the push side\'s wrapper, through a const': 'async function f(){ const delivery = deliveryOfRequest(s, req); await applyPeerFileTombstones(s, raw, delivery, w); }',
  };
  const bad = {
    'an object literal (the pull door today)': 'async function f(){ await applyPeerTombstones(s, raw, { peerInstanceId: member.instanceId }, w); }',
    'an object literal with trustedRelay (the push route today)': 'async function f(){ await applyPeerTombstones(s, raw, { peerInstanceId: id, trustedRelay }, w); }',
    'a const holding an object literal': 'async function f(){ const delivery = { peerInstanceId: id, trustedRelay: false, upstream: true }; await applyPeerFileTombstones(s, raw, delivery, w); }',
    'a parameter': 'async function g(delivery){ await applyPeerTombstones(s, raw, delivery, w); }',
    'a spread of a delivery': 'async function f(){ const d = deliveryOf(c, s, a); await applyPeerTombstones(s, raw, { ...d, upstream: true }, w); }',
    'a missing argument': 'async function f(){ await applyPeerTombstones(s, raw); }',
    'a const that is only SOMETIMES from deliveryOf': 'async function f(){ const d = deliveryOf(c, s, a); { const d = { peerInstanceId: x }; } await applyPeerTombstones(s, raw, d, w); }',
    'a function that merely sounds like a builder': 'async function f(){ await applyPeerTombstones(s, raw, deliveryFromToken(t), w); }',
  };
  for (const [name, src] of Object.entries(good)) {
    it(`accepts ${name}`, () => {
      const r = deliveryArgumentsOf('x.ts', src);
      assert.equal(r.length, 1, src);
      assert.equal(r[0].ok, true, r[0].why);
    });
  }
  for (const [name, src] of Object.entries(bad)) {
    it(`refuses ${name}`, () => {
      const r = deliveryArgumentsOf('x.ts', src);
      assert.equal(r.length, 1, src);
      assert.equal(r[0].ok, false, src);
    });
  }
  it('does not read a comment, a string or the definition as a call', () => {
    const src = '// applyPeerTombstones(s, raw, {}, w)\nconst s = "applyPeerFileTombstones(a, b, {}, d)";\nexport async function applyPeerTombstones(a, b, delivery, w) {}';
    assert.deepEqual(deliveryArgumentsOf('x.ts', src), []);
  });
});

describe('every apply is handed a delivery from deliveryOf', () => {
  const sources = trackedSources('server/src', { floor: 200, untracked: true });
  const calls = sources.flatMap(file => deliveryArgumentsOf(file, readFileSync(join(REPO_ROOT, file), 'utf8')).map(c => ({ ...c, file })));

  for (const name of APPLIES) {
    it(`${name}: the function exists, takes the delivery third, and has a caller at each of its doors`, () => {
      const defining = sources.filter(f => new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(readFileSync(join(REPO_ROOT, f), 'utf8')));
      assert.equal(defining.length, 1, `${name} is defined in ${defining.length} file(s): ${defining.join(', ')}`);
      const sf = parseSource(defining[0], readFileSync(join(REPO_ROOT, defining[0]), 'utf8'));
      let params;
      ts.forEachChild(sf, n => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) params = n.parameters.map(p => p.name.getText(sf)); });
      assert.ok(params && params.length >= 4, `${name} takes ${params?.length} parameters; expected (localSpaceId, raw, delivery, where)`);
      assert.match(params[DELIVERY_PARAM], /delivery/i, `${name}'s third parameter is \`${params[DELIVERY_PARAM]}\`; the delivery is the third`);

      const callers = calls.filter(c => c.name === name);
      const files = new Set(callers.map(c => c.file));
      assert.ok(files.size >= DOORS, `${name} has callers in ${files.size} file(s) (${[...files].join(', ')}); each apply has a push door and a pull door`);
    });

    it(`${name}: no caller writes the delivery itself`, () => {
      const bad = calls.filter(c => c.name === name && !c.ok).map(c => `${c.file}:${c.line} — ${c.why}`);
      assert.deepEqual(bad, [], `${name} is called with a delivery that deliveryOf did not build:\n  ${bad.join('\n  ')}`);
    });
  }
});

describe('the builders: a wrapper of deliveryOf returns deliveryOf\'s answer and nothing else', () => {
  const sources = trackedSources('server/src', { floor: 200, untracked: true });
  const wrappers = DELIVERY_BUILDERS.filter(n => n !== 'deliveryOf');

  it('there is the base builder and at least one wrapper to hold', () => {
    assert.ok(DELIVERY_BUILDERS.includes('deliveryOf') && wrappers.length >= 1, `the builder list is ${JSON.stringify(DELIVERY_BUILDERS)}`);
  });

  for (const name of wrappers) {
    it(`${name}: defined once, and every return in it is a deliveryOf(…) call`, () => {
      const defining = sources.filter(f => new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`).test(readFileSync(join(REPO_ROOT, f), 'utf8')));
      assert.equal(defining.length, 1, `${name} is defined in ${defining.length} file(s): ${defining.join(', ')}`);
      const sf = parseSource(defining[0], readFileSync(join(REPO_ROOT, defining[0]), 'utf8'));
      let fn;
      ts.forEachChild(sf, n => { if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n; });
      assert.ok(fn?.body, `${name} has no body to read`);
      const returns = [];
      const visit = (n) => {
        if (ts.isFunctionLike(n) && n !== fn) return;   // a nested function's returns are not this one's
        if (ts.isReturnStatement(n)) returns.push(n);
        ts.forEachChild(n, visit);
      };
      visit(fn.body);
      assert.ok(returns.length >= 1, `${name} never returns: a wrapper that hands nothing back builds no delivery`);
      const notBuilt = returns.filter(r => {
        const e = r.expression && unwrapExpression(r.expression);
        return !(e && ts.isCallExpression(e) && calleeNameOf(e) === 'deliveryOf');
      }).map(r => r.getText(sf).slice(0, 80));
      assert.deepEqual(notBuilt, [], `${name} returns something deliveryOf did not build, so the callers it is accepted for are written by hand one call deeper`);
    });
  }
});
