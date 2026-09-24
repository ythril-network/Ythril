/**
 * Readiness check module
 *
 * Implements the checks behind `GET /ready`:
 *   - mongodb: admin ping + writable-primary verification
 *   - vectorSearch: mongot availability via listSearchIndexes
 *
 * Results are cached for CACHE_TTL_MS to avoid hammering MongoDB on every
 * Kubernetes probe interval.
 */

import { getMongo } from './db/mongo.js';
import { log } from './util/log.js';

const TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 2_000;

/**
 * Why a dependency check failed, in terms that say nothing about the deployment.
 *
 * `/ready` is registered before every auth middleware — it has to be, an orchestrator cannot hold a token — so it
 * is a **public** endpoint. It used to return the driver's message verbatim, and those messages describe the
 * infrastructure: `getaddrinfo ENOTFOUND mongo-a.internal` names an internal host, and a topology error names
 * internal addresses and ports. Measured against the real driver, not assumed.
 *
 * That also made `/ready` the one route that answered differently from everything else: the global error handler
 * logs the detail and returns a flat `Internal server error`. This brings the probe in line with it.
 *
 * A code is more useful to a probe than a sentence anyway — it is stable enough to alert on, which a driver
 * message never was.
 */
export type CheckReason =
  | 'unreachable'    // wrong host/port, firewall, DNS — the operator checks connectivity
  | 'timeout'        // reachable but did not answer in time — the operator checks load
  | 'auth_failed'    // credentials rejected
  | 'not_primary'    // connected to a secondary; writes would fail
  | 'unsupported'    // the server answered, but does not support what we need (e.g. no vector search)
  | 'error';         // classified as nothing more specific; the log has the message

export interface CheckResult {
  status: 'ok' | 'error';
  latencyMs?: number;
  /**
   * Present only on failure. Deliberately a code, never the underlying message — see {@link CheckReason}.
   * The full message goes to the log, once per transition.
   */
  reason?: CheckReason;
}

/** Map a driver error onto a {@link CheckReason}. Exported for the `/ready` handler's own catch branch. */
export function classifyCheckError(err: unknown): CheckReason {
  const msg = err instanceof Error ? err.message : String(err);
  // Auth first: "Authentication failed." matches nothing else, and misreading it as `unreachable` would send an
  // operator to check a firewall that is fine.
  if (/authentication failed|not authorized|unauthorized|bad auth/i.test(msg)) return 'auth_failed';
  if (/not primary|notwritableprimary|not master/i.test(msg)) return 'not_primary';
  // A CONNECT timeout is reported as `Socket 'connect' timed out after …`, and the operator's next step for it is
  // the same as for a refused connection: check the host, the port, the firewall. `timeout` is reserved for a
  // server that answered the handshake and then took too long, which is a load problem instead.
  // `connect` unanchored, deliberately. `\bconnect\b` missed `connection 4 to 10.1.2.3:27017 closed` — the
  // commonest failure of all, a server that went away mid-session — and classified it as the vague `error`. Caught
  // by testing the classifier against strings the driver really produces rather than the ones I had in mind.
  if (/enotfound|eai_again|econnrefused|ehostunreach|enetunreach|econnreset|connect/i.test(msg)) return 'unreachable';
  if (/timed out|etimedout|timeout|server selection/i.test(msg)) return 'timeout';
  if (/unrecognized pipeline stage|no such command|not supported|command .* not found|search index/i.test(msg)) {
    return 'unsupported';
  }
  return 'error';
}

/**
 * Log a check's failure once per transition, with the full message.
 *
 * Two reasons this is not a plain `log.warn` at the failure site. A readiness failure previously logged
 * **nothing at all** — the detail was returned to whoever asked and then discarded, so an operator watching the
 * logs of a failing pod saw silence. And a Kubernetes probe runs every few seconds, so logging every failure
 * would bury the rest of the log in copies of one line. Transitions carry the information; repetitions do not.
 */
const _lastState = new Map<string, string>();
function logTransition(check: string, reason: CheckReason | 'ok', detail?: string): void {
  const key = reason === 'ok' ? 'ok' : reason;
  if (_lastState.get(check) === key) return;
  const was = _lastState.get(check);
  _lastState.set(check, key);
  if (reason === 'ok') {
    if (was !== undefined) log.info(`Readiness: ${check} recovered`);
    return;
  }
  log.warn(`Readiness: ${check} is failing (${reason})${detail ? ` — ${detail}` : ''}`);
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    mongodb: CheckResult;
    vectorSearch: CheckResult;
  };
}

// ── Simple in-memory cache ────────────────────────────────────────────────────
let _cached: ReadinessResult | null = null;
let _cachedAt = 0;

// ── Individual checks ─────────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkMongoDB(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const client = getMongo();
    const admin = client.db().admin();

    // Ping verifies the connection is alive
    await withTimeout(admin.ping(), TIMEOUT_MS);

    // Verify that the node we're connected to is a writable primary so writes work
    const hello = await withTimeout(
      admin.command({ hello: 1 }),
      TIMEOUT_MS,
    );
    const isWritable = hello['isWritablePrimary'] === true || hello['ismaster'] === true;
    if (!isWritable) {
      logTransition('mongodb', 'not_primary', 'connected node is not a writable primary');
      return { status: 'error', reason: 'not_primary' };
    }

    logTransition('mongodb', 'ok');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    const reason = classifyCheckError(err);
    logTransition('mongodb', reason, err instanceof Error ? err.message : String(err));
    return { status: 'error', reason };
  }
}

async function checkVectorSearch(): Promise<CheckResult> {
  try {
    const db = getMongo().db();
    // listSearchIndexes on any collection exercises the mongot connection.
    // An empty collection / non-existent collection still reaches mongot; a missing
    // mongot process throws immediately.
    await withTimeout(
      db.collection('_ready_probe').listSearchIndexes().toArray(),
      TIMEOUT_MS,
    );
    logTransition('vectorSearch', 'ok');
    return { status: 'ok' };
  } catch (err) {
    const reason = classifyCheckError(err);
    logTransition('vectorSearch', reason, err instanceof Error ? err.message : String(err));
    return { status: 'error', reason };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getReadiness(): Promise<ReadinessResult> {
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) {
    return _cached;
  }

  const [mongodb, vectorSearch] = await Promise.all([
    checkMongoDB(),
    checkVectorSearch(),
  ]);

  const result: ReadinessResult = {
    ready: mongodb.status === 'ok' && vectorSearch.status === 'ok',
    checks: { mongodb, vectorSearch },
  };

  _cached = result;
  _cachedAt = now;
  return result;
}
