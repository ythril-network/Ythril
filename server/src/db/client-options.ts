/**
 * The MongoClient's liveness options: the ONE place they are written, and a connection string that names one wins.
 *
 * ## What it answers
 *
 * "Which of `serverSelectionTimeoutMS`, `connectTimeoutMS` and `heartbeatFrequencyMS` do we hand the driver for THIS
 * connection string, and at what figure?" Three things go wrong when that is answered inline at each `new MongoClient(`:
 *
 * - **A default silently overrides the operator.** The driver gives an options OBJECT precedence over the same option in
 *   the URI (`connection_string.js`), so `{ ...defaults }` spread beside a string that says `connectTimeoutMS=3000` throws
 *   the operator's number away with no error and no log. So this omits a default for every key the string names.
 * - **The figure drifts.** The store that accepts a connection and then stops answering ends an in-flight operation after
 *   `connect + heartbeat + selection`; a docs sentence, a test and a boot line that each retype the three numbers are three
 *   copies that disagree after the next change. `inFlightBoundMs` is computed from the EFFECTIVE values, and the constants
 *   are exported for everything that states them.
 * - **A credential reaches a log.** The connection string carries one. Nothing here puts any part of it into an error or a
 *   log line; the option NAMES are read into a lower-cased `Map` (never assigned onto an object from the string, so a name
 *   like `__proto__` is just a name), and a value the driver would refuse is the driver's to refuse, not ours to quote.
 *
 * ## Why no URL parser
 *
 * `new URL()` does not parse a multi-host replica-set string or `mongodb+srv`, and a failure to parse would have to be
 * reported in words that must not carry the string. The query is the text after the first `?`, split on `&` and `=`.
 * A password holding a literal `?` is not a valid connection string (it must be percent-encoded) and the driver refuses
 * it itself.
 *
 * ## What it does NOT do
 *
 * It does not validate a URI value (`connectTimeoutMS=abc` is the driver's to refuse), it does not know `socketTimeoutMS`
 * or `timeoutMS` (they are not liveness defaults; `write-bound.ts` says what it does about them), and it never reads the
 * environment: a caller whose own figures differ (the connection test's 5 s) passes them as `callerDefaults`, and the
 * string still wins over those.
 */

import { peerList } from '../util/log.js';

/** The three options this module owns. */
export interface ClientLivenessOptions {
  serverSelectionTimeoutMS: number;
  connectTimeoutMS: number;
  heartbeatFrequencyMS: number;
}

type LivenessKey = keyof ClientLivenessOptions;

/** How long the driver waits to find a server for an operation (and for the first connect). */
export const SERVER_SELECTION_TIMEOUT_MS = 10_000;
/** How long a new socket may take to connect (the driver's own default is 30 s). */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How often the monitor asks each server whether it is alive (the driver's own default is 10 s). */
export const HEARTBEAT_FREQUENCY_MS = 5_000;

/** The defaults, frozen; `mongoClientOptions` hands out a COPY so one caller cannot move the figures for the next. */
export const CLIENT_LIVENESS_DEFAULTS: Readonly<ClientLivenessOptions> = Object.freeze({
  serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  connectTimeoutMS: CONNECT_TIMEOUT_MS,
  heartbeatFrequencyMS: HEARTBEAT_FREQUENCY_MS,
});

const LIVENESS_KEYS = Object.keys(CLIENT_LIVENESS_DEFAULTS) as LivenessKey[];

function decodeName(name: string): string {
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * Every option the connection string names, as lower-cased name to RAW value (the last one when a name repeats).
 *
 * The one reader of a connection string's query in this server: `mongoClientOptions` and the boot line read it, and so does
 * `warnIfSocketTimeoutBelowWriteBound` (a second hand-written copy of this scan is how two readers come to disagree about
 * what the string says). Names are percent-decoded and compared in any case, as the driver compares them. A pair with no
 * name is skipped; a name with no `=` has the value `''`.
 */
export function uriQueryOptions(uri: string): Map<string, string> {
  const named = new Map<string, string>();
  const at = uri.indexOf('?');
  if (at < 0) return named;
  for (const pair of uri.slice(at + 1).split('&')) {
    const cut = pair.indexOf('=');
    const name = decodeName(cut < 0 ? pair : pair.slice(0, cut)).toLowerCase();
    if (name === '') continue;
    named.set(name, cut < 0 ? '' : pair.slice(cut + 1));
  }
  return named;
}

/** The figures a caller may stand in for the module's own defaults. */
export type CallerDefaults = Partial<ClientLivenessOptions>;

/** Refuse a caller default that is not a usable figure; the words name the key and never the connection string. */
function checkedCallerDefaults(callerDefaults: CallerDefaults): Required<ClientLivenessOptions> {
  const merged: Required<ClientLivenessOptions> = { ...CLIENT_LIVENESS_DEFAULTS };
  for (const [key, value] of Object.entries(callerDefaults)) {
    if (!(LIVENESS_KEYS as string[]).includes(key)) {
      throw new Error(`mongoClientOptions: "${key}" is not a liveness option (${LIVENESS_KEYS.join(', ')}).`);
    }
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`mongoClientOptions: the default for ${key} must be a non-negative finite number.`);
    }
    merged[key as LivenessKey] = value;
  }
  return merged;
}

/**
 * The options to hand `new MongoClient(uri, …)`: the defaults, minus every key the connection string names.
 *
 * A fresh object each call. Everything that builds a client from a connection string goes through this, so an operator's
 * option in `MONGO_URI` is the one the driver sees.
 */
export function mongoClientOptions(uri: string, callerDefaults: CallerDefaults = {}): Partial<ClientLivenessOptions> {
  const defaults = checkedCallerDefaults(callerDefaults);
  const named = uriQueryOptions(uri);
  const options: Partial<ClientLivenessOptions> = {};
  for (const key of LIVENESS_KEYS) {
    if (!named.has(key.toLowerCase())) options[key] = defaults[key];
  }
  return options;
}

/** What the client will actually run with: the three figures, whether the string made it a load-balanced one, and which figures the string supplied. */
export interface EffectiveClientOptions extends ClientLivenessOptions {
  loadBalanced: boolean;
  /** The option names (as the driver spells them) whose figure came from the connection string. */
  fromUri: LivenessKey[];
}

/**
 * The figures the client will run with for this connection string, and which of them the string supplied.
 *
 * A value the string holds that is not a plain non-negative integer is reported as the default: the driver refuses such a
 * string before it connects, so there is no client for the number to describe, and quoting it would put the string's
 * text where a log reader sees it. No credential and no raw value is carried.
 */
export function effectiveClientOptions(uri: string, callerDefaults: CallerDefaults = {}): EffectiveClientOptions {
  const defaults = checkedCallerDefaults(callerDefaults);
  const named = uriQueryOptions(uri);
  const effective: EffectiveClientOptions = { ...defaults, loadBalanced: named.get('loadbalanced')?.toLowerCase() === 'true', fromUri: [] };
  for (const key of LIVENESS_KEYS) {
    const raw = named.get(key.toLowerCase());
    if (raw === undefined || !/^\d+$/.test(raw)) continue;
    effective[key] = Number(raw);
    effective.fromUri.push(key);
  }
  return effective;
}

/**
 * The longest a store that stops answering can leave an in-flight operation waiting, in ms: `connect + heartbeat + selection`
 * of the EFFECTIVE options. `Infinity` when any term is 0 (the driver reads 0 as "no limit"). A load-balanced client has no
 * monitor, so only the selection wait counts and the figure is that alone.
 */
export function inFlightBoundMs(effective: ClientLivenessOptions & { loadBalanced?: boolean }): number {
  const terms = effective.loadBalanced
    ? [effective.serverSelectionTimeoutMS]
    : [effective.connectTimeoutMS, effective.heartbeatFrequencyMS, effective.serverSelectionTimeoutMS];
  return terms.some(t => t === 0) ? Infinity : terms.reduce((a, b) => a + b, 0);
}

/**
 * The boot INFO line's text: the three figures, each marked `MONGO_URI` or `default`, and `loadBalanced` when the string
 * made it one. Built from the effective report alone, so it cannot carry a credential.
 */
export function describeClientOptions(effective: EffectiveClientOptions): string {
  const figures = LIVENESS_KEYS.map(key => `${key}=${effective[key]} (${effective.fromUri.includes(key) ? 'MONGO_URI' : 'default'})`);
  // The figures are numbers the operator's own string may have supplied (steerable), so the joined list is bounded by
  // `peerList` like any such value in a log line (`a-steerable-value-reaches-a-log-line-only-bounded`).
  return `MongoDB client options: ${peerList(figures)}${effective.loadBalanced ? ', loadBalanced (no monitor: only the selection wait bounds an operation)' : ''}.`;
}
