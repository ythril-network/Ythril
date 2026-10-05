/**
 * Every catch that answers, returns or stores an error's TEXT does it through `caughtFailureText` — or is one of our own
 * errors, or says why it is exempt (`Q-361`; main's bundle-30 I12/I13, the pre-ship security lens).
 *
 * ## The rule, and the population it is held over
 *
 * A driver error's message names the host, the port and the namespace it failed on. The REST read routes were fixed
 * first; then the rest of the doors turned out to answer `err.message` too — the admin routes, the data routes, the file
 * routes, the sync triggers, the acts the join and rename flows return `{ status, error }` from, and two stored texts that
 * are served later (a job's `lastError`, a sync cycle's error list). Some forty catches in thirty-odd files, found by
 * reading, which is how the forty-first gets missed. So this derives them (`_error-text-exits.mjs`): every catch scope in
 * every tracked server source, every use of the caught binding or of anything computed from it, and where the use GOES —
 * a response, an act's answer, a list of failures (ANY `.push(...)`, whatever the list is called: it was recognised by
 * the name `errors` until a bulk answer's `failed` went unseen), a function that writes a `lastError`.
 *
 * A use passes when it goes through a SANITIZER (`caughtFailureText`, the classifier `classifyReadFailure`, and every sender
 * derived from them: a function that takes `res` and calls one), or when it sits inside `err instanceof OwnClass` for a
 * class this repo declares. Anything else is an error's own words, unfiltered, going where a caller or a later reader
 * can see them. A reasoned exemption (`EXEMPT`) is allowed and is itself checked: it must still match an exit, and it
 * must say why the text cannot carry the driver's.
 *
 * ## What it concludes, stated rather than implied
 *
 * It reads SYNTAX. It does not follow a value through a function it cannot see into (`return text` from a helper that read
 * `err.message` is the helper's own catch, and is judged there), and it does not read a catch's use of the binding in a
 * LOG line — a log is where the driver's text is supposed to go. A response built from a binding other than the catch's
 * (a string held across an `await` in an outer variable) is not tracked. Those are named so a reader does not take
 * "clean" for "no door can answer a driver's text", only for "no catch we can read does".
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): every site in the failure message below — `res.status(500).json({ error: msg })` and its kin —
 * answers the text unfiltered, and no function named `caughtFailureText` exists.
 *
 * Run: node --test testing/standalone/an-error-reaches-a-caller-only-through-caughtFailureText.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { analyse } from './_error-text-exits.mjs';

/**
 * The sanitizers by NAME: the one function that renders an error for an answer, the classifier it is built on, and
 * `classifyCheckError`, which answers `/ready` with one of six CODE words (`CheckReason`) and never any of the text — the
 * rule it was written for, applied to the one route that has no caller to trust.
 */
const SANITIZERS = ['caughtFailureText', 'classifyReadFailure', 'classifyCheckError'];

/**
 * Sites that may answer an error's text unfiltered, keyed `file:line-free snippet`, each with the reason the text cannot
 * carry a driver's. A reason says what the value IS: "it is an id" is not one. Empty on the base; an exemption added is
 * a claim a reviewer reads.
 *
 * @type {Record<string, string>}
 */
const EXEMPT = {
  // The one place the driver's text IS the answer: a connection TEST of the URI an administrator just typed. The store it
  // names is the CANDIDATE, not this instance's own, and the whole point of the answer is why that URI did not connect.
  'server/src/db/conn-test.ts: error: err instanceof Error ? err.message : String(err)':
    'the text is about the candidate Mongo URI an administrator (MFA) typed to be tested, not this instance\'s store: '
    + 'the reason it did not connect is the answer the test exists to give, and the host in it is the one they supplied',
  // Collected failures that are only ever JOINED INTO A LOG LINE: the list is local, never returned, answered or stored.
  'server/src/brain/links-convert-on-boot.ts: failures.push(`${space.id} (${err instanceof Error ? err.message : String(err)})`)':
    'the boot link conversion collects each failed space\'s text in a local array that is only joined into one log.error '
    + 'line; it is never returned, answered or stored, and a log is where the driver\'s text is supposed to go',
  'server/src/brain/suppression-sweep.ts: failed.push(`${kind} (${err instanceof Error ? err.message : String(err)})`)':
    'the sweep collects each failed kind\'s text and throws it once; its only callers (sweepLatestMeta and the boot walk) '
    + 'log it through peerText and never answer or store it, and a log is where the driver\'s text is supposed to go',
  // A separate process with no store: it never opens a database, so no error it catches can be a driver's.
  'server/src/local-agent-connector/index.ts: res.status(500).json({ error: msg })':
    'the local agent connector is a separate process that never connects to MongoDB (it drives cloudflared on the '
    + 'operator\'s machine), so the error it answers cannot be a driver\'s, and importing the classifier would load the driver into it',
};

const sources = new Map(trackedSources('server/src', { floor: 400, specs: false })
  .map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));
/** The predicate a failure's text is decided by: a function that asks it has decided what to say. */
const DECIDERS = ['isDriverSide'];
const { exits, env } = analyse(sources, { sanitizers: SANITIZERS, deciders: DECIDERS });
const keyOf = e => `${e.file}: ${e.text}`;

describe('the derivation works', () => {
  it('read every server source and found the catches and their exits (floors)', () => {
    assert.ok(sources.size >= 400, `only ${sources.size} sources read`);
    assert.ok(exits.length >= 40, `only ${exits.length} places an error\'s text leaves a catch — the derivation is broken, not the code`);
    const forms = new Set(exits.map(e => e.form));
    for (const form of ['response', 'act answer', 'failure list', 'stored failure']) {
      assert.ok(forms.has(form), `no exit of the form "${form}" found anywhere — the walk has stopped seeing it`);
    }
    assert.ok(new Set(exits.map(e => e.file)).size >= 20, 'the exits sit in fewer than twenty files');
  });

  it('derived the stored-failure writers and the classes the repo declares', () => {
    assert.ok([...env.writers.keys()].length >= 2, `only ${[...env.writers.keys()]} write a lastError — expected the embed and media job failures`);
    assert.ok(env.ownClasses.size >= 20, `only ${env.ownClasses.size} classes declared under server/src`);
  });

  it('caughtFailureText is a top-level function of the server — the sanitizer the rule names exists', () => {
    assert.ok(env.functions.has('caughtFailureText'), 'no top-level function `caughtFailureText` under server/src');
  });
});

describe('every exit of an error\'s text passes through a sanitizer, is one of our own errors, or is exempt with a reason', () => {
  it('no catch answers, returns or stores an error\'s text unfiltered', () => {
    const flagged = exits.filter(e => e.flagged && !(keyOf(e) in EXEMPT));
    const byFile = new Map();
    for (const e of flagged) byFile.set(e.file, [...(byFile.get(e.file) ?? []), `    :${e.line}  [${e.form}] ${e.text}`]);
    const report = [...byFile].sort().map(([f, lines]) => `  ${f}\n${lines.join('\n')}`).join('\n');
    assert.equal(flagged.length, 0,
      `${flagged.length} exit(s) in ${byFile.size} file(s) put a caught error's own text where a caller or a later reader can see it, `
      + 'without caughtFailureText — a driver error\'s text names the host, the port and the namespace. Wrap each in '
      + `caughtFailureText(err, '<what was being done>'), or exempt it with the reason its text cannot be the driver's:\n${report}`);
  });

  it('every exemption is live and reasoned', () => {
    const keys = new Set(exits.map(keyOf));
    for (const [key, why] of Object.entries(EXEMPT)) {
      assert.ok(keys.has(key), `the exemption "${key}" matches no exit any more — delete it`);
      assert.ok(typeof why === 'string' && why.length >= 40, `${key}: give the reason the text cannot carry the driver's`);
    }
  });
});

describe('the walk sees each form — each seen red on a fixture, and each negative control passes', () => {
  /** One file of source, analysed alone with the same sanitizers. */
  const flaggedIn = (src, extra = {}) => analyse(new Map([['fixture.ts', src], ...Object.entries(extra)]),
    { sanitizers: SANITIZERS, deciders: DECIDERS }).exits.filter(e => e.flagged).map(e => e.form);
  const populationIn = (src) => analyse(new Map([['fixture.ts', src]]), { sanitizers: SANITIZERS, deciders: DECIDERS }).exits.length;

  const FORMS = {
    'a response built from err.message': 'async function h(req, res) { try { await f(); } catch (err) { res.status(500).json({ error: err.message }); } }',
    'a response built from an alias of it': 'async function h(req, res) { try { await f(); } catch (err) { const msg = err instanceof Error ? err.message : String(err); res.status(400).json({ error: msg }); } }',
    'a response with the error in a template': 'async function h(req, res) { try { await f(); } catch (err) { res.status(502).json({ error: `bootstrap failed: ${err}` }); } }',
    'a response from a .catch callback': 'function h(req, res) { f().catch(err => res.status(500).json({ error: err.message })); }',
    'a response from a .catch callback with a block': 'function h(req, res) { f().catch((e) => { res.status(500).send(`# failed: ${e.message}`); }); }',
    'an act answering { status, error }': 'async function act() { try { await f(); } catch (err) { return { status: 502, error: `Could not reach the publisher: ${err}` }; } }',
    'a sender handed res and the text': 'function sendIt(res, status, text) { res.status(status).json({ error: text }); }\nasync function h(req, res) { try { await f(); } catch (err) { sendIt(res, 500, err.message); } }',
    'a failure pushed onto errors': 'async function cycle() { const errors = []; try { await f(); } catch (err) { errors.push(`Sync failed: ${String(err)}`); } return errors; }',
    'a failure pushed onto a list with any name, as an object (a bulk answer\'s `failed`)': 'async function bulk(ids) { const failed = []; for (const id of ids) { try { await f(id); } catch (err) { failed.push({ id, error: err instanceof Error ? err.message : "Unknown error" }); } } return failed; }',
    'a failure pushed onto a list named for something else': 'async function walk() { const unreadable = []; try { await f(); } catch (err) { unreadable.push(`${err}`); } return unreadable; }',
    'a failure pushed after String(err) held in an alias': 'async function walk() { const out = []; try { await f(); } catch (err) { const why = String(err); out.push({ why }); } return out; }',
    'a failure pushed onto errorMessages': 'async function cycle() { const errorMessages = []; try { await f(); } catch (err) { const errMsg = `failed: ${err}`; errorMessages.push(errMsg); } }',
    'a stored lastError, through the function that writes it':
      'async function failJob(id, errorMessage) { await jobs.updateOne({ _id: id }, { $set: { lastError: errorMessage } }); }\nasync function run() { try { await f(); } catch (err) { await failJob(1, err instanceof Error ? err.message : String(err)); } }',
    'a stored lastError with the shorthand property':
      'async function failEmbed(id, errorMessage) { const lastError = errorMessage.slice(0, 500); await jobs.updateOne({ _id: id }, { $set: { lastError } }); }\nasync function run() { try { await f(); } catch (e) { const msg = e.message; await failEmbed(2, msg); } }',
  };
  for (const [form, src] of Object.entries(FORMS)) {
    it(`flags ${form}`, () => assert.ok(flaggedIn(src).length > 0, `the walk did not flag: ${src}`));
  }

  const CLEAN = {
    'a response through caughtFailureText': 'async function h(req, res) { try { await f(); } catch (err) { res.status(500).json({ error: caughtFailureText(err, "doing f") }); } }',
    'an alias made by caughtFailureText': 'async function h(req, res) { try { await f(); } catch (err) { const msg = caughtFailureText(err, "doing f"); res.status(500).json({ error: msg }); } }',
    'a response through the classifier': 'async function h(req, res) { try { await f(); } catch (err) { const r = classifyReadFailure(err); res.status(r.status).json({ error: r.error }); } }',
    'a stored text made by caughtFailureText':
      'async function failJob(id, errorMessage) { await jobs.updateOne({ _id: id }, { $set: { lastError: errorMessage } }); }\nasync function run() { try { await f(); } catch (err) { await failJob(1, caughtFailureText(err, "run")); } }',
    'a failure pushed after caughtFailureText': 'async function cycle() { const errors = []; try { await f(); } catch (err) { errors.push(`failed: ${caughtFailureText(err, "cycle")}`); } return errors; }',
    'one of our own errors, narrowed':
      'class Refusal extends Error {}\nasync function h(req, res) { try { await f(); } catch (err) { if (err instanceof Refusal) { res.status(400).json({ error: err.message }); return; } throw err; } }',
    'one of our own errors, in a conditional':
      'class Refusal extends Error {}\nasync function h(req, res) { try { await f(); } catch (err) { res.status(400).json({ error: err instanceof Refusal ? err.message : "Internal error" }); } }',
    'a failure pushed onto any list after caughtFailureText': 'async function bulk(ids) { const failed = []; for (const id of ids) { try { await f(id); } catch (err) { failed.push({ id, error: caughtFailureText(err, "resolve") }); } } return failed; }',
    'a push that does not read the error': 'async function walk() { const seen = []; try { await f(); } catch (err) { seen.push("f failed"); } return seen; }',
    'the error only logged': 'async function h(req, res) { try { await f(); } catch (err) { log.warn(`failed: ${err}`); res.status(500).json({ error: "Internal error" }); } }',
  };
  for (const [form, src] of Object.entries(CLEAN)) {
    it(`passes ${form}`, () => assert.deepEqual(flaggedIn(src), [], `the walk flagged: ${src}`));
  }

  it('a sender derived from a sanitizer is a sanitizer: calling it with the error passes', () => {
    const src = 'function sendCaught(res, err, op) { res.status(500).json({ error: caughtFailureText(err, op) }); }\n'
      + 'async function h(req, res) { try { await f(); } catch (err) { sendCaught(res, err, "doing f"); } }';
    assert.deepEqual(flaggedIn(src), []);
  });

  it('a text-maker that decides with isDriverSide is a sanitizer: storing what it returns passes', () => {
    const src = [
      'function storedText(err) { return isDriverSide(err) ? "The store could not complete this request." : String(err.message); }',
      'async function failJob(id, errorMessage) { await jobs.updateOne({ _id: id }, { $set: { lastError: errorMessage } }); }',
      'async function run() { try { await f(); } catch (err) { await failJob(1, storedText(err)); } }',
    ].join('\n');
    assert.deepEqual(flaggedIn(src), []);
  });

  it('a sanitizing sender is counted in the population, so a floor over it notices the walk going blind', () => {
    const src = [
      'function sendCaught(res, err, op) { res.status(500).json({ error: caughtFailureText(err, op) }); }',
      'async function h(req, res) { try { await f(); } catch (err) { sendCaught(res, err, "doing f"); } }',
    ].join('\n');
    assert.equal(populationIn(src), 1, 'the sender call is not in the population');
  });

  it('the builtin Error is no proof of ownership: err instanceof Error still answers the driver\'s text', () => {
    const src = 'async function h(req, res) { try { await f(); } catch (err) { if (err instanceof Error) { res.status(500).json({ error: err.message }); } } }';
    assert.ok(flaggedIn(src).length > 0);
  });

  it('a clean fixture still COUNTS in the population (a sanitized use is seen, not skipped)', () => {
    assert.ok(populationIn(CLEAN['a response through caughtFailureText']) >= 1,
      'a use through the sanitizer is not in the population, so a floor over it could never notice the walk going blind');
  });
});
