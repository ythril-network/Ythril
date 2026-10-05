/**
 * Store failures as the DRIVER raises them — real classes from the installed `mongodb` package, never a plain `Error`
 * wearing a driver's `name` — and the helpers every store-failure test shares.
 *
 * ## Why real classes (`Q-361`, the testing lens' TST-2)
 *
 * `store-failure-is-not-a-400.test.js` built its errors as `Object.assign(new Error(), { name: 'MongoNetworkError' })`.
 * A classifier that asks what an error IS (`instanceof MongoError`, a walk of its `cause` chain) never recognises one of
 * those, so every such test passes only for a classifier that asks what an error is CALLED — the thing a by-name branch
 * does and a by-class one must not need. These are the classes the driver throws, built by the driver's own constructors,
 * and the set is DERIVED from the package's exports with a floor: a driver upgrade that adds a class adds a case.
 *
 * ## Which are "driver-side with no server answer"
 *
 * `MongoServerError` and what extends it (`MongoBulkWriteError`, `MongoWriteConcernError`) carry the SERVER's answer — a
 * malformed query, a failed validation, in the server's own words. Every other `MongoError` is the driver talking about
 * its own condition: a socket, a server selection, a pool, a topology, a timeout, an argument it refused. Those are the
 * classes whose text names a host, a port or a namespace.
 *
 * ## The module that holds a function is FOUND, not named
 *
 * `isDriverSide` and `caughtFailureText` are new; where the implementation puts them is its own business, and a test that
 * imported a path would be a second place to say it. `moduleExporting(name)` reads `server/dist` for the one module that
 * exports the name, and fails if there is none or more than one (one question, one function).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeResponse } from './_fake-response.mjs';

const requireFromServer = createRequire(path.resolve('server/package.json'));
export const driver = requireFromServer('mongodb');
const { PoolClearedError } = requireFromServer(path.join(path.dirname(requireFromServer.resolve('mongodb')), 'cmap', 'errors.js'));

/** The driver's text, as the drive saw it: an internal host, a private address, a port and a namespace. */
export const HOST_TEXT = 'connection 5 to 172.16.0.9:27017 closed';
export const LEAK = /172\.16\.0\.9|27017|mongo-a\.internal|mongo-b\.internal|ENOTFOUND|Connection pool for|caused by|Executor error/;

/** The three sentences an answer may say about a store failure of its own, each in one spelling. */
export const SENTENCES = {
  unavailable: 'The store is not available right now.',
  incomplete: 'The store could not complete this request.',
};
/** The existing retry wording of a store-side 503 — either of the two spellings the base builds. */
export const STORE_SIDE = /store-side failure/i;

/** The classes the classifier answers 503 by their name — literal expected values, the statuses the release line keeps. */
export const STORE_SIDE_NAMES = ['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError',
  'MongoTopologyClosedError', 'MongoNotConnectedError'];

/** Every exported class that extends `MongoError`, as `[name, class]`. */
function driverClasses() {
  return Object.keys(driver)
    .filter(k => typeof driver[k] === 'function' && driver[k].prototype instanceof driver.MongoError)
    .map(k => [k, driver[k]]);
}

const answeredByServer = C => C === driver.MongoServerError || C.prototype instanceof driver.MongoServerError;

/**
 * The fewest driver-side classes the derivation may find. A floor and not a count: a driver upgrade that adds a class
 * adds a case, one that drops several is the break this guards.
 */
const DRIVER_SIDE_FLOOR = 25;

/**
 * One instance of every driver class that is NOT a server's answer and takes the host text, as `{ name, make }`. A class
 * that ignores its message (it has nothing to leak) is left out; a class the generic constructors cannot build is left out
 * and counted by the floor, which THIS function asserts, so a driver that stops accepting a message cannot empty the list
 * quietly and no caller has to remember the check. It throws rather than return a short list.
 */
export function driverSideErrors() {
  const out = [];
  for (const [name, C] of driverClasses()) {
    if (answeredByServer(C)) continue;
    const make = () => {
      for (const args of [[HOST_TEXT], [HOST_TEXT, {}]]) {
        try { return new C(...args); } catch { /* the next shape */ }
      }
      return null;
    };
    const probe = make();
    if (probe && String(probe.message).includes('172.16.0.9')) out.push({ name, make });
  }
  out.push({
    name: 'MongoPoolClearedError',
    make: () => new PoolClearedError({ address: 'mongo-a.internal:27017', id: 5, generation: 1 },
      `Connection pool for mongo-a.internal:27017 was cleared because another operation failed with: "${HOST_TEXT}"`),
  });
  assert.ok(out.length >= DRIVER_SIDE_FLOOR,
    `only ${out.length} driver-side classes built — the derivation from the package is broken`);
  return out;
}

/** A server's answer: `MongoServerError` as the driver builds it from the reply document. */
export const serverError = (code, codeName, errmsg) => new driver.MongoServerError({ ok: 0, code, codeName, errmsg });

/** `MongoServerError` codes the classifier answers `503` — the store cannot answer right now, and will. Literal expected values. */
export const STORE_CODES = [[11600, 'InterruptedAtShutdown'], [91, 'ShutdownInProgress'], [11602, 'InterruptedDueToReplStateChange'],
  [189, 'PrimarySteppedDown'], [13436, 'NotPrimaryOrSecondary'], [50, 'MaxTimeMSExpired'], [262, 'ExceededTimeLimit']];
/** Server codes whose text carries an address: "could not reach another member". The words go; the `400` stays. */
export const ADDRESS_CODES = [[6, 'HostUnreachable'], [7, 'HostNotFound'], [89, 'NetworkTimeout'], [9001, 'SocketException'],
  [10107, 'NotWritablePrimary'], [13435, 'NotPrimaryNoSecondaryOk'], [134, 'ReadConcernMajorityNotAvailableYet']];
/** What the server refused for a reason the caller can fix: its own words, kept, at `400`. */
export const SERVER_REFUSALS = [
  [2, 'BadValue', 'cannot set maxTimeMS on getMore command for a non-awaitData cursor'],
  [51091, 'Location51091', 'Regular expression is invalid: missing closing parenthesis'],
  [18, 'AuthenticationFailed', 'Authentication failed.'],
  [121, 'DocumentValidationFailure', 'Document failed validation'],
  [11000, 'DuplicateKey', 'E11000 duplicate key error collection: x.y index: _id_ dup key: { _id: "a" }'],
];
/** A server's answer of an ADDRESS code, with the member's address in its words. */
export const addressError = (code, codeName) => serverError(code, codeName, `could not reach mongo-a.internal:27017 — ${HOST_TEXT}`);

/** An own error of ours that wraps what the driver raised in its `cause` — the field a plain `new Error(…, { cause })` fills. */
export const wrapping = (inner, message = `could not write the page: ${inner.message}`) => Object.assign(new Error(message), { cause: inner });

/**
 * The three ways an error travels inside another, each built by the class that does it — `cause` (an own error, and the
 * driver's `PoolClearedError`), `underlying` (`ArrivalWriteError`, the real class, whose message quotes the driver's), and
 * `errorResponse` (the driver's `MongoBulkWriteError`, which keeps what a bulk write THREW there and copies its text).
 * `db/error-chain.ts` walks all three; a door that looks at only the outermost error, or only at `cause`, answers the
 * wrapper's text, and the wrapper quotes the driver.
 *
 * `wrap(inner)` is the wrapper around `inner`; `carriesAnyError` says whether it can sit over ANOTHER wrapper (the
 * driver builds a `MongoBulkWriteError` only over what a bulk write threw, and copies that error's enumerable fields,
 * which an own error with a `name` field refuses). The three together are one question ("a driver failure inside a
 * wrapper"), so a test that loops over them states the rule for every way an error is carried.
 *
 * A FUNCTION and not a constant, called after the test has set `CONFIG_PATH`: `ArrivalWriteError` lives in a module whose
 * import reads the configuration path once, and a fixture file imported first would bind it before the test's own temporary
 * path exists.
 */
export async function wrappers() {
  const { ArrivalWriteError } = await import('../../server/dist/sync/arrivals.js');
  return [
    { label: 'cause', carriesAnyError: true, wrap: (inner) => wrapping(inner) },
    { label: 'underlying (ArrivalWriteError)', carriesAnyError: true, wrap: (inner) => new ArrivalWriteError('a-space', 'facts', inner) },
    { label: 'errorResponse (MongoBulkWriteError)', carriesAnyError: false, wrap: (inner) => new driver.MongoBulkWriteError(inner, {}) },
  ];
}

const distFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? distFiles(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);

/**
 * The module under `server/dist` that exports `name` as a function — found by reading, so the test names the QUESTION
 * and not the file. Throws, naming what it found, when there is not exactly one.
 */
export async function moduleExporting(name) {
  const decl = new RegExp(`export (?:async )?function ${name}\\b|export const ${name}\\s*=`);
  const files = distFiles(path.resolve('server/dist')).filter(f => decl.test(readFileSync(f, 'utf8')));
  if (files.length !== 1) {
    throw new Error(`expected exactly one module under server/dist to export \`${name}\`, found ${files.length}: ${files.join(', ') || 'none'}`);
  }
  const mod = await import(pathToFileURL(files[0]).href);
  if (typeof mod[name] !== 'function') throw new Error(`${files[0]} exports \`${name}\` but not as a function`);
  return mod[name];
}

/** What the REST read routes pass as `where` — the operation, as the operator will search for it. */
export const READ_OPERATION = 'a test read';

/** `sendReadFailure(res, where, err)` as the REST read routes call it, and what it answered. */
export async function sendReadFailureOf(err) {
  const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
  const res = fakeResponse();
  sendReadFailure(res, READ_OPERATION, err);
  return { status: res.statusCode, headers: res.headers, body: res.body, sent: res.sent };
}
