/**
 * A store failure is answered in OUR words — never the driver's — at the status the release line already answered it with
 * (`Q-361`: main's bundle-30 I8/I12 security fix, carried to 5.6.x with the statuses it does NOT change).
 *
 * ## The rule
 *
 * A driver's own error names the host, the port and the namespace it failed on (`connection 5 to 172.16.0.9:27017
 * closed`, `getaddrinfo ENOTFOUND mongo-a.internal`). The REST read routes and the MCP dispatcher answered it, whole, to
 * whoever asked — and the global handler cannot tell an operator from an anonymous caller, so the only safe rule is one
 * answer for every audience. The operator still reads the text: it is logged, once, where the failure was caught.
 *
 * What an answer says about a store failure is one of exactly three sentences:
 *
 *  1. **store-side** (the driver could not reach, select, or finish on the store — a socket, a selection, a topology, a
 *     step-down, a deadline): the existing retry wording, `503`, `retryable: true`, `Retry-After`;
 *  2. **`The store is not available right now.`**: a pooled connection cleared under a command (`MongoPoolClearedError`) —
 *     at the `400` the release line gave it. It says no "try again", because `retryable` is `false` there; main's `503`
 *     is the change the patch does not take (D-10: fixes only);
 *  3. **`The store could not complete this request.`**: any other driver-side failure with no server answer, and the
 *     server codes a router or a member reports WITH an address in the text (`HostUnreachable` 6, `HostNotFound` 7, `89`,
 *     `9001`, `10107`, `13435`, `134`) — each at the status it already had.
 *
 * What the SERVER answered (`MongoServerError`: a malformed query, a failed validation, an unlisted code) keeps its own
 * words at its own status: they name a namespace and a value, not a host, and a caller fixes their request from them.
 * And OUR errors keep their text — the point of the fix is that the answer is decided by what an error IS (a class, a
 * chain of `cause`s), not by words in its message: an own refusal that quotes `notes/mongot-setup.md` is no longer a
 * retryable store failure.
 *
 * ## Pins (green on the base, kept — the statuses the patch must not change)
 *
 * Every by-name store class answers `503`; every by-code server error the classifier lists answers `503`; every other driver class and
 * every unlisted server code answers `400`; our own error answers `400` with its text. Built from real driver classes.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): the `503` body is the driver's message plus its cause (`message + errmsg + codeName + cause`), the
 * `400` body is `message` for every driver class, `sendReadFailure` logs nothing, an own text naming `mongot` answers
 * `503`, and `isDriverSide` / `caughtFailureText` do not exist.
 *
 * Run: node --test testing/standalone/a-store-failure-says-nothing-of-the-driver.test.js  (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOST_TEXT, LEAK, SENTENCES, STORE_SIDE, STORE_SIDE_NAMES, STORE_CODES, ADDRESS_CODES, SERVER_REFUSALS, addressError,
  wrappers, driverSideErrors, serverError, wrapping,
  moduleExporting, sendReadFailureOf, driver,
} from './_store-failure-fixtures.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const { classifyReadFailure } = await import('../../server/dist/brain/store-failure.js');
const refs = await import('../../server/dist/brain/entity-refs.js');

const DRIVER_SIDE = driverSideErrors();
const WRAPPERS = await wrappers();

const answer = (err) => classifyReadFailure(err);

describe('the derivation works', () => {
  it('built a real driver instance of every class that is not a server\'s answer (the floor is asserted by the derivation)', () => {
    for (const name of [...STORE_SIDE_NAMES, 'MongoPoolClearedError']) {
      assert.ok(DRIVER_SIDE.some(d => d.name === name), `the driver exports no class named ${name} that takes a message — re-anchor`);
    }
    for (const { name, make } of DRIVER_SIDE) assert.ok(make() instanceof driver.MongoError, `${name} is not a MongoError`);
  });
});

describe('every driver-side failure is answered without the driver\'s text', () => {
  for (const { name, make } of DRIVER_SIDE) {
    it(`${name}: the answer carries none of the text, and says one of our sentences`, () => {
      const f = answer(make());
      assert.doesNotMatch(f.error, LEAK, `the answer carries the driver's text: ${f.error}`);
      const ours = f.error === SENTENCES.unavailable || f.error === SENTENCES.incomplete || STORE_SIDE.test(f.error);
      assert.ok(ours, `the answer is none of our three sentences: ${f.error}`);
    });
  }

  it('PIN: the five store classes answer 503, retryable, with a Retry-After; every other driver class answers 400, not retryable', () => {
    const wrong = [];
    for (const { name, make } of DRIVER_SIDE) {
      const f = answer(make());
      const storeSide = STORE_SIDE_NAMES.includes(name);
      if (f.status !== (storeSide ? 503 : 400)) wrong.push(`${name}: status ${f.status}`);
      if (f.retryable !== storeSide) wrong.push(`${name}: retryable ${f.retryable}`);
      if (storeSide && !(f.retryAfterSeconds > 0)) wrong.push(`${name}: no retryAfterSeconds`);
    }
    assert.deepEqual(wrong, [], 'a status the release line already answered changed — a patch fixes the text, never the status');
  });

  it('a pooled connection cleared under a command is "not available right now", at the 400 it had', () => {
    const f = answer(DRIVER_SIDE.find(d => d.name === 'MongoPoolClearedError').make());
    assert.equal(f.status, 400);
    assert.equal(f.retryable, false);
    assert.equal(f.error, SENTENCES.unavailable);
  });

  it('every other driver-side class that answers 400 says "could not complete this request"', () => {
    const wrong = DRIVER_SIDE.filter(d => !STORE_SIDE_NAMES.includes(d.name) && d.name !== 'MongoPoolClearedError')
      .filter(d => answer(d.make()).error !== SENTENCES.incomplete).map(d => d.name);
    assert.deepEqual(wrong, []);
  });

  it('the store-side answer says it is retryable, in our words', () => {
    for (const name of STORE_SIDE_NAMES) {
      const f = answer(DRIVER_SIDE.find(d => d.name === name).make());
      assert.match(f.error, STORE_SIDE, `${name}: ${f.error}`);
    }
  });
});

describe('a server\'s answer', () => {
  for (const [code, codeName] of STORE_CODES) {
    it(`PIN: code ${code} (${codeName}) is a 503, retryable, with the store's code`, () => {
      const f = answer(serverError(code, codeName, `${codeName}: ${HOST_TEXT}`));
      assert.equal(f.status, 503);
      assert.equal(f.retryable, true);
      assert.equal(f.code, code, 'the store\'s code is stable and stays');
      assert.equal(f.codeName, codeName);
    });

    it(`code ${code} (${codeName}): the words are the store's, not the caller's — our retry sentence is the answer`, () => {
      const f = answer(serverError(code, codeName, `${codeName}: ${HOST_TEXT}`));
      assert.doesNotMatch(f.error, LEAK);
      assert.match(f.error, STORE_SIDE);
    });
  }

  it('an executor error — the reported condition, verbatim — is a 503 that says nothing of the namespace', () => {
    const f = answer(serverError(8, 'InternalError',
      'Executor error during aggregate command on namespace: ythril.fleet_facts :: caused by :: '));
    assert.equal(f.status, 503);
    assert.equal(f.retryable, true);
    assert.equal(f.code, 8);
    assert.equal(f.codeName, 'InternalError');
    assert.doesNotMatch(f.error, LEAK);
    assert.doesNotMatch(f.error, /fleet_facts/, 'the namespace is the driver\'s text');
    assert.doesNotMatch(f.error, /caused by ::\s*$/, 'a half sentence is not an answer');
  });

  for (const [code, codeName] of ADDRESS_CODES) {
    it(`code ${code} (${codeName}) names a member's address: the words go, the 400 stays`, () => {
      const f = answer(addressError(code, codeName));
      assert.equal(f.status, 400, 'a status the release line answered changed');
      assert.equal(f.retryable, false);
      assert.equal(f.error, SENTENCES.incomplete);
    });
  }

  for (const [code, codeName, errmsg] of SERVER_REFUSALS) {
    it(`PIN: code ${code} (${codeName}) keeps the server's own words at 400 — they are how a caller fixes the request`, () => {
      const f = answer(serverError(code, codeName, errmsg));
      assert.equal(f.status, 400);
      assert.equal(f.retryable, false);
      assert.equal(f.error, errmsg);
    });
  }
});

describe('our own error is answered as itself — what it says is ours to say', () => {
  const OWN_TEXTS = [
    'filter: unexpected property \'$where\'',
    'Space \'nope\' not found',
    // Words the store-failure regexes match, spoken by OUR code: a caller's file reference, a space id, an explanation.
    '`files` references 1 file that does not exist in space \'s\': "notes/mongot-setup.md". Create the record first.',
    'The vector search index for this space is being rebuilt; semantic recall is disabled until it finishes.',
    'Executor error during aggregate command is the phrase the store uses; this refusal quotes it.',
    'a $vectorSearch of the whole space was refused by the caller\'s own cap',
    'the $search stage is not allowed in a filter',
  ];
  for (const text of OWN_TEXTS) {
    for (const [kind, make] of [['an Error', t => new Error(t)], ['a ReferenceRefusal', t => new refs.ReferenceRefusal(t)]]) {
      it(`${kind} saying "${text.slice(0, 48)}…" is a 400, not retryable, in its own words`, () => {
        const f = answer(make(text));
        assert.equal(f.status, 400, 'an own refusal that merely NAMES the store is not a store failure');
        assert.equal(f.retryable, false);
        assert.equal(f.error, text);
      });
    }
  }

  it('the REST read answer says the same: 400, no Retry-After, its own words', async () => {
    const text = '`files` references 1 file that does not exist in space \'s\': "notes/mongot-setup.md".';
    const out = await sendReadFailureOf(new refs.ReferenceRefusal(text));
    assert.equal(out.status, 400);
    assert.equal(out.body.error, text);
    assert.equal(out.body.retryable, false);
    assert.equal(out.headers['retry-after'], undefined, 'a refusal the caller can fix must not invite a retry');
  });

  it('PIN: a non-Error throw does not crash the classifier', () => {
    assert.equal(answer('a string').status, 400);
    assert.equal(answer('a string').error, 'a string');
    for (const v of [null, undefined, 7, {}]) assert.equal(answer(v).status, 400);
  });
});

describe('our own capability refusal is still a store failure, in its own sentence', () => {
  /*
   * "$vectorSearch is not supported by the connected MongoDB" is OUR sentence about the STORE: it tells an operator
   * what to do (upgrade, use Atlas Local) and a caller to retry later. Narrowing the message patterns to errors the
   * DRIVER raised would turn it into an own refusal (400) — a status change — so it is a named case: our sentence, 503.
   * Read from the two throws themselves, not retyped, so a reworded one is the one asserted.
   */
  const capability = async (call) => { try { await call(); } catch (err) { return err; } assert.fail('the call did not throw'); };

  for (const [label, call] of [
    ['recall', async () => (await import('../../server/dist/brain/recall.js')).recall('x', 'q', 5)],
    ['find-similar', async () => (await import('../../server/dist/brain/recall.js')).findSimilar('x', 'id', 'entity')],
  ]) {
    it(`${label} on a store without vector search: 503, retryable, the actionable sentence kept`, async () => {
      const err = await capability(call);
      assert.match(err.message, /\$vectorSearch is not supported/, 'fixture check: not the capability error');
      const f = answer(err);
      assert.equal(f.status, 503, 'a status the release line answered changed');
      assert.equal(f.retryable, true);
      assert.match(f.error, /\$vectorSearch is not supported/, 'its own sentence is the answer');
      assert.match(f.error, /Upgrade to MongoDB 8\.2\+/, 'and the instruction in it');
      const out = await sendReadFailureOf(err);
      assert.equal(out.status, 503);
      assert.ok(Number(out.headers['retry-after']) > 0, 'a retryable 503 says when');
      assert.match(out.body.error, /Upgrade to MongoDB 8\.2\+/);
    });
  }
});

describe('a wrapper around a driver failure says nothing of the driver either', () => {
  /** Whether a text is one of our three sentences about a store failure. */
  const isOurs = (text) => text === SENTENCES.unavailable || text === SENTENCES.incomplete || STORE_SIDE.test(text);

  // Every way an error travels inside another (`cause`, `underlying`, `errorResponse`), each built by its own class: the
  // wrapper's text quotes the driver's, so a door that does not look through it answers the host.
  for (const { label, wrap } of WRAPPERS) {
    it(`the driver's failure carried in \`${label}\`: no host in the answer, and one of our sentences`, () => {
      const wrong = [];
      for (const { name, make } of DRIVER_SIDE) {
        const f = answer(wrap(make()));
        if (LEAK.test(f.error)) wrong.push(`${name}: carries the text — ${f.error}`);
        else if (!isOurs(f.error)) wrong.push(`${name}: ${f.error}`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  it('a wrapper two levels over a driver failure, in different fields, says nothing of it', () => {
    const inner = DRIVER_SIDE.find(d => d.name === 'MongoNetworkError').make();
    for (const outer of WRAPPERS.filter(w => w.carriesAnyError)) {
      for (const middle of WRAPPERS) {
        const f = answer(outer.wrap(middle.wrap(inner)));
        assert.doesNotMatch(f.error, LEAK, `${outer.label} over ${middle.label}: ${f.error}`);
      }
    }
  });

  it('PIN: a wrapper around a SERVER answer keeps the wrapper\'s own words (the server\'s text was never the leak)', () => {
    const f = answer(wrapping(serverError(11000, 'DuplicateKey', 'E11000 duplicate key'), 'the arrival could not be stored'));
    assert.equal(f.status, 400);
    assert.equal(f.error, 'the arrival could not be stored');
  });
});

describe('the REST read door: the answer, the status, the header, and the one log line', () => {
  for (const { name, make } of DRIVER_SIDE) {
    it(`${name}: no driver text in the body, the status the base gave it, and the text logged ONCE`, async () => {
      const err = make();
      const { lines, result: out } = await logLinesDuring(() => sendReadFailureOf(err));
      assert.doesNotMatch(JSON.stringify(out.body), LEAK, `the body carries the driver's text: ${JSON.stringify(out.body)}`);
      assert.equal(out.status, STORE_SIDE_NAMES.includes(name) ? 503 : 400);
      assert.equal(typeof out.body.retryable, 'boolean', '`retryable` is on every failure body');
      if (out.status === 503) assert.ok(Number(out.headers['retry-after']) > 0);
      const logged = lines.filter(l => l.includes('172.16.0.9') || l.includes('mongo-a.internal'));
      assert.equal(logged.length, 1, `the operator reads the driver's text once, in the log — logged: ${JSON.stringify(lines.map(l => l.slice(0, 120)))}`);
    });
  }

  // The body only: the log is reported once per window for each (operation, kind), and the cases above already spent it.
  for (const { label, wrap } of WRAPPERS) {
    it(`a driver failure carried in \`${label}\`: no driver text in the body of the REST read answer`, async () => {
      for (const name of ['MongoNetworkError', 'MongoServerSelectionError']) {
        const out = await sendReadFailureOf(wrap(DRIVER_SIDE.find(d => d.name === name).make()));
        assert.doesNotMatch(JSON.stringify(out.body), LEAK, `${name}: ${JSON.stringify(out.body)}`);
      }
    });
  }
});

describe('isDriverSide: one predicate, asked of what an error IS', () => {
  it('is exported by exactly one module', async () => { await moduleExporting('isDriverSide'); });

  it('is true for every driver class that is not a server\'s answer — whatever it is called', async () => {
    const isDriverSide = await moduleExporting('isDriverSide');
    const missed = DRIVER_SIDE.filter(d => isDriverSide(d.make()) !== true).map(d => d.name);
    assert.deepEqual(missed, []);
  });

  it('is false for a plain Error that is merely NAMED like a driver class — a name proves nothing', async () => {
    const isDriverSide = await moduleExporting('isDriverSide');
    for (const name of [...STORE_SIDE_NAMES, 'MongoPoolClearedError']) {
      assert.equal(isDriverSide(Object.assign(new Error(HOST_TEXT), { name })), false, `${name} on a plain Error`);
    }
  });

  it('is true for the server codes that report an address, false for the codes that carry a refusal', async () => {
    const isDriverSide = await moduleExporting('isDriverSide');
    for (const [code, codeName] of ADDRESS_CODES) assert.equal(isDriverSide(serverError(code, codeName, 'x')), true, `code ${code}`);
    for (const [code, codeName, errmsg] of SERVER_REFUSALS) assert.equal(isDriverSide(serverError(code, codeName, errmsg)), false, `code ${code}`);
  });

  it('is false for our own errors, and true when a driver failure sits anywhere in the chain of causes', async () => {
    const isDriverSide = await moduleExporting('isDriverSide');
    assert.equal(isDriverSide(new Error('mine')), false);
    assert.equal(isDriverSide(new refs.ReferenceRefusal('mine')), false);
    const inner = DRIVER_SIDE.find(d => d.name === 'MongoNetworkError').make();
    assert.equal(isDriverSide(wrapping(inner)), true);
    assert.equal(isDriverSide(wrapping(wrapping(wrapping(inner)))), true, 'three levels down');
    assert.equal(isDriverSide(wrapping(serverError(11000, 'DuplicateKey', 'E11000'))), false, 'a server answer in the chain is not the driver\'s own condition');
  });

  for (const { label, wrap } of WRAPPERS) {
    it(`a driver failure carried in \`${label}\` is driver-side; a server answer or an own error carried there is not`, async () => {
      const isDriverSide = await moduleExporting('isDriverSide');
      const missed = DRIVER_SIDE.filter(d => isDriverSide(wrap(d.make())) !== true).map(d => d.name);
      assert.deepEqual(missed, [], 'the walk of the chain does not follow this field');
      assert.equal(isDriverSide(wrap(serverError(11000, 'DuplicateKey', 'E11000'))), false, 'a server answer is not the driver\'s own condition');
      assert.equal(isDriverSide(wrap(new Error('mine'))), false, 'an own error is not the driver\'s');
    });
  }

  it('never throws, and ends on a cyclic or hostile chain', async () => {
    const isDriverSide = await moduleExporting('isDriverSide');
    const a = new Error('a'); a.cause = a;
    const b = new Error('b'); const c = new Error('c'); b.cause = c; c.cause = b;
    const hostile = new Proxy(new Error('h'), { get(t, k) { if (k === 'cause') throw new Error('trap'); return t[k]; } });
    for (const v of [a, b, hostile, null, undefined, 'x', 7, {}, { cause: 7 }]) {
      assert.doesNotThrow(() => isDriverSide(v), `threw on ${String(v)}`);
    }
    assert.equal(isDriverSide(a), false);
  });
});

describe('caughtFailureText: what a catch that answers an error\'s own text says instead', () => {
  const OPERATION = 'a test operation';

  it('is exported by exactly one module', async () => { await moduleExporting('caughtFailureText'); });

  it('an own error is its own text, unchanged — a validation refusal is the caller\'s to read', async () => {
    const caughtFailureText = await moduleExporting('caughtFailureText');
    for (const err of [new Error('Missing required fields: _id'), new refs.ReferenceRefusal('`ids` references 1 entity that does not exist'),
      new Error('the arrival mentions mongot-setup.md')]) {
      assert.equal(caughtFailureText(err, OPERATION), err.message);
    }
    assert.equal(caughtFailureText('a string', OPERATION), 'a string');
  });

  it('a server\'s refusal keeps its words; a driver-side failure says "could not complete", with none of the text', async () => {
    const caughtFailureText = await moduleExporting('caughtFailureText');
    assert.equal(caughtFailureText(serverError(51091, 'Location51091', 'Regular expression is invalid'), OPERATION), 'Regular expression is invalid');
    const wrong = [];
    for (const { name, make } of DRIVER_SIDE) {
      const text = caughtFailureText(make(), OPERATION);
      if (LEAK.test(text)) wrong.push(`${name}: carries the text — ${text}`);
      else if (text !== SENTENCES.incomplete && text !== SENTENCES.unavailable && !STORE_SIDE.test(text)) wrong.push(`${name}: ${text}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('any driver-side cause ANYWHERE in the chain gives the generic sentence — an own wrapper that quotes the driver is not "ours"', async () => {
    const caughtFailureText = await moduleExporting('caughtFailureText');
    for (const { name, make } of DRIVER_SIDE) {
      const text = caughtFailureText(wrapping(wrapping(make())), OPERATION);
      assert.doesNotMatch(text, LEAK, `${name} two wrappers down: ${text}`);
    }
  });

  for (const { label, wrap } of WRAPPERS) {
    it(`a driver failure carried in \`${label}\` gives one of our sentences, with none of the text`, async () => {
      const caughtFailureText = await moduleExporting('caughtFailureText');
      const wrong = [];
      for (const { name, make } of DRIVER_SIDE) {
        const text = caughtFailureText(wrap(make()), OPERATION);
        if (LEAK.test(text)) wrong.push(`${name}: carries the text — ${text}`);
        else if (text !== SENTENCES.incomplete && text !== SENTENCES.unavailable && !STORE_SIDE.test(text)) wrong.push(`${name}: ${text}`);
      }
      assert.deepEqual(wrong, []);
    });
  }

  it('logs the driver\'s text ONCE, at warn, naming the operation — and an own error logs nothing of its own', async () => {
    const caughtFailureText = await moduleExporting('caughtFailureText');
    const err = DRIVER_SIDE.find(d => d.name === 'MongoServerSelectionError').make();
    const { lines } = await logLinesDuring(() => caughtFailureText(err, OPERATION));
    const logged = lines.filter(l => l.includes('172.16.0.9'));
    assert.equal(logged.length, 1, `logged: ${JSON.stringify(lines)}`);
    assert.match(logged[0], /WARN/, 'the level an operator watches');
    assert.ok(logged[0].includes(`${OPERATION} failed`), `the line does not name the operation: ${logged[0]}`);
    const own = await logLinesDuring(() => caughtFailureText(new Error('Missing required fields'), OPERATION));
    assert.deepEqual(own.lines.filter(l => l.includes('172.16.0.9')), []);
  });

  it('never throws, whatever it is handed — it runs inside a catch', async () => {
    const caughtFailureText = await moduleExporting('caughtFailureText');
    const cyclic = new Error('c'); cyclic.cause = cyclic;
    const hostile = new Proxy(new Error('h'), { get(t, k) { if (k === 'message' || k === 'cause') throw new Error('trap'); return t[k]; } });
    for (const v of [cyclic, hostile, null, undefined, 7, {}, Symbol('s'), 10n ** 20n]) {
      let out;
      assert.doesNotThrow(() => { out = caughtFailureText(v, OPERATION); }, `threw on ${String(typeof v)}`);
      assert.equal(typeof out, 'string');
    }
  });
});
