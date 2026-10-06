/**
 * The first MongoDB connection retries a store that is not answering YET, and only that - on the ONE store-condition
 * predicate (`isStoreUnreachable`, `db/store-condition.ts`), not on a list of its own (`Q-329`, `Q-330`, bundle-53 G6).
 *
 * ## The failure this guards, finally diagnosed
 *
 * `ythril-* exited (1)` failed CI three times across a release and was carried as "still undiagnosed". The dead
 * container's own log said it in one line - `Fatal startup error: MongoNetworkError: read ECONNRESET` - because Compose
 * waits on the Mongo healthcheck, which passes while mongod is still finishing startup, so the very first connection has
 * its socket reset mid-handshake. One attempt, one rejection, exit 1, a healthy stack that never came up.
 *
 * ## Why the classifier is no longer in `mongo.ts`
 *
 * The boot retry kept an allowlist of four class NAMES and five server codes. A name list cannot see a subclass (a pool
 * cleared by a network failure is `MongoPoolClearedError`, a class the driver does not export), and it was one of three
 * answers to "can the store not be reached" that disagreed: the request path (`brain/store-failure.ts`) and the
 * housekeeping walk asked the same question of other lists. It is now `isStoreUnreachable`, so the set widens
 * deliberately (host unreachable, network timeout, not-writable-primary, a pool that is closed or out of connections, a
 * labelled error) and what waiting cannot cure stays fail-fast: AuthenticationFailed (18), a malformed URI, missing
 * credentials, and a plain `Error` that merely carries a store-looking name.
 *
 * ## What is read, and how
 *
 * Subjects are REAL driver errors (a real refused connection for the selection error; the driver's own classes, loaded
 * from its `cmap/errors.js`, for the pool's), never an object with a name. The loop is the real `connectMongo`, its
 * `MongoClient.prototype.connect` replaced to throw a given error (restored after every case), so no store has to be
 * up: this file is `pure`.
 *
 * Run: node --test testing/standalone/mongo-connect-retry.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { MongoClient, MongoNetworkError, MongoNetworkTimeoutError, MongoParseError, MongoMissingCredentialsError, MongoServerError } from 'mongodb';
import { bodyOf } from './_structural-window.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';

const SRC = readFileSync('server/src/db/mongo.ts', 'utf8');

// The retry budget is read when mongo.ts loads: short enough that a store that never comes up ends the file quickly.
process.env['MONGO_CONNECT_RETRY_MS'] = '1500';
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const { isStoreUnreachable } = await import('../../server/dist/db/store-condition.js');
const { connectMongo } = await import('../../server/dist/db/mongo.js');

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { PoolClearedError, PoolClearedOnNetworkError, PoolClosedError, WaitQueueTimeoutError } =
  requireFromServer(path.join(path.dirname(requireFromServer.resolve('mongodb')), 'cmap', 'errors.js'));

const serverError = (code, codeName) => new MongoServerError({ message: `server said ${code}`, errmsg: `server said ${code}`, code, codeName });

/** A real server selection error: the driver's own, from a connection to a port nothing listens on. */
async function realSelectionError() {
  const port = await closedLoopbackPort();
  const client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 300, connectTimeoutMS: 300 });
  try { await client.connect(); } catch (e) { return e; } finally { await client.close().catch(() => {}); }
  throw new Error('a connection to a closed port succeeded');
}

describe('which connect failures are retried: the one store-condition predicate, on real driver errors', () => {
  describe('retried - the store is there but cannot answer yet', () => {
    it('MongoServerSelectionError (a real one, from a closed port)', async () => {
      const e = await realSelectionError();
      assert.equal(e.name, 'MongoServerSelectionError');
      assert.equal(isStoreUnreachable(e), true);
    });
    it('MongoNetworkTimeoutError', () => assert.equal(isStoreUnreachable(new MongoNetworkTimeoutError('timed out')), true));
    it('MongoNetworkError (ECONNRESET, the CI failure)', () => assert.equal(isStoreUnreachable(new MongoNetworkError('read ECONNRESET')), true));
    it('PoolClearedError and PoolClearedOnNetworkError, the driver\'s own classes', () => {
      const cause = new MongoNetworkTimeoutError('monitor timed out');
      assert.equal(isStoreUnreachable(new PoolClearedError({ address: 'h:1', serverError: cause })), true);
      assert.equal(isStoreUnreachable(new PoolClearedOnNetworkError({ address: 'h:1', serverError: cause })), true);
    });
    it('the pool closed or out of connections (Q-330)', () => {
      assert.equal(isStoreUnreachable(new PoolClosedError({ address: 'h:1' })), true);
      assert.equal(isStoreUnreachable(new WaitQueueTimeoutError('no connection came free', 'h:1')), true);
    });
    for (const [code, what] of [[11600, 'InterruptedAtShutdown'], [91, 'ShutdownInProgress'], [11602, 'InterruptedDueToReplStateChange'],
      [189, 'PrimarySteppedDown'], [13436, 'NotPrimaryOrSecondary'],
      // The widened half: conditions the old boot list did not know and the request path always did.
      [6, 'HostUnreachable'], [7, 'HostNotFound'], [89, 'NetworkTimeout'], [9001, 'SocketException'], [10107, 'NotWritablePrimary'],
      [13435, 'NotPrimaryNoSecondaryOk'], [134, 'ReadConcernMajorityNotAvailableYet']]) {
      it(`MongoServerError ${code} (${what})`, () => assert.equal(isStoreUnreachable(serverError(code, what)), true));
    }
    it('an error that wraps one of them (the walk and the boot read the chain)', () => {
      assert.equal(isStoreUnreachable(new Error('wrapped', { cause: new MongoNetworkError('read ECONNRESET') })), true);
    });
  });

  describe('NOT retried - waiting cannot help, and a boot that hangs on it replaces a clear error with a slow one', () => {
    it('MongoServerError 18 (AuthenticationFailed) - the reason the retry is not "everything"', () =>
      assert.equal(isStoreUnreachable(serverError(18, 'AuthenticationFailed')), false));
    it('a MongoServerError whose code is a string, and one with no code', () => {
      assert.equal(isStoreUnreachable(serverError('11600')), false);
      assert.equal(isStoreUnreachable(serverError(undefined)), false);
    });
    it('MongoParseError (a malformed URI)', () => assert.equal(isStoreUnreachable(new MongoParseError('bad uri')), false));
    it('MongoMissingCredentialsError', () => assert.equal(isStoreUnreachable(new MongoMissingCredentialsError('no credentials')), false));
    it('a plain Error that carries a store-looking name', () => {
      for (const name of ['MongoNetworkError', 'MongoServerSelectionError', 'MongoTopologyClosedError', 'MongoWaitQueueTimeoutError']) {
        assert.equal(isStoreUnreachable(Object.assign(new Error('x'), { name })), false, name);
      }
    });
    it('a plain Error, null and undefined', () => {
      assert.equal(isStoreUnreachable(new Error('x')), false);
      assert.equal(isStoreUnreachable(null), false);
      assert.equal(isStoreUnreachable(undefined), false);
    });
  });
});

describe('connectMongo retries on that predicate and holds no list of its own', () => {
  const body = bodyOf(SRC, 'connectMongo');
  it('asks isStoreUnreachable of the failure', () => {
    assert.match(body, /isStoreUnreachable\(err\)/);
    assert.match(SRC, /import \{[^}]*\bisStoreUnreachable\b[^}]*\} from '\.\/store-condition\.js'/);
  });
  it('keeps no classifier of its own: no name allowlist, no code allowlist, no local predicate', () => {
    assert.doesNotMatch(SRC, /TRANSIENT_CONNECT_ERRORS|TRANSIENT_SERVER_ERROR_CODES|isTransientConnectError/,
      'a second answer to "can the store not be reached" is back in mongo.ts');
  });
  it('builds its client from mongoClientOptions, not an inline timeout', () => {
    assert.match(body, /new MongoClient\(uri, mongoClientOptions\(uri\)\)/);
    assert.doesNotMatch(body, /serverSelectionTimeoutMS\s*:/);
  });
});

/** Run `connectMongo` against `uri` with `MongoClient.prototype.connect` replaced by `connect`; counts the attempts. */
async function bootWith(uri, connect) {
  const saved = process.env['MONGO_URI'];
  const original = MongoClient.prototype.connect;
  const attempts = { count: 0 };
  process.env['MONGO_URI'] = uri;
  if (connect) MongoClient.prototype.connect = async function patched() { attempts.count++; return connect.call(this, attempts.count, original); };
  try {
    const out = await logLinesDuring(async () => {
      try { return { client: await connectMongo() }; } catch (error) { return { error }; }
    });
    return { ...out.result, lines: out.lines, attempts: attempts.count };
  } finally {
    MongoClient.prototype.connect = original;
    if (saved === undefined) delete process.env['MONGO_URI']; else process.env['MONGO_URI'] = saved;
  }
}

const RETRY_LINE = /MongoDB not ready yet/;
const OFFLINE = 'mongodb://127.0.0.1:1/?directConnection=true';

describe('the retry loop itself, run for real', () => {
  it('retries a failure the predicate accepts, says which (name, code, codeName) and recovers', async () => {
    const out = await bootWith(OFFLINE, function (n) {
      if (n < 3) throw serverError(11600, 'InterruptedAtShutdown');
      return this;
    });
    assert.ok(out.client, `did not recover: ${out.error?.message}`);
    assert.equal(out.attempts, 3);
    const retries = out.lines.filter(l => RETRY_LINE.test(l));
    assert.equal(retries.length, 2, retries.join('\n'));
    for (const line of retries) {
      assert.match(line, /MongoServerError/, 'the class');
      assert.match(line, /11600/, 'the server code (O-7)');
      assert.match(line, /InterruptedAtShutdown/, 'the server\'s name for the code (O-7)');
    }
    assert.ok(out.lines.some(l => /MongoDB connected after 3 attempts/.test(l)), 'a slow start must be told from a fast one');
    await out.client.close();
  });

  it('a failure with no code is named by class alone, with no "undefined" in the line', async () => {
    const out = await bootWith(OFFLINE, function (n) {
      if (n < 2) throw new MongoNetworkError('read ECONNRESET');
      return this;
    });
    assert.ok(out.client);
    const [line] = out.lines.filter(l => RETRY_LINE.test(l));
    assert.match(line, /MongoNetworkError/);
    assert.doesNotMatch(line, /undefined|null/);
    await out.client.close();
  });

  it('gives up at the budget with the LAST error, not a wrapper', async () => {
    const out = await bootWith(OFFLINE, () => { throw serverError(11600, 'InterruptedAtShutdown'); });
    assert.ok(out.error, 'a store that never comes up must end the boot');
    assert.equal(out.error.code, 11600);
    assert.ok(out.attempts >= 2, `retried ${out.attempts} time(s)`);
  });

  it('a real refused connection is retried and ends with the driver\'s own selection error', async () => {
    const port = await closedLoopbackPort();
    const out = await bootWith(`mongodb://127.0.0.1:${port}/?directConnection=true&serverSelectionTimeoutMS=200&connectTimeoutMS=200`, null);
    assert.equal(out.error?.name, 'MongoServerSelectionError');
    assert.ok(out.lines.filter(l => RETRY_LINE.test(l)).length >= 1, 'a store that refuses must be retried, not failed on the first attempt');
  });

  describe('fails fast on what waiting cannot cure - one attempt, no retry line', () => {
    const cases = [
      ['AuthenticationFailed (18)', () => serverError(18, 'AuthenticationFailed')],
      ['MongoMissingCredentialsError', () => new MongoMissingCredentialsError('no credentials')],
      ['MongoParseError', () => new MongoParseError('bad uri')],
      ['a plain Error carrying a store-looking name', () => Object.assign(new Error('x'), { name: 'MongoNetworkError' })],
    ];
    for (const [what, make] of cases) {
      it(what, async () => {
        const out = await bootWith(OFFLINE, () => { throw make(); });
        assert.ok(out.error, 'must reject');
        assert.equal(out.attempts, 1, `retried ${out.attempts} time(s)`);
        assert.equal(out.lines.filter(l => RETRY_LINE.test(l)).length, 0);
      });
    }

    it('a URI the driver refuses (the constructor throws): rejected at once, no retry line', async () => {
      const out = await bootWith('mongodb://127.0.0.1:1/?connectTimeoutMS=not-a-number', null);
      assert.equal(out.error?.name, 'MongoParseError');
      assert.equal(out.lines.filter(l => RETRY_LINE.test(l)).length, 0);
    });
  });

  it('closes the failed client before making another (a retry must not leak its topology and timers)', () => {
    assert.match(bodyOf(SRC, 'connectMongo'), /await _client\.close\(\)\.catch\(/);
  });

  it('is bounded by a budget, not by an attempt count alone', () => {
    // `envInt`, not `Number(...)`: a typo used to become NaN, `elapsed < NaN` is false, and the budget silently became ZERO retries.
    assert.match(SRC, /CONNECT_RETRY_BUDGET_MS = envInt\('MONGO_CONNECT_RETRY_MS', 30_000\)/);
    assert.match(SRC, /Date\.now\(\) >= deadline/);
  });

  it('backs off with jitter and a ceiling, through the shared helper and not a local copy', () => {
    const body = bodyOf(SRC, 'connectMongo');
    assert.match(body, /backoffDelayMs\([^;]*?,\s*250,\s*4_000\s*\)/, 'the wait must come from backoffDelayMs(<attempt>, 250, 4_000)');
    assert.doesNotMatch(body, /Math\.min\(delay \* 2, 4_000\)|withJitter\(delay\)|let delay\b/, 'a hand-rolled schedule is back');
  });
});

describe('ONE boot line states the effective client options (O-4)', () => {
  const SECRET = 'hunter2-s3cret';
  const withSecret = (query) => `mongodb://bootuser:${SECRET}@127.0.0.1:1/?directConnection=true${query}`;
  const optionLines = (lines) => lines.filter(l => /MongoDB client options/.test(l));

  it('names each figure and where it came from: the URI for what it names, the default for the rest', async () => {
    const out = await bootWith(withSecret('&connectTimeoutMS=3000'), function () { return this; });
    assert.ok(out.client);
    const lines = optionLines(out.lines);
    assert.equal(lines.length, 1, `expected exactly one line, got ${lines.length}`);
    assert.match(lines[0], /INFO/);
    assert.match(lines[0], /connectTimeoutMS=3000 \(MONGO_URI\)/);
    assert.match(lines[0], /serverSelectionTimeoutMS=10000 \(default\)/);
    assert.match(lines[0], /heartbeatFrequencyMS=5000 \(default\)/);
    await out.client.close();
  });

  it('is said ONCE per boot, however many attempts it takes, and before the first attempt', async () => {
    const order = [];
    const out = await bootWith(withSecret(''), function (n) {
      order.push(`attempt ${n}`);
      if (n < 3) throw new MongoNetworkError('read ECONNRESET');
      return this;
    });
    assert.ok(out.client);
    assert.equal(optionLines(out.lines).length, 1);
    const optionsAt = out.lines.findIndex(l => /MongoDB client options/.test(l));
    const firstRetryAt = out.lines.findIndex(l => RETRY_LINE.test(l));
    assert.ok(optionsAt >= 0 && firstRetryAt >= 0 && optionsAt < firstRetryAt,
      'the options line comes before the first retry line, so a boot that never connects still says what it was waiting under');
    await out.client.close();
  });

  it('is said even when the boot never connects', async () => {
    const out = await bootWith(withSecret(''), () => { throw serverError(18, 'AuthenticationFailed'); });
    assert.ok(out.error);
    assert.equal(optionLines(out.lines).length, 1);
  });

  it('holds no credential, in it or in any other line the boot wrote', async () => {
    const failing = await bootWith(withSecret('&serverSelectionTimeoutMS=junk'), null);
    const ok = await bootWith(withSecret(''), function () { return this; });
    for (const line of [...failing.lines, ...ok.lines]) {
      assert.doesNotMatch(line, new RegExp(`${SECRET}|bootuser`), `a credential reached a log line: ${line}`);
    }
    await ok.client?.close();
  });
});
