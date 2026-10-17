/**
 * Register a deletion, wipe or rename of a space durably, let its space's admitted transfers end, run it once in its lane, and say
 * whether one stands for a space (bundle-106, design v5 §2.5, §2.5a, §2.6; X1, X3, X4, X5, X6, X9).
 *
 * ## What went wrong before it
 *
 * A removal and a rename counted themselves in an instance-wide depth counter and a wipe did not, so a wipe ran beside anything; two
 * deletions of one space ran at once and the second threw; a queued act lived only in memory, closed nothing until its body began and
 * was lost by a restart; and a ten-minute wipe of one space made every rename and delete that met a `pendingSpaceOp` refuse with
 * "being performed right now". One module now owns every act, and nothing reaches a body but through it.
 *
 * ## Four phases per act
 *
 * 1. **Register** (`registerSpaceAct`) — synchronous, on the config the caller saves in ONE write. From that write on the standing
 *    predicate (`spaceActStands`) is true for the space: every writer refuses, the exchange is held, and the transfers in flight are told
 *    to stop at their next unit. A restart finds the entry and resumes it after listen (`resumeSpaceActs`). A request whose key matches a
 *    standing entry JOINS it, its round appended in the same write.
 * 2. **Drain** — per space, OUTSIDE any lane: wait for the units of the space admitted before the registration
 *    (`sync/space-transfer-fence.ts`). Past `EXCHANGE_DRAIN_MS` the entry reads `draining` and waits again — waiting is not failing.
 * 3. **Lane** — one body at a time per lane (see below).
 * 4. **Body, then the completion** — the body's store operations are bounded one by one, a large wipe goes in batches, file-system and
 *    claim waits are raced against their own bounds; the completion is ONE config write that removes the entry, runs its post-steps and
 *    settles every round it covers. A body that fails leaves the entry `owed` with its one retry clock (`attempts`, `retryAt`), and the
 *    space stays closed and held until a retry completes it.
 *
 * ## Two lanes, and why not one (ruling R-P6)
 *
 * The delete and rename bodies write the instance-wide `pendingSpaceOp` write-ahead, of which there is ONE: two of them at once would
 * overwrite each other's crash marker. That is the whole reason bodies were ever serialised, so those two kinds share the lane
 * `space-op`. A wipe writes no such marker (its entry is its write-ahead), so wipes have the lane `wipe` of their own, serial among
 * themselves so one batched wipe at a time loads the store. A long wipe therefore never holds up a rename or a delete of ANOTHER space.
 * Acts on ONE space keep their registration order across both lanes: each act first waits its turn in a per-space queue, and only then
 * enters its lane, so a job holding a lane never waits for another job.
 *
 * ## Shutdown (W8, X9)
 *
 * `closeSpaceActs()` refuses new acts and lists what was left; nothing waits for an act. A body that fails after it records nothing — no
 * attempt, no `retryAt`, no failure counted — because the store is closing under it; its entry stays as it was on disk and the next start
 * resumes it at once.
 *
 * The runner imports nothing from `lifecycle.ts` or `rename.ts` (no import cycle): those modules hand it their bodies
 * (`defineSpaceActBody`) when they load.
 */
import { randomUUID } from 'node:crypto';
import { getConfig, mutateConfig, isConfigLoaded } from '../config/loader.js';
import type { Config, SpaceActEntry, SpaceActKind, SpaceActRound, SpaceActState, SpaceConfig } from '../config/types.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../config/types-knowledge.js';
import { getDb } from '../db/mongo.js';
import { withinHousekeepingBound, housekeepingOpMs } from '../db/write-bound.js';
import { isWriteTimeout } from '../db/write-timeout.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { classifyReadFailure } from '../brain/store-failure.js';
import { PEER_TRANSFER_TIMEOUT_MS } from '../sync/peer-fetch.js';
import { abortTransfersOf, awaitSpaceTransfersDrained, resetSpaceTransfersForTest } from '../sync/space-transfer-fence.js';
import { forgetReceiveMarks } from '../sync/member-space-mark.js';
import type * as SpaceRounds from './apply-wipe-round.js';
import { keyedLimiter, type KeyedLimiter } from '../util/keyed-limiter.js';
import { warnOnce } from '../util/warn-once.js';
import { backoffDelayMs } from '../util/backoff.js';
import { withinTimeBound, withinFsBound, isTimeBoundEnded } from '../util/time-bound.js';
import { eachSpace } from '../util/housekeeping-walk.js';
import { log, peerText } from '../util/log.js';
import { logInternalAudit } from '../audit/audit.js';
import { auditRoundEffect, ROUND_SPACE_ACT_OPERATION, SPACE_ACT_COMPLETED_OPERATION } from '../networks/round-audit.js';
import type * as Registry from '../metrics/registry.js';

/*
 * The counters, loaded when the first act runs and never at import: the registry imports half the server, and the write gate — which
 * every writer imports — imports this module, so a static import closed a cycle through the writers and left a writer's constants
 * uninitialised at load. Every path that counts runs after `countersLoaded()`.
 */
let counters: typeof Registry | null = null;
async function countersLoaded(): Promise<typeof Registry> {
  counters ??= await import('../metrics/registry.js');
  // The settle of the rounds an act carries, loaded the same way and for a reason of its own: the settle registers acts here, so a
  // static import both ways is a module cycle. Loaded before any body runs, so the completion's one synchronous write has it.
  spaceRounds ??= await import('./apply-wipe-round.js');
  return counters;
}

let spaceRounds: typeof SpaceRounds | null = null;

export type { SpaceActKind } from '../config/types.js';

/** What a caller asks the runner to do. */
export interface SpaceActRequest {
  kind: SpaceActKind;
  localId: string;
  /** A wipe's covered collections; absent = all of them. */
  types?: readonly BrainCollection[];
  /** A deletion's network, whose round it carries out; absent = this instance's own deletion. */
  networkId?: string;
  /** A rename's new id. */
  newId?: string;
  /** The round the act carries out, appended to the entry's rounds. */
  round?: SpaceActRound;
}

/** What one run of an act came to. Never thrown: a run answers. */
export interface SpaceRoundSettled {
  entryId: string;
  kind?: SpaceActKind;
  localId?: string;
  ok: boolean;
  /** The rounds the act covered; `roundId` is the first of them. */
  rounds: SpaceActRound[];
  roundId?: string;
  /** Our sentence when it did not complete — never a driver's text. */
  error?: string;
  /** What failed, for the caller that answers it (a store failure is answered as the store's); never written anywhere. */
  cause?: unknown;
  /** When the runner will try a failed act again. */
  retryAt?: string;
  /** The act was refused before it changed anything (a rename that met a standing deletion or wipe); its entry is gone. */
  refused?: boolean;
  /** Shutdown ended it; the entry is unchanged and resumes after the next start. */
  interrupted?: boolean;
  counts?: Record<string, number>;
  removedHere?: boolean;
  renamed?: SpaceConfig;
}

/** Does an act stand for a space, and which. */
export interface SpaceActStanding {
  entryId: string;
  kind: SpaceActKind;
  types: readonly BrainCollection[] | 'all';
  state: SpaceActState;
  /** A rename's new id. */
  newId?: string;
}

/** The figures an act is bounded by. Each has a setter for tests (`setSpaceActKnobsForTest`). */
export interface SpaceActKnobs {
  /** How long one drain waits before the entry reads `draining` and waits again. */
  EXCHANGE_DRAIN_MS: number;
  /** How long a door waits for its act before answering `queued`. */
  SPACE_ACT_ANSWER_MS: number;
  /** One store operation of a body, its batch hooks included. */
  SPACE_ACT_OP_MS: number;
  /** Rows one wipe batch deletes. */
  SPACE_ACT_BATCH: number;
  /** One file-system step of a body. */
  SPACE_ACT_FS_MS: number;
  /** The wait for a space's media claims to be revoked. */
  SPACE_ACT_CLAIM_MS: number;
  /** An act running longer than this is reported (never cut). */
  SLOW_SPACE_ACT_MS: number;
  /** The longest one inbound transfer may stay open. */
  INBOUND_TRANSFER_MS: number;
}

const DEFAULT_KNOBS: { readonly [K in keyof SpaceActKnobs]: () => number } = {
  EXCHANGE_DRAIN_MS: () => 60_000,
  SPACE_ACT_ANSWER_MS: () => 20_000,
  SPACE_ACT_OP_MS: () => housekeepingOpMs(),
  SPACE_ACT_BATCH: () => 5_000,
  SPACE_ACT_FS_MS: () => 120_000,
  SPACE_ACT_CLAIM_MS: () => 120_000,
  SLOW_SPACE_ACT_MS: () => 10 * 60_000,
  INBOUND_TRANSFER_MS: () => PEER_TRANSFER_TIMEOUT_MS,
};

let knobs: Partial<SpaceActKnobs> = {};

/** The figure `name` stands at now. */
export function spaceActKnob(name: keyof SpaceActKnobs): number {
  return knobs[name] ?? DEFAULT_KNOBS[name]();
}

/** How long a door waits for its act before answering `queued`. */
export function spaceActAnswerMs(): number {
  return spaceActKnob('SPACE_ACT_ANSWER_MS');
}

/** Hooks a test installs INSIDE the real bodies; none of them replaces a body. A hook may return a promise the test releases. */
export interface SpaceActHooks {
  afterRegister(entry: SpaceActEntry): void;
  afterDrain(entry: SpaceActEntry): unknown;
  beforeBatch(collection: string, n: number): unknown;
  afterBatch(collection: string, n: number): unknown;
  atFileTree(localId: string): unknown;
  beforeComplete(entry: SpaceActEntry): unknown;
  afterBodyFailed(entry: SpaceActEntry, err: unknown): void;
}

let hooks: Partial<SpaceActHooks> = {};

/** What a body is handed: its entry as it stood when it started, and the bounded steps it does its work through. */
export interface SpaceActBodyContext {
  readonly entry: Readonly<SpaceActEntry>;
  /**
   * Delete the rows of `collection` matching `filter` in bounded batches; how many went. `remove` is the body's own delete of one
   * batch's ids, so the collection a body empties is spelled where the body is read.
   */
  deleteInBatches(collection: string, filter: Record<string, unknown>, remove: (ids: unknown[]) => Promise<{ deletedCount?: number }>): Promise<number>;
  /** One file-system step, raced against `SPACE_ACT_FS_MS`: past it the attempt fails and the lane is freed. */
  fileTree<T>(fn: () => Promise<T>): Promise<T>;
  /** The wait for the space's media claims, raced against `SPACE_ACT_CLAIM_MS`. */
  claimWait<T>(fn: () => Promise<T>): Promise<T>;
}

/** What a body did. */
export interface SpaceActBodyOutcome {
  /** The space was not here to act on. */
  absent?: boolean;
  /** This instance's own copy was removed (a deletion). */
  removedHere?: boolean;
  counts?: Record<string, number>;
  renamed?: SpaceConfig;
  /** The act was refused before it changed anything; the entry is removed and nothing is retried. */
  refusal?: Error;
}

export type SpaceActBody = (ctx: SpaceActBodyContext) => Promise<SpaceActBodyOutcome>;

const bodies = new Map<SpaceActKind, SpaceActBody>();

/** `lifecycle.ts` and `rename.ts` hand their bodies over when they load: the runner runs them and never imports them. */
export function defineSpaceActBody(kind: SpaceActKind, body: SpaceActBody): void {
  bodies.set(kind, body);
}

/** Shutdown has closed the runner: a new act is refused. Answered `503` by both doors (`spaceActClosedAnswer`). */
export class SpaceActsClosedError extends Error {
  override readonly name = 'SpaceActsClosedError';
  constructor() { super('shutting down'); }
}

/** The answer to a refusal the closed runner made, or null for anything else. */
export function spaceActClosedAnswer(err: unknown): { status: 503; body: { error: string } } | null {
  const closed = err instanceof SpaceActsClosedError || (err instanceof Error && err.name === 'SpaceActsClosedError');
  return closed ? { status: 503, body: { error: 'shutting down' } } : null;
}

// ── keys and the standing predicate ─────────────────────────────────────────────────────────────────────────────

/**
 * The collections a wipe covers, canonical: deduplicated, in `BRAIN_COLLECTIONS` order, `undefined` when they are all of them. THROWS
 * for a name outside them, so a key, an entry and a round can never disagree about what a wipe covers.
 */
export function canonicalWipeTypes(types: readonly string[] | undefined): BrainCollection[] | undefined {
  if (!types || types.length === 0) return undefined;
  for (const t of types) {
    if (!(BRAIN_COLLECTIONS as readonly string[]).includes(t)) throw new Error(`'${t}' is not a collection a wipe covers`);
  }
  const covered = BRAIN_COLLECTIONS.filter(t => types.includes(t));
  return covered.length === BRAIN_COLLECTIONS.length ? undefined : [...covered];
}

/** The key two requests are the same act by: a deletion's network is part of it (X4), a wipe's covered set is. */
function keyOf(e: Pick<SpaceActEntry, 'kind' | 'localId' | 'types' | 'networkId' | 'newId'>): string {
  if (e.kind === 'wipe') return `wipe|${e.localId}|${e.types ? e.types.join(',') : 'all'}`;
  if (e.kind === 'delete') return `delete|${e.localId}|${e.networkId ?? 'solo'}`;
  return `rename|${e.localId}|${e.newId ?? ''}`;
}

/**
 * Does a deletion, wipe or rename stand for `localId` — THE answer, asked by the write gate, the hold, the fence, rename and the runner,
 * and spelled nowhere else. Two predicates over two sets is what let a write land that the act then deleted.
 *
 * `types`: the families a write touches — a wipe that covers none of them does not close it; a deletion or a rename closes every
 * family. `except`: an entry that does not count (an act asking about its own space).
 *
 * It reads only what THIS instance wrote — its act entries and the body's own `pendingSpaceOp` write-ahead, which closes the space
 * between a boot's resume of the marker and the entry's own resume — so it cannot throw on anything a peer sent.
 */
export function spaceActStands(
  cfg: Config, localId: string, opts: { types?: readonly BrainCollection[]; except?: string } = {},
): SpaceActStanding | null {
  const list = cfg.pendingSpaceActs ?? [];
  // An act asking about its own space (`except`) is not closed by the acts of that space registered AFTER it: they wait for it in
  // the space's queue and cannot run before it ends, so the act ahead of them still does its own writes.
  const asker = opts.except === undefined ? -1 : list.findIndex(e => e.id === opts.except);
  for (const [i, e] of list.entries()) {
    if (e.localId !== localId || e.id === opts.except) continue;
    if (asker >= 0 && i > asker) continue;
    if (opts.types && e.kind === 'wipe' && e.types && !opts.types.some(t => e.types!.includes(t))) continue;
    return {
      entryId: e.id, kind: e.kind, types: e.kind === 'wipe' && e.types ? e.types : 'all', state: e.state,
      ...(e.newId ? { newId: e.newId } : {}),
    };
  }
  const op = cfg.pendingSpaceOp;
  if (op?.spaceId === localId) {
    return { entryId: '', kind: op.type, types: 'all', state: 'running', ...(op.newId ? { newId: op.newId } : {}) };
  }
  return null;
}

/*
 * The other readers of the act list: what a settle, a door and the network answer need to know about the entries — answered here,
 * because the runner is the one module that reads the list (`one-standing-predicate`), so no second reading of it can drift.
 */

/** The entry that carries round `roundId` of network `networkId`, if one stands: a pass that meets the round again joins it, never doubles it. */
export function spaceActOfRound(cfg: Pick<Config, 'pendingSpaceActs'>, networkId: string, roundId: string): SpaceActEntry | undefined {
  return (cfg.pendingSpaceActs ?? []).find(e => e.rounds.some(r => r.networkId === networkId && r.roundId === roundId));
}

/** The entry `req` would join — the same act by key — if one stands: a door that repeats a local act answers that one. */
export function spaceActJoinedBy(cfg: Pick<Config, 'pendingSpaceActs'>, req: SpaceActRequest): SpaceActEntry | undefined {
  const types = req.kind === 'wipe' ? canonicalWipeTypes(req.types) : undefined;
  const key = keyOf({ kind: req.kind, localId: req.localId, types, networkId: req.kind === 'delete' ? req.networkId : undefined,
    newId: req.kind === 'rename' ? req.newId : undefined });
  return (cfg.pendingSpaceActs ?? []).find(e => keyOf(e) === key);
}

/** The entries standing for space `localId`, every kind, in registration order. */
export function spaceActsOfSpace(cfg: Pick<Config, 'pendingSpaceActs'>, localId: string): readonly SpaceActEntry[] {
  return (cfg.pendingSpaceActs ?? []).filter(e => e.localId === localId);
}

/** The entries that carry a round of network `networkId`, or its deletion's network half: what the network answer lists as owed. */
export function spaceActsOfNetwork(cfg: Pick<Config, 'pendingSpaceActs'>, networkId: string): readonly SpaceActEntry[] {
  return (cfg.pendingSpaceActs ?? []).filter(e => e.rounds.some(r => r.networkId === networkId) || (e.kind === 'delete' && e.networkId === networkId));
}

// ── register ────────────────────────────────────────────────────────────────────────────────────────────────────

let closed = false;

/**
 * Register `req` on `cfg` — the config the caller saves in its ONE write — or join the standing entry with the same key, appending
 * `req.round` to it. THROWS {@link SpaceActsClosedError} once shutdown closed the runner.
 */
export function registerSpaceAct(cfg: Config, req: SpaceActRequest, now: number): { entry: SpaceActEntry; joined: boolean } {
  if (closed) throw new SpaceActsClosedError();
  const types = req.kind === 'wipe' ? canonicalWipeTypes(req.types) : undefined;
  const shape = { kind: req.kind, localId: req.localId, types, networkId: req.kind === 'delete' ? req.networkId : undefined,
    newId: req.kind === 'rename' ? req.newId : undefined };
  const key = keyOf(shape);
  const list = (cfg.pendingSpaceActs ??= []);
  const same = list.find(e => keyOf(e) === key);
  if (same) {
    if (req.round && !same.rounds.some(r => r.networkId === req.round!.networkId && r.roundId === req.round!.roundId)) {
      same.rounds.push({ ...req.round });
    }
    return { entry: same, joined: true };
  }
  // A wipe forgets what each member of every network carrying the space was marked for it, so the space is read again from the start.
  const forget = req.kind === 'wipe'
    ? (cfg.networks ?? []).filter(n => n.spaces.includes(req.localId)).map(n => ({ networkId: n.id, localSpaceId: req.localId }))
    : [];
  const entry: SpaceActEntry = {
    id: randomUUID(), kind: req.kind, localId: req.localId,
    ...(types ? { types } : {}),
    ...(shape.networkId ? { networkId: shape.networkId } : {}),
    ...(shape.newId ? { newId: shape.newId } : {}),
    rounds: req.round ? [{ ...req.round }] : [],
    postSteps: forget.length > 0 ? { forgetReceiveMarks: forget } : {},
    registeredAt: new Date(now).toISOString(), state: 'registered', attempts: 0,
  };
  list.push(entry);
  abortTransfersOf(req.localId);
  hooks.afterRegister?.(entry);
  return { entry, joined: false };
}

/**
 * Register `req` in a config write of its own and return its entry id — for the callers whose act is not part of a conclusion's save
 * (a solo deletion or wipe, a rename). THROWS {@link SpaceActsClosedError} once shutdown closed the runner.
 */
export function registerOwnSpaceAct(req: SpaceActRequest): string {
  if (closed) throw new SpaceActsClosedError();
  let id = '';
  mutateConfig(cfg => { id = registerSpaceAct(cfg, req, Date.now()).entry.id; });
  return id;
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Lane = 'space-op' | 'wipe';
const laneOf = (kind: SpaceActKind): Lane => (kind === 'wipe' ? 'wipe' : 'space-op');

interface Queued { start(): Promise<void>; abandon(): void }

const limiterOf = (): KeyedLimiter<string, Queued> => keyedLimiter<string, Queued>({
  concurrency: 1, bound: Number.MAX_SAFE_INTEGER,
  run: (_key, item) => item.start(),
  onError: (key, err) => log.error(`space act queue '${peerText(key)}': ${peerText(err)}`),
});

let spaceOrder = limiterOf();
let lanes = limiterOf();

const jobs = new Map<string, Promise<SpaceRoundSettled>>();
const waiters = new Map<string, number>();
const runningBySpace = new Map<string, number>();
let runningCount = 0;
let bodyRuns: Record<SpaceActKind, number> = { delete: 0, wipe: 0, rename: 0 };
const startedAt = new Map<string, { kind: SpaceActKind; localId: string; at: number }>();

const waitingSaid = warnOnce<string>({ every: 10 * 60_000 });
const failureSaid = warnOnce<string>({ every: 10 * 60_000 });
const slowSaid = warnOnce<string>({ every: 10 * 60_000 });

const readEntry = (id: string): SpaceActEntry | undefined => getConfig().pendingSpaceActs?.find(e => e.id === id);

/** The entries on the live config — none before a config exists (a first-run instance, a scrape before setup, a shutdown then). */
const standingEntries = (): SpaceActEntry[] => (isConfigLoaded() ? getConfig().pendingSpaceActs ?? [] : []);

const result = (entry: SpaceActEntry | undefined, id: string, more: Partial<SpaceRoundSettled>): SpaceRoundSettled => ({
  entryId: id, ok: false, rounds: entry ? [...entry.rounds] : [],
  ...(entry ? { kind: entry.kind, localId: entry.localId, ...(entry.rounds[0] ? { roundId: entry.rounds[0].roundId } : {}) } : {}),
  ...more,
});

const interrupted = (entry: SpaceActEntry | undefined, id: string): SpaceRoundSettled =>
  result(entry, id, { ok: false, interrupted: true, error: 'shutting down; the act resumes after the next start' });

function setState(id: string, state: SpaceActState): void {
  if (readEntry(id)?.state === state) return;
  mutateConfig(cfg => { const e = cfg.pendingSpaceActs?.find(x => x.id === id); if (e) e.state = state; });
}

/** Run `fn` in `lane` when the lane is free; refused (and answered as interrupted) once shutdown closed the lanes. */
function inLane<T>(lane: Lane, fn: () => Promise<T>, onClosed: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    const item: Queued = {
      start: () => fn().then(resolve, (err: unknown) => { log.error(`space act lane '${lane}': ${peerText(err)}`); resolve(onClosed()); }),
      abandon: () => resolve(onClosed()),
    };
    if (lanes.submit(lane, item) === 'refused') resolve(onClosed());
  });
}

/**
 * Run the act of entry `entryId` — or join its run when one is going. NEVER rejects: the answer says what happened. `waiter: true` says a
 * caller is waiting for the answer (a door), so the completion is not audited for it; the caller ends the wait with
 * {@link releaseSpaceActWaiter}. `via` names who started it, for the counter.
 */
export function runSpaceAct(entryId: string, opts: { waiter?: boolean; via?: string } = {}): Promise<SpaceRoundSettled> {
  if (opts.waiter) waiters.set(entryId, (waiters.get(entryId) ?? 0) + 1);
  const running = jobs.get(entryId);
  if (running) return running;
  const entry = readEntry(entryId);
  if (!entry) return Promise.resolve(result(undefined, entryId, { ok: true }));
  if (closed) return Promise.resolve(interrupted(entry, entryId));
  const via = opts.via ?? 'door';
  const job = new Promise<SpaceRoundSettled>(resolve => {
    const item: Queued = {
      start: () => runJob(entryId, via).then(resolve),
      abandon: () => resolve(interrupted(entry, entryId)),
    };
    if (spaceOrder.submit(entry.localId, item) === 'refused') resolve(interrupted(entry, entryId));
  });
  jobs.set(entryId, job);
  void job.finally(() => { if (jobs.get(entryId) === job) jobs.delete(entryId); });
  return job;
}

/** A door that waited for an act has answered: a completion from now on is audited, because nobody is told of it. */
export function releaseSpaceActWaiter(entryId: string): void {
  const n = (waiters.get(entryId) ?? 0) - 1;
  if (n > 0) waiters.set(entryId, n); else waiters.delete(entryId);
}

async function runJob(id: string, via: string): Promise<SpaceRoundSettled> {
  let entry = readEntry(id);
  if (!entry) return result(undefined, id, { ok: true });
  try {
    await countersLoaded();
    for (;;) {
      if (closed) return interrupted(entry, id);
      const drained = await awaitSpaceTransfersDrained(entry.localId, spaceActKnob('EXCHANGE_DRAIN_MS'));
      if (drained === 'drained') break;
      setState(id, 'draining');
      const localId = entry.localId; const kind = entry.kind;
      waitingSaid(id, () => log.info(`${kind} of '${peerText(localId)}' is waiting for transfer(s) of it to end`));
      entry = readEntry(id) ?? entry;
    }
    await hooks.afterDrain?.(entry);
  } catch (err) {
    return failed(id, entry, err, via);
  }
  const kind = entry.kind;
  return inLane(laneOf(kind), () => runBody(id, via), () => interrupted(readEntry(id), id));
}

async function runBody(id: string, via: string): Promise<SpaceRoundSettled> {
  // Read again: a rename's commit may have moved the space this act names while it waited.
  const entry = readEntry(id);
  if (!entry) return result(undefined, id, { ok: true });
  if (closed) return interrupted(entry, id);
  setState(id, 'running');
  const localId = entry.localId;
  runningBySpace.set(localId, (runningBySpace.get(localId) ?? 0) + 1);
  runningCount++;
  bodyRuns[entry.kind]++;
  startedAt.set(id, { kind: entry.kind, localId, at: Date.now() });
  try {
    const body = bodies.get(entry.kind);
    if (!body) throw new Error(`no body is defined for a space ${entry.kind}: its module was not loaded`);
    const outcome = await withinHousekeepingBound(() => body(contextFor(entry)), { opMs: spaceActKnob('SPACE_ACT_OP_MS') });
    if (!outcome.refusal) await hooks.beforeComplete?.(readEntry(id) ?? entry);
    return complete(id, entry, outcome, via);
  } catch (err) {
    return failed(id, entry, err, via);
  } finally {
    runningCount = Math.max(0, runningCount - 1);
    const n = (runningBySpace.get(localId) ?? 1) - 1;
    if (n > 0) runningBySpace.set(localId, n); else runningBySpace.delete(localId);
    startedAt.delete(id);
  }
}

/**
 * The completion: ONE config write removes the entry (and, for a deletion that left the space gone, every other entry of that space),
 * forgets the receive marks its post-steps name and settles every round the removed entries cover. The hold lifts through this write
 * alone, so no exchange can be admitted between the last delete and the forget and write a pre-wipe mark back.
 */
function complete(id: string, entry: SpaceActEntry, outcome: SpaceActBodyOutcome, via: string): SpaceRoundSettled {
  const refused = outcome.refusal !== undefined;
  const spaceGone = entry.kind === 'delete' && !getConfig().spaces.some(s => s.id === entry.localId);
  let covered: SpaceActRound[] = entry.rounds;
  mutateConfig(cfg => {
    if (!cfg.pendingSpaceActs) return;
    const self = cfg.pendingSpaceActs.find(e => e.id === id) ?? entry;
    covered = self.rounds;
    const leaving = cfg.pendingSpaceActs.filter(e => e.id === id || (spaceGone && e.localId === self.localId));
    const leavingIds = new Set(leaving.map(e => e.id));
    cfg.pendingSpaceActs = cfg.pendingSpaceActs.filter(e => !leavingIds.has(e.id));
    if (cfg.pendingSpaceActs.length === 0) delete cfg.pendingSpaceActs;
    if (refused) return;
    for (const step of self.postSteps.forgetReceiveMarks ?? []) {
      const net = cfg.networks.find(n => n.id === step.networkId);
      if (net) forgetReceiveMarks(net, step.localSpaceId);
    }
    for (const e of leaving) {
      for (const r of e.rounds) {
        const net = cfg.networks.find(n => n.id === r.networkId);
        const round = net?.pendingRounds.find(x => x.roundId === r.roundId);
        if (net && round) spaceRounds!.settleSpaceAct(net, round, e.id === id && !outcome.absent ? 'completed' : 'absent');
      }
    }
  });
  if (refused) {
    return result(entry, id, { ok: false, refused: true, error: outcome.refusal!.message, cause: outcome.refusal, rounds: covered });
  }
  counters?.spaceActsTotal.inc({ kind: entry.kind, via, outcome: 'completed' });
  failureSaid.forget(id);
  waitingSaid.forget(id);
  if (!waiters.has(id) && covered.length === 0) {
    // Nobody is told of this completion — the door answered `queued`, or the act was resumed — so it is said in the audit log.
    logInternalAudit({ method: 'DELETE', path: `internal:space-act:${entry.localId}:${id}`, operation: SPACE_ACT_COMPLETED_OPERATION, spaceId: entry.localId });
  } else if (!waiters.has(id)) {
    // A passed round's act nobody is waiting for — a relay, gossip, the tick, or a door that already answered (X17, VR7): one entry
    // per round it carried out. The request a door is still waiting on is that door's route's own entry.
    for (const r of covered) auditRoundEffect(ROUND_SPACE_ACT_OPERATION, r.networkId, r.roundId, entry.localId);
  }
  return result(entry, id, {
    ok: true, rounds: covered,
    ...(outcome.counts ? { counts: outcome.counts } : {}),
    ...(outcome.removedHere !== undefined ? { removedHere: outcome.removedHere } : {}),
    ...(outcome.renamed ? { renamed: outcome.renamed } : {}),
  });
}

/** The audit operation of an act with no round that completed after its door answered (or with no door at all). Declared beside the
 *  round effects (`networks/round-audit.ts`), which `audit/middleware.ts` re-exports without importing this module. */
export { SPACE_ACT_COMPLETED_OPERATION };

function failed(id: string, entry: SpaceActEntry, err: unknown, via: string): SpaceRoundSettled {
  if (closed) {
    // The store is closing under the body: nothing is recorded, and the entry resumes at once after the next start.
    counters?.spaceActsTotal.inc({ kind: entry.kind, via, outcome: 'interrupted' });
    log.info(`${entry.kind} of '${peerText(entry.localId)}' interrupted by shutdown; resumes after the next start`);
    return interrupted(entry, id);
  }
  try { hooks.afterBodyFailed?.(entry, err); } catch { /* a test hook does not change the failure */ }
  const attempts = (readEntry(id)?.attempts ?? entry.attempts) + 1;
  const retryAt = new Date(Date.now() + backoffDelayMs(attempts - 1, 60_000, 3_600_000)).toISOString();
  const sentence = `The ${entry.kind} of space '${entry.localId}' did not complete; it is retried automatically at ${retryAt}.`;
  try {
    mutateConfig(cfg => {
      const e = cfg.pendingSpaceActs?.find(x => x.id === id);
      if (e) { e.attempts = attempts; e.retryAt = retryAt; e.state = 'owed'; e.lastError = sentence; }
    });
  } catch (writeErr) {
    log.error(`the failed ${entry.kind} of '${peerText(entry.localId)}' could not be recorded as owed: ${peerText(writeErr)}`);
  }
  counters?.spaceActsTotal.inc({ kind: entry.kind, via, outcome: 'failed' });
  counters?.spaceActRetriesTotal.inc({ kind: entry.kind });
  // A failure on the store's side is said once, with its text, by the door or walk that answers it; this line names only the act then.
  const storeSide = storeIsNotAnswering(err) || classifyReadFailure(err).status >= 500;
  failureSaid(id, () => log.error(storeSide ? `${peerText(sentence)} The store failed it.` : `${peerText(sentence)} Cause: ${peerText(err)}`));
  return result(entry, id, { ok: false, error: sentence, cause: err, retryAt });
}

function contextFor(entry: SpaceActEntry): SpaceActBodyContext {
  const what = `the ${entry.kind} of '${entry.localId}'`;
  return {
    entry,
    async deleteInBatches(collection, filter, remove) {
      const coll = getDb().collection<{ _id: unknown }>(collection);
      let total = 0;
      let lastDeleted = 0;
      for (;;) {
        let deleted: number | null;
        try {
          deleted = await withinTimeBound((async () => {
            const ids = (await coll.find(filter as never, { projection: { _id: 1 } }).sort({ _id: 1 })
              .limit(spaceActKnob('SPACE_ACT_BATCH')).toArray()).map(d => d._id);
            if (ids.length === 0) return null;
            await hooks.beforeBatch?.(collection, ids.length);
            const r = await remove(ids);
            await hooks.afterBatch?.(collection, ids.length);
            return r.deletedCount ?? 0;
          })(), spaceActKnob('SPACE_ACT_OP_MS'), `a batch of ${what} in ${collection}`);
        } catch (err) {
          // A bound that ended a batch after the one before it deleted something is progress, not failure: the batch runs again.
          if ((isTimeBoundEnded(err) || isWriteTimeout(err)) && lastDeleted > 0) {
            counters?.spaceActBatchesRetriedTotal.inc();
            lastDeleted = 0;
            continue;
          }
          throw err;
        }
        if (deleted === null) return total;
        total += deleted;
        lastDeleted = deleted;
      }
    },
    fileTree: (fn) => withinFsBound(async () => { await hooks.atFileTree?.(entry.localId); return fn(); },
      spaceActKnob('SPACE_ACT_FS_MS'), `the file tree of ${what}`),
    claimWait: (fn) => withinTimeBound(fn(), spaceActKnob('SPACE_ACT_CLAIM_MS'), `the media claims of ${what}`),
  };
}

// ── resume, retry, shutdown ─────────────────────────────────────────────────────────────────────────────────────

const due = (e: SpaceActEntry, now: number): boolean => e.state !== 'owed' || e.retryAt === undefined || Date.parse(e.retryAt) <= now;

/**
 * Run every entry on disk that is due, after listen, one walk over their spaces: each space isolated (a failure in one never stops the
 * others), a failure said through the shared reporter and LEFT owed. An entry interrupted by a shutdown is due at once; an owed one waits
 * for its `retryAt` (the tick takes it then).
 */
export async function resumeSpaceActs(now: number = Date.now()): Promise<void> {
  const entries = standingEntries().filter(e => due(e, now));
  if (entries.length === 0) return;
  const bySpace = new Map<string, string[]>();
  for (const e of entries) {
    const ids = bySpace.get(e.localId);
    if (ids) ids.push(e.id); else bySpace.set(e.localId, [e.id]);
  }
  await eachSpace('Resume of space acts', [...bySpace.keys()], async (spaceId) => {
    for (const id of bySpace.get(spaceId) ?? []) {
      const r = await runSpaceAct(id, { via: 'resume' });
      if (!r.ok && !r.interrupted && !r.refused) throw r.cause ?? new Error(r.error);
    }
  }, { limit: bySpace.size });
}

/** Start every owed entry whose `retryAt` has passed at `now` — the round-expiry tick's retry. Joins a run already going. */
export function retryOwedSpaceActs(now: number): Promise<SpaceRoundSettled[]> {
  const owed = standingEntries().filter(e => e.state === 'owed' && due(e, now));
  return Promise.all(owed.map(e => runSpaceAct(e.id, { via: 'tick' })));
}

/**
 * Shutdown: refuse every new act and say what is left — registered, draining or running. Nothing waits; each entry is on disk and
 * resumes after the next start.
 */
export function closeSpaceActs(): { left: { kind: SpaceActKind; localId: string; entryId: string; state: string }[] } {
  closed = true;
  for (const item of [...spaceOrder.close(), ...lanes.close()]) item.abandon();
  const left = standingEntries().filter(e => e.state !== 'owed')
    .map(e => ({ kind: e.kind, localId: e.localId, entryId: e.id, state: e.state }));
  return { left };
}

/** Report every act running longer than `SLOW_SPACE_ACT_MS` — reported, never cut. */
export function reportSlowSpaceActs(now: number): void {
  for (const [id, s] of startedAt) {
    if (now - s.at < spaceActKnob('SLOW_SPACE_ACT_MS')) continue;
    slowSaid(id, () => log.warn(`${s.kind} of '${peerText(s.localId)}' has been running for ${Math.round((now - s.at) / 1000)}s`));
  }
}

// ── what the gauges and the stand-aside read ────────────────────────────────────────────────────────────────────

/** A body for `localId` is in its lane NOW. */
export function spaceActRunning(localId: string): boolean {
  return (runningBySpace.get(localId) ?? 0) > 0;
}

/** THE counter: bodies running now, every kind. */
export function spaceActsRunning(): number {
  return runningCount;
}

/** Entries owed (failed, waiting for their retry), from the live config. */
export function owedSpaceActCount(): number {
  return standingEntries().filter(e => e.state === 'owed').length;
}

/** Age in seconds of the oldest owed entry's registration, 0 when none is owed. */
export function oldestOwedSpaceActSeconds(now: number = Date.now()): number {
  const owed = standingEntries().filter(e => e.state === 'owed').map(e => Date.parse(e.registeredAt)).filter(Number.isFinite);
  return owed.length === 0 ? 0 : Math.max(0, Math.round((now - Math.min(...owed)) / 1000));
}

/** Entries waiting for their space's transfers to end, by kind. */
export function waitingSpaceActs(): Record<SpaceActKind, number> {
  const out: Record<SpaceActKind, number> = { delete: 0, wipe: 0, rename: 0 };
  for (const e of standingEntries()) if (e.state === 'draining') out[e.kind]++;
  return out;
}

// ── seams for tests ─────────────────────────────────────────────────────────────────────────────────────────────

/** Bodies the runner started since the last reopen, by kind — the REAL bodies, which is what "acted once" counts. */
export function spaceActBodyRuns(): Readonly<Record<SpaceActKind, number>> {
  return { ...bodyRuns };
}

export function setSpaceActKnobsForTest(k: Partial<SpaceActKnobs> | null): void {
  knobs = k ? { ...knobs, ...k } : {};
}

export function setSpaceActHooksForTest(h: Partial<SpaceActHooks> | null): void {
  hooks = h ? { ...h } : {};
}

/** An in-process boot keeps module state: reopen the runner, empty its queues, counts and the fence's counts. */
export function reopenSpaceActsForTest(): void {
  closed = false;
  spaceOrder.close();
  lanes.close();
  spaceOrder = limiterOf();
  lanes = limiterOf();
  jobs.clear();
  waiters.clear();
  runningBySpace.clear();
  runningCount = 0;
  startedAt.clear();
  bodyRuns = { delete: 0, wipe: 0, rename: 0 };
  resetSpaceTransfersForTest();
}
