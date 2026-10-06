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
 * the name `errors` until a bulk answer's `failed` went unseen), any array element or object property VALUE that reads the
 * text, wherever the literal goes (the quota's `unreadable: [\`dbStats: ${err.message}\`]` went unseen as it was neither a
 * response nor a push), a function that writes a `lastError`.
 *
 * A use passes when it goes through a SANITIZER (`caughtFailureText`, the classifier `classifyReadFailure`, and every sender
 * derived from them: a function that takes `res` and calls one), or when it sits inside `err instanceof OwnClass` for a
 * class this repo declares. Anything else is an error's own words, unfiltered, going where a caller or a later reader
 * can see them. A reasoned exemption (`EXEMPT`) is allowed and is itself checked: it must still match an exit, and it
 * must say why the text cannot carry the driver's.
 *
 * ## What it concludes, stated rather than implied
 *
 * It reads SYNTAX. A function that RETURNS a caught error's text is followed to its callers by name (a text-maker, and
 * whoever returns its result), and a property assignment of the text onto an object (`run.error = …`) is an exit; what is
 * not followed is a value through a function it cannot see into (`return handle(err)` is not a text-maker: whether `handle`
 * hands the text back is `handle`'s own catch), and a catch's use of the binding in a LOG line — a log is where the
 * driver's text is supposed to go. A response built from a binding other than the catch's (a string held across an `await`
 * in an outer variable) is not tracked. Those are named so a reader does not take "clean" for "no door can answer a
 * driver's text", only for "no catch we can read does".
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): every site in the failure message below — `res.status(500).json({ error: msg })` and its kin —
 * answers the text unfiltered, and no function named `caughtFailureText` exists.
 *
 * On the code before 74adf3cb (5.6.4 part 1), one revert at a time, by hand: `firstMissingEnd` in `brain/bulk.ts`
 * returning `err.message` (a returned text, pushed into a batch's `errors` by its caller), `run.error = err.message` in
 * `extractor/ingest.ts` (a property assignment, served by `ingest_status`) and `delivery.error = err.message` in
 * `webhooks/dispatcher.ts` (the same, kept in the delivery history). Each is the only flag the gate reports after its revert.
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
  'server/src/brain/suppression-sweep.ts: failed.push(`${kind} (${messageOf(err)})`)':
    'the sweep collects each failed kind\'s text and throws it once; its only callers (sweepLatestMeta and the boot walk) '
    + 'log it through peerText and never answer or store it, and a log is where the driver\'s text is supposed to go',
  // A number, never a message: the HTTP status an embedding endpoint answered, read off the error as a metric label.
  'server/src/brain/embedding.ts: status: String((err as EmbeddingHttpError).status)':
    'the value is the HTTP status NUMBER of an embedding endpoint\'s refusal, used as a metric label; it is read off the '
    + 'error but is not a message and carries no host, port or namespace',
  // The same, as a value that is checked to be a number before it is kept.
  'server/src/config/assist-backend.ts: status':
    'the value is the HTTP status of the failed assist call, kept only when `typeof raw === \'number\'` and handed to the '
    + 'outcome recorder as a number; it is read off the error but is not its message',
  // The error OBJECT handed back to the one caller that asked for the outcome of a space's step.
  'server/src/spaces/space-step.ts: error':
    'the value is the caught error OBJECT, not its text, returned to the caller that ran the step: the init walk and the embed queue '
    + 'read only `ok`, the legacy sweep ignores the result, and the manual scan renders it through caughtFailureText for its answer; '
    + 'the text the step itself writes is a log line, where the driver\'s text is supposed to go',
  // Matched against a regexp and never leaves the function.
  'server/src/files/media/audio-embedder.ts: stderr: String(err)':
    'the text is ffmpeg\'s own stderr, returned to the one line that matches it against a Duration regexp inside this '
    + 'function; it is never answered, stored or logged, and ffmpeg is a local binary that never touches the store',
  // Read by the probe's own caller, which only logs it.
  'server/src/spaces/vector-index.ts: error':
    'the probe outcome\'s text is read by the index-readiness wait, which only joins it into log lines through peerText and '
    + 'into its `lastSeen` log text; it is never answered or stored, and a log is where the driver\'s text is supposed to go',
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

  it('the senders and text-makers the read routes and the stored records answer through are DERIVED sanitizers', () => {
    // `sendReadFailure(res, where, err)` calls `classifyAndReportFailure`, which calls the named classifier: it is a sanitizer
    // only because the derivation holds it to the rule (nothing it does with `err` lets the text out) and it passes. If it
    // stopped being one, every route answering through it would be flagged as a sender handing `err` to something unknown.
    for (const name of ['sendReadFailure', 'classifyAndReportFailure', 'storedFailureText']) {
      assert.ok(env.derived.has(name), `${name} is not a derived sanitizer — it leaks its error parameter, or is no longer found`);
    }
    assert.ok(exits.some(e => e.form === 'sanitized sender' && /\bsendReadFailure\(/.test(e.text)),
      'no route answers through sendReadFailure in a catch — the real-tree case of a derived sender has gone unseen');
  });

  it('the stored-record forms are in the population (an ingest run\'s and a delivery\'s `error`)', () => {
    const assignments = exits.filter(e => e.form === 'property assignment');
    assert.ok(assignments.length >= 2, `only ${assignments.length} property assignments of a caught error's text found`);
    assert.ok(assignments.every(e => !e.flagged), 'a property assignment of the error\'s text is unfiltered');
    for (const file of ['server/src/extractor/ingest.ts', 'server/src/webhooks/dispatcher.ts']) {
      assert.ok(assignments.some(e => e.file === file), `no property assignment of a caught error's text is seen in ${file}`);
    }
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

  /** A helper whose catch RETURNS the error's text (the `firstMissingEnd` shape), then a caller written after it. */
  const FIRST_MISSING = 'async function firstMissing(ends) { for (const e of ends) { try { await f(e); } catch (err) { return err instanceof Error ? err.message : String(err); } } return null; }\n';
  const TEXT_MAKER = caller => FIRST_MISSING + caller;
  const TEXT_MAKER_CALLER = body => TEXT_MAKER(
    `async function bulk(items) { const errors = []; for (const i of items) { const missing = await firstMissing([i]); if (missing) { ${body} } } return errors; }`);

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
    'an array literal holding the text (the quota shape)': 'async function measure() { try { await f(); } catch (err) { return { bytes: 0, unreadable: [`dbStats: ${err.message}`] }; } }',
    'an object literal assigned and returned later': 'async function probe() { try { await f(); } catch (err) { const out = { ok: false, detail: err instanceof Error ? err.message : String(err) }; return out; } }',
    'a literal handed to a function that is not a logger': 'async function probe() { try { await f(); } catch (err) { record({ detail: String(err) }); } }',
    'the shorthand of an alias': 'async function probe() { try { await f(); } catch (err) { const detail = err.message; return { detail }; } }',
    'a literal in a .catch callback': 'function probe() { return f().catch(err => ({ ok: false, detail: err.message })); }',
    'a failure pushed onto errorMessages': 'async function cycle() { const errorMessages = []; try { await f(); } catch (err) { const errMsg = `failed: ${err}`; errorMessages.push(errMsg); } }',
    'a stored lastError, through the function that writes it':
      'async function failJob(id, errorMessage) { await jobs.updateOne({ _id: id }, { $set: { lastError: errorMessage } }); }\nasync function run() { try { await f(); } catch (err) { await failJob(1, err instanceof Error ? err.message : String(err)); } }',
    'a stored lastError with the shorthand property':
      'async function failEmbed(id, errorMessage) { const lastError = errorMessage.slice(0, 500); await jobs.updateOne({ _id: id }, { $set: { lastError } }); }\nasync function run() { try { await f(); } catch (e) { const msg = e.message; await failEmbed(2, msg); } }',
    'a property assignment onto a run record (ingest_status)':
      'async function runIngest(run) { try { await f(); } catch (err) { run.phase = "failed"; run.error = err instanceof Error ? err.message : String(err); } }',
    'a property assignment onto a delivery kept in the history':
      'async function attempt(delivery) { try { await f(); } catch (err) { delivery.error = `${err}`; } }',
    'a property assignment through an element access':
      'async function probe(out) { try { await f(); } catch (err) { out["why"] = String(err); } }',
    'a property assignment of an alias':
      'async function probe(rec) { try { await f(); } catch (err) { const why = err.message; rec.detail = why; } }',
    'a text returned by a helper, pushed by its caller (a bulk edge end)': TEXT_MAKER_CALLER('errors.push({ index: i, reason: missing });'),
    'a text returned by a helper, answered by its caller':
      TEXT_MAKER('async function h(req, res) { const why = await firstMissing([1]); if (why) { res.status(400).json({ error: why }); } }'),
    'a text returned by a helper, stored by its caller':
      TEXT_MAKER('async function failJob(id, errorMessage) { await jobs.updateOne({ _id: id }, { $set: { lastError: errorMessage } }); }\n'
        + 'async function run() { const why = await firstMissing([1]); await failJob(1, why); }'),
    'a text returned through a second helper':
      TEXT_MAKER('async function wrapped(ends) { return await firstMissing(ends); }\n'
        + 'async function bulk() { const errors = []; const why = await wrapped([1]); errors.push({ reason: why }); return errors; }'),
    'a text returned by a method, called as this.method()':
      'class B { async check(x) { try { await f(x); } catch (err) { return err.message; } return null; }\n'
        + '  async run(xs) { const failed = []; for (const x of xs) { const why = await this.check(x); if (why) failed.push({ x, why }); } return failed; } }',
    'a helper that logs through caughtFailureText and returns the raw text':
      'function describe(err, op) { log.warn(`${op}: ${caughtFailureText(err, op)}`); return err.message; }\n'
        + 'async function h(req, res) { try { await f(); } catch (err) { res.status(500).json({ error: describe(err, "doing f") }); } }',
    'a helper that calls caughtFailureText and discards what it said':
      'function describe(err, op) { caughtFailureText(err, op); return { detail: String(err) }; }\n'
        + 'async function h(req, res) { try { await f(); } catch (err) { res.status(500).json(describe(err, "doing f")); } }',
    'the true arm of a NEGATED own-class test (the error is not ours there)':
      'class Refusal extends Error {}\nasync function h(req, res) { try { await f(); } catch (err) { if (!(err instanceof Refusal)) { res.status(500).json({ error: err.message }); } } }',
    'the else arm of an own-class test':
      'class Refusal extends Error {}\nasync function h(req, res) { try { await f(); } catch (err) { if (err instanceof Refusal) { log.warn("refused"); } else { res.status(500).json({ error: err.message }); } } }',
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
    'a log.warn with the error text in a literal': 'async function probe() { try { await f(); } catch (err) { log.warn("probe failed", { detail: err.message, parts: [String(err)] }); } }',
    'reportDriverFailure with the text': 'async function probe() { try { await f(); } catch (err) { reportDriverFailure("probe", { detail: err.message }); } }',
    'caughtFailureText inside an array literal': 'async function measure() { try { await f(); } catch (err) { return { unreadable: [`dbStats: ${caughtFailureText(err, "measure")}`] }; } }',
    'caughtFailureText inside an object literal': 'async function probe() { try { await f(); } catch (err) { return { detail: caughtFailureText(err, "probe") }; } }',
    'a boolean made of the error (instanceof)': 'async function probe() { try { await f(); } catch (err) { const unreadable = err instanceof Foo; return { status: unreadable ? "failed" : "skipped" }; } }',
    'a boolean made of the error (regexp test)': 'async function probe() { try { await f(); } catch (err) { const m = String(err.message); return { permanent: RE.test(m) }; } }',
    'one of our own errors, after a guard that throws for any other': 'class Refusal extends Error { check = 1 }\nasync function h() { try { await f(); } catch (err) { if (!(err instanceof Refusal)) throw err; const c = err.check; return { message: c.message, text: `Error: ${c.message}` }; } }',
    'a push that does not read the error': 'async function walk() { const seen = []; try { await f(); } catch (err) { seen.push("f failed"); } return seen; }',
    'the error only logged': 'async function h(req, res) { try { await f(); } catch (err) { log.warn(`failed: ${err}`); res.status(500).json({ error: "Internal error" }); } }',
    'a property assignment through caughtFailureText': 'async function runIngest(run) { try { await f(); } catch (err) { run.error = caughtFailureText(err, "ingest a conversation"); } }',
    'a property assignment of text that is not the error\'s': 'async function runIngest(run) { try { await f(); } catch (err) { run.phase = "failed"; run.error = "ingest failed"; } }',
    'a text returned through caughtFailureText, pushed by its caller':
      'async function firstMissing(ends) { for (const e of ends) { try { await f(e); } catch (err) { return caughtFailureText(err, "resolve"); } } return null; }\n'
        + 'async function bulk(items) { const errors = []; for (const i of items) { const missing = await firstMissing([i]); if (missing) errors.push({ index: i, reason: missing }); } return errors; }',
    'a text returned by a helper whose caller only logs it':
      TEXT_MAKER('async function bulk(items) { for (const i of items) { const missing = await firstMissing([i]); if (missing) log.warn(`edge ${i}: ${missing}`); } }'),
    'a text returned by a helper that is an own error, narrowed':
      'class Refusal extends Error {}\nasync function check(x) { try { await f(x); } catch (err) { if (err instanceof Refusal) return err.message; throw err; } return null; }\n'
        + 'async function bulk(xs) { const errors = []; for (const x of xs) { const why = await check(x); if (why) errors.push({ x, why }); } return errors; }',
    'a returned call that only takes the error (it does not return its text)':
      'async function swallow(err) { log.warn(String(err)); return []; }\nasync function one(x) { try { return await f(x); } catch (err) { return swallow(err); } }\n'
        + 'async function many(xs) { const out = []; for (const x of xs) out.push(...await one(x)); return out; }',
    'a helper that returns only what caughtFailureText said':
      'function describe(err, op) { return caughtFailureText(err, op); }\nasync function h(req, res) { try { await f(); } catch (err) { res.status(500).json({ error: describe(err, "doing f") }); } }',
    'the class and the code of a failure (they are labels, not its message)':
      'async function h(req, res) { try { await f(); } catch (err) { res.status(500).json({ error: `${err.name} ${err.code}`, codeName: err.codeName }); } }',
    'the else arm of a negated own-class test':
      'class Refusal extends Error {}\nasync function h(req, res) { try { await f(); } catch (err) { if (!(err instanceof Refusal)) { log.warn("not ours"); } else { res.status(400).json({ error: err.message }); } } }',
    'a guard that returns for a driver-side failure narrows what follows':
      'async function h(req, res) { try { await f(); } catch (err) { if (isDriverSide(err)) { res.status(503).json({ error: "The store could not complete this request." }); return; } res.status(400).json({ error: err.message }); } }',
    'a text-maker that decides with isDriverSide, in either arm':
      'function textOf(err) { if (!isDriverSide(err)) return err.message; return "The store could not complete this request."; }\nasync function h(req, res) { try { await f(); } catch (err) { res.status(400).json({ error: textOf(err) }); } }',
  };
  for (const [form, src] of Object.entries(CLEAN)) {
    it(`passes ${form}`, () => assert.deepEqual(flaggedIn(src), [], `the walk flagged: ${src}`));
  }

  const envOf = src => analyse(new Map([['fixture.ts', src]]), { sanitizers: SANITIZERS, deciders: DECIDERS }).env;

  it('a helper that logs through caughtFailureText and returns the raw text is NOT a sanitizer', () => {
    const env = envOf('function describe(err, op) { log.warn(`${op}: ${caughtFailureText(err, op)}`); return err.message; }');
    assert.ok(!env.sanitizers.has('describe'), 'a helper that returns the error\'s own text was derived to be a sanitizer');
  });

  it('a helper that returns only what caughtFailureText said, and a sender built on one, ARE sanitizers', () => {
    const env = envOf([
      'function describe(err, op) { return caughtFailureText(err, op); }',
      'function sendDescribed(res, err, op) { res.status(500).json({ error: describe(err, op) }); }',
    ].join('\n'));
    assert.ok(env.sanitizers.has('describe') && env.sanitizers.has('sendDescribed'), `derived: ${[...env.sanitizers]}`);
  });

  it('a function that takes no error is not a sanitizer, however many it calls', () => {
    const env = envOf('function start() { return caughtFailureText(new Error("x"), "start"); }');
    assert.ok(!env.sanitizers.has('start'));
  });

  it('a function whose catch returns the error\'s text is a text-maker, and so is one that returns a text-maker\'s result', () => {
    const env = envOf(`${FIRST_MISSING}async function wrapped(ends) { return await firstMissing(ends); }`);
    assert.ok(env.textMakers.has('firstMissing') && env.textMakers.has('wrapped'), `derived: ${[...env.textMakers]}`);
  });

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
