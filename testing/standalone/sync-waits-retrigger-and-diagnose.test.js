/**
 * A sync wait must re-trigger, and its timeout must explain itself.
 *
 * ## The failure
 *
 *     not ok — Subscriber-local content survives publisher tombstone
 *       error: 'waitFor timed out after 15000ms'
 *
 * On a feature branch whose diff could not touch it. That message is the whole problem: it does not say which
 * of the test's two identical waits gave up, nor whether the peer was slow, the trigger was being rejected, or
 * the network id was wrong. A re-run cleared it, which is the correct immediate action and the wrong permanent
 * one — a suite that fails environmentally trains everyone to re-run, and the day it fails for a real reason it
 * gets the same treatment.
 *
 * ## Three defects in one shape
 *
 * `await triggerSync(...)` followed by a bare `waitFor`:
 *
 *   1. **One trigger races the gossip cycle.** The fire is async; if it queues behind other work nothing
 *      arrives and the poll expires having never asked again.
 *   2. **A bare timeout cannot tell a stall from a rejection.** A persistently-429'd trigger, a wrong network
 *      id and a merely-slow peer all print the same sentence. That is exactly how the notify rate-limit bug hid
 *      for weeks — every trigger was being refused and all anyone saw was a timeout.
 *   3. **It does not say what it was waiting for.**
 *
 * `syncUntil` does all three. `closed-network.test.js` had already worked the pattern out by hand at ONE of its
 * four sites, which is the argument for a helper over a comment.
 *
 * ## Why this is a ratchet and not a clean sweep
 *
 * 22 sites still have the bare shape and **none of them has ever been observed failing**. Converting them
 * mechanically would mean inventing 22 "waiting for …" phrases that no script can write and no measurement
 * justifies — and the description is the entire value of the change. So this gate freezes the count instead:
 * the remaining sites are named below, and a NEW one fails the build.
 *
 * A negative assertion — "wait a fixed time, then prove it did NOT arrive" — is deliberately not this shape and
 * must not be converted. See the note in `pubsub-topology.test.js`.
 *
 * ## Where the wait itself lives
 *
 * `syncUntil` is built on the one wait, `testing/_shared/wait-for.mjs`, and hands it `what` so the module words the
 * timeout. Both halves are exercised here rather than read: the helper is run against a fetch that answers, so the
 * rule — a timeout names what it waited for and what the trigger did — is checked where a reader sees it, and a
 * future rewrite of the helper's internals cannot keep the sentence in a comment while losing it in the message.
 *
 * Run: node --test testing/standalone/sync-waits-retrigger-and-diagnose.test.js
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { balancedFrom } from './_structural-window.mjs';
import { syncUntil } from '../sync/helpers.js';

const ROOT = process.cwd();

/**
 * Files still holding the bare shape, with their counts. Lower a number when you convert a site; the gate
 * fails if any file exceeds its entry, or if a file not listed here acquires one.
 *
 * Frozen 2026-08-06 at 22 sites. This list is the honest statement of what is NOT covered — a gate that
 * reported only "the fixed one is fixed" would read as though the class were closed.
 */
const KNOWN_BARE = {
  'testing/integration/networks.test.js': 2,
  'testing/sync/braintree-governance.test.js': 4,
  'testing/sync/braintree.test.js': 2,
  'testing/sync/closed-network.test.js': 3,
  'testing/sync/gossip.test.js': 2,
  'testing/sync/merkle.test.js': 1,
  'testing/sync/vote-forgery.test.js': 1,
  'testing/sync/vote-key-rotation.test.js': 2,
  'testing/sync/vote-propagation.test.js': 5,
};

function syncTestFiles() {
  return execFileSync('git', ['ls-files', 'testing/sync', 'testing/integration'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(f => f.endsWith('.test.js'));
}

/** Count `triggerSync` immediately followed by a `waitFor` that has no diagnose argument. */
function bareWaits(src) {
  const re = /await triggerSync\([^)]*\);(?:[^\n]*\n){0,6}?[^\n]*await waitFor\(/g;
  let n = 0, m;
  while ((m = re.exec(src)) !== null) {
    /*
     * The `waitFor(` CALL, bounded by the paren that closes it. At 800 characters a long predicate pushed the
     * argument list out of the window, so `diagnose` read as absent and a correctly-written wait was counted as bare
     * — and this gate's whole output is that count.
     */
    const call = balancedFrom(src, m.index + m[0].length - 1, 'the waitFor call');
    const args = /\}\s*(,[\s\S]*)?\)$/.exec(call)?.[1] ?? '';
    if (!/diagnose/.test(args)) n++;
  }
  return n;
}

describe('a sync wait re-triggers and explains its own timeout', () => {
  it('helpers.js provides the pattern as one function', () => {
    const src = readFileSync(join(ROOT, 'testing/sync/helpers.js'), 'utf8');
    assert.match(src, /export async function syncUntil\(/,
      'the trigger + re-trigger + diagnose pattern must be one helper, not a comment telling people to hand-roll it');
    // All three defects, so a future "simplification" cannot quietly drop one.
    assert.match(src, /makeTriggerProbe\(/, 'syncUntil must use the probe, or a rejected trigger is invisible again');
    assert.match(src, /setInterval\(/, 'syncUntil must re-trigger while polling, or one fire races the gossip cycle');
    assert.match(src, /from '\.\.\/_shared\/wait-for\.mjs'/,
      'syncUntil must wait through the one module — a loop of its own is a second wait that can drift');
    assert.match(src, /clearInterval\(/, 'the re-trigger interval must be cleared, or the test process never exits');
  });

  describe('its timeout, exercised', () => {
    const realFetch = globalThis.fetch;
    after(() => { globalThis.fetch = realFetch; });

    /** A fetch whose first `answers` calls come back 200 and every later one comes back `then`. */
    function fetchAnswering(answers, then) {
      let n = 0;
      globalThis.fetch = async () => new Response(JSON.stringify({}), { status: n++ < answers ? 200 : then });
    }

    it('names what it was waiting for, and blames the peer when every trigger landed', async () => {
      fetchAnswering(Infinity, 200);
      await assert.rejects(
        () => syncUntil('http://peer.invalid', 'tok', 'net', async () => false, 'the tombstone to reach B',
          { timeoutMs: 150, interval: 20, retriggerMs: 40, label: 'B' }),
        (err) => {
          assert.match(err.message, /waiting for the tombstone to reach B/, 'the timeout must name what was awaited');
          assert.match(err.message, /sync triggers to B all succeeded/, 'and blame the peer, not the trigger');
          return true;
        });
    });

    it('says the TRIGGER was being refused when it was — a stall and a rejection no longer read alike', async () => {
      fetchAnswering(1, 429); // the first trigger lands; every re-trigger is rate-limited
      await assert.rejects(
        () => syncUntil('http://peer.invalid', 'tok', 'net', async () => false, 'the record to reach B',
          { timeoutMs: 250, interval: 20, retriggerMs: 30, label: 'B' }),
        (err) => {
          assert.match(err.message, /waiting for the record to reach B/);
          assert.match(err.message, /every sync trigger to B was failing/);
          assert.match(err.message, /triggerSync failed: 429/, `expected the real cause, got: ${err.message}`);
          return true;
        });
    });

    it('appends what onTimeout found, and survives an onTimeout that throws', async () => {
      fetchAnswering(Infinity, 200);
      await assert.rejects(
        () => syncUntil('http://peer.invalid', 'tok', 'net', async () => false, 'a watermark',
          { timeoutMs: 100, interval: 20, retriggerMs: 1_000, label: 'B', onTimeout: async () => 'the sender holds it at seq 7' }),
        /waiting for a watermark.*the sender holds it at seq 7$/);
      await assert.rejects(
        () => syncUntil('http://peer.invalid', 'tok', 'net', async () => false, 'a watermark',
          { timeoutMs: 100, interval: 20, retriggerMs: 1_000, label: 'B', onTimeout: async () => { throw new Error('HTTP 500'); } }),
        /waiting for a watermark.*diagnostic failed: HTTP 500$/,
        'a diagnostic that fails must not replace the timeout it describes');
    });

    it('returns once the condition holds, re-triggering on the way', async () => {
      fetchAnswering(Infinity, 200);
      let polls = 0;
      assert.equal(await syncUntil('http://peer.invalid', 'tok', 'net', async () => ++polls >= 3, 'it to arrive',
        { timeoutMs: 2_000, interval: 20, retriggerMs: 1_000, label: 'B' }), true);
    });
  });

  it('the test that actually flaked uses it', () => {
    const src = readFileSync(join(ROOT, 'testing/sync/pubsub-topology.test.js'), 'utf8');
    assert.match(src, /syncUntil\(/, 'the observed failure must be fixed with the shared helper, not a local copy');
    assert.equal(bareWaits(src), 0, 'pubsub-topology still holds a bare trigger-then-wait');
  });

  it('no NEW bare trigger-then-wait appears', () => {
    const files = syncTestFiles();
    // An empty enumeration would make the check below pass while examining nothing — the exact failure
    // `gates-cannot-pass-vacuously` exists to forbid. `git ls-files` returning nothing is a real possibility
    // (wrong cwd, a submodule checkout), and it would look like a clean tree.
    assert.ok(files.length >= 20, `only enumerated ${files.length} sync/integration test files`);
    const grown = [];
    for (const f of files) {
      const n = bareWaits(readFileSync(join(ROOT, f), 'utf8'));
      const allowed = KNOWN_BARE[f.replaceAll('\\', '/')] ?? 0;
      if (n > allowed) grown.push(`${f}: ${n} bare waits, ${allowed} allowed`);
    }
    assert.deepEqual(grown, [],
      'a new `await triggerSync(...)` + bare `waitFor` — use syncUntil, which re-triggers and says what it '
      + 'was waiting for when it gives up');
  });

  it('reports the sites still uncovered, so the class cannot read as closed', () => {
    // Not an assertion about quality — a statement of scope. If this total ever reaches 0, delete KNOWN_BARE
    // and make the previous test an absolute check.
    const remaining = Object.values(KNOWN_BARE).reduce((a, b) => a + b, 0);
    assert.ok(remaining > 0, 'KNOWN_BARE is empty — tighten the gate to an absolute zero and delete this test');
    const actual = syncTestFiles()
      .reduce((sum, f) => sum + bareWaits(readFileSync(join(ROOT, f), 'utf8')), 0);
    assert.ok(actual <= remaining,
      `${actual} bare waits in the tree against ${remaining} recorded — the ratchet is out of date`);
    if (actual < remaining) {
      console.log(`  note: ${remaining - actual} site(s) have been converted since this was frozen — lower KNOWN_BARE`);
    }
  });
});
