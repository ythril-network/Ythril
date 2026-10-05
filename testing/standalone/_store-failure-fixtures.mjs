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
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
 * One instance of every driver class that is NOT a server's answer and takes the host text, as `{ name, make }`. A class
 * that ignores its message (it has nothing to leak) is left out; a class the generic constructors cannot build is left out
 * and counted by the floor, so a driver that stops accepting a message cannot empty the list quietly.
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
  return out;
}

/** A server's answer: `MongoServerError` as the driver builds it from the reply document. */
export const serverError = (code, codeName, errmsg) => new driver.MongoServerError({ ok: 0, code, codeName, errmsg });

/** An own error of ours that wraps what the driver raised — the shape `ArrivalWriteError` has. */
export const wrapping = (inner, message = `could not write the page: ${inner.message}`) => Object.assign(new Error(message), { cause: inner });

/** A `res` that records what was sent. */
export function fakeRes() {
  const out = { status: 200, headers: {}, body: undefined, sent: false };
  const res = {
    headersSent: false,
    setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; return res; },
    set: (k, v) => { out.headers[String(k).toLowerCase()] = v; return res; },
    status: (s) => { out.status = s; return res; },
    json: (b) => { out.body = b; out.sent = true; res.headersSent = true; return res; },
    send: (b) => { out.body = b; out.sent = true; res.headersSent = true; return res; },
  };
  return { res, out };
}

/** The log lines the server emitted while `fn` ran (the ring every line reaches), with the console silenced. */
export async function linesDuring(fn) {
  const log = await import('../../server/dist/util/log.js');
  const lines = [];
  const stop = log.subscribeLogLines(l => lines.push(l));
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  let result;
  try { result = await fn(); } finally { Object.assign(console, saved); stop(); }
  return { lines, result };
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

/**
 * `sendReadFailure` as the REST read routes call it. The release line's is `(res, err)`; a version that names the
 * operation takes it between (`(res, operation, err)`), so the call is made in the shape the function declares.
 */
export async function sendReadFailureOf(err) {
  const { sendReadFailure } = await import('../../server/dist/api/brain/_read-failure.js');
  const { res, out } = fakeRes();
  if (sendReadFailure.length >= 3) sendReadFailure(res, 'a test read', err); else sendReadFailure(res, err);
  return out;
}
