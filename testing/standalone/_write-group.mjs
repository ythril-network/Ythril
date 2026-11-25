/**
 * The fixture the write-group tests share (`Q-760`, `brain/write-plan/write-group.ts`): a configured space on the test Mongo, planned writes
 * built in the shape the four planners hand the commit, and the observers the tests read the group through.
 *
 * ## Why a module
 *
 * Five -db files hold one rule each about the same writer. Each needs the same space, the same plan shapes and the same way of seeing what a
 * transaction did; a copy per file is the copy that drifts, so a plan shape fixed in one file would still be wrong in the next.
 *
 * ## What it does not do
 *
 * It does not decide anything a test asserts. A plan is the shape `WritePlan` (`write-plan/types.ts`) states: an insert carries the whole
 * document without `seq`, a converge its `$set` and the `expectSeq` it was planned against. The commit stamps the versions and positions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { ASYNC_MUTATORS } from './_document-mutators.mjs';

export const SPACE = 'general';
export const AUTHOR = { instanceId: 'write-group-test', instanceLabel: 'test' };

/**
 * Open the test Mongo under `suite`, write a config naming the one space, and load the server modules the tests call.
 * `cleanup()` closes the store and removes the config folder.
 */
export async function openWriteGroupFixture(suite) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-${suite}-`));
  process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
  process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
  const mongo = await openTestMongo(suite);
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: AUTHOR.instanceId, instanceLabel: AUTHOR.instanceLabel, tokens: [], networks: [],
    spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
  }, null, 2), { mode: 0o600 });
  const loader = await import('../../server/dist/config/loader.js');
  loader.loadConfig();
  // RED-RUN FALLBACK (removed with the implementation): on the base the group writer does not exist, and a group of plans is written by
  // `commitPlans`, stage by stage — so each spec's red line is that writer's partial landing, not a missing module.
  const group = await import('../../server/dist/brain/write-plan/write-group.js').catch(() => null);
  const commit = await import('../../server/dist/brain/write-plan/commit.js');
  const held = await import('../../server/dist/brain/held-transaction.js');
  const coll = (name) => mongo.col(`${SPACE}_${name}`);
  return {
    mongo, loader, group, commit, held, coll,
    /** Write `plans` as one group. */
    commitGroup: (plans) => (group ? group.commitWriteGroup(SPACE, plans) : commit.commitPlans(SPACE, plans)),
    /** Empty every collection a group writes. */
    async clear() {
      for (const c of ['facts', 'entities', 'edges', 'chrono', 'links', 'tombstones', 'embed_jobs']) await coll(c).deleteMany({});
    },
    async cleanup() {
      await closeTestMongo();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** A fact id the tests can tell apart: `ffffffff-0000-4000-8000-<n, 12 hex digits>`. */
export const factId = (n) => `ffffffff-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** An entity id: `eeeeeeee-0000-4000-8000-<n>`. */
export const entityId = (n) => `eeeeeeee-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const NOW = '2026-11-25T00:00:00.000Z';

/** The stored body of a fact, `seq` aside, as `planFact` builds it for an insert. */
export function factDoc(id, text, extra = {}) {
  return { _id: id, spaceId: SPACE, fact: text, tags: [], entityIds: [], author: AUTHOR, createdAt: NOW, updatedAt: NOW, ...extra };
}

/** An insert plan of a fact. `enqueue`: an embed job is owed once it lands. `links`: entity ids its link rows should name. */
export function insertFact(id, text, { enqueue = false, links, pad } = {}) {
  const doc = factDoc(id, text, pad === undefined ? {} : { pad });
  return {
    kind: 'fact', spaceId: SPACE, id, op: 'insert', doc, result: doc, enqueue, minted: true, dupeRules: false,
    ...(links ? { links: { fromKind: 'fact', desired: { entity: links }, author: AUTHOR } } : {}),
  };
}

/** A converge plan of a stored fact: `set` brings it to `text`, landing only while the record still has `expectSeq`. */
export function convergeFact(id, text, expectSeq, { enqueue = false } = {}) {
  const set = { fact: text, updatedAt: NOW };
  return {
    kind: 'fact', spaceId: SPACE, id, op: 'converge', set, expectSeq, result: { _id: id, fact: text }, enqueue, minted: false, dupeRules: false,
  };
}

/** An insert plan of an entity. */
export function insertEntity(id, name) {
  const doc = { _id: id, spaceId: SPACE, name, type: 'person', tags: [], properties: {}, author: AUTHOR, createdAt: NOW, updatedAt: NOW };
  return { kind: 'entity', spaceId: SPACE, id, op: 'insert', doc, result: doc, enqueue: false, minted: true, dupeRules: false };
}

/** Settle `promise` to `{ value }` or `{ error }`, so a test asserts on what the writer did rather than on an exception's path. */
export const settle = (promise) => promise.then(value => ({ value }), error => ({ error }));

/**
 * Watch every write call made on `Collection.prototype` while a transaction is open on any session, and say which of them carried no session.
 *
 * ## What it prevents
 *
 * A write made inside the group's callback without the session is not part of the transaction: it lands at once and survives the abort
 * (probe E4, `E:/TMP/Ythril/scratch/b272/design/design.md`). Counting what landed after an abort sees it only when the write is to a
 * collection the test counts; this sees every one. The window is the transaction's: from `startTransaction` to `commitTransaction` or
 * `abortTransaction`, so what runs after commit (embed jobs, take-backs) is not held to it. The version counter (`ythril_counters`) is
 * outside by design: an aborted run leaves gaps in the versions, never a version used twice.
 *
 * @returns {{ sessionless: () => string[], writes: () => number, written: () => string[], restore: () => void }}
 */
export function watchSessionlessWrites(mongo) {
  const collProto = Object.getPrototypeOf(mongo.col('probe'));
  const session = mongo.getMongo().startSession();
  const sessionProto = Object.getPrototypeOf(session);
  void session.endSession();
  let open = 0;
  let writes = 0;
  const missing = [];
  const inside = new Set();
  const originals = Object.fromEntries(ASYNC_MUTATORS.map(m => [m, collProto[m]]));
  const sessionOriginals = { start: sessionProto.startTransaction, commit: sessionProto.commitTransaction, abort: sessionProto.abortTransaction };
  for (const m of ASYNC_MUTATORS) {
    collProto[m] = function watched(...args) {
      if (open > 0 && this.collectionName !== 'ythril_counters') {
        writes++;
        inside.add(this.collectionName);
        const carries = args.some(a => a && typeof a === 'object' && !Array.isArray(a) && a.session && typeof a.session.inTransaction === 'function');
        if (!carries) missing.push(`${m} on ${this.collectionName}`);
      }
      return originals[m].apply(this, args);
    };
  }
  sessionProto.startTransaction = function started(...args) { open++; return sessionOriginals.start.apply(this, args); };
  const closing = (orig) => async function closed(...args) { try { return await orig.apply(this, args); } finally { open = Math.max(0, open - 1); } };
  sessionProto.commitTransaction = closing(sessionOriginals.commit);
  sessionProto.abortTransaction = closing(sessionOriginals.abort);
  return {
    sessionless: () => [...missing],
    writes: () => writes,
    /** The collections written inside a transaction, sorted. */
    written: () => [...inside].sort(),
    restore() {
      Object.assign(collProto, originals);
      sessionProto.startTransaction = sessionOriginals.start;
      sessionProto.commitTransaction = sessionOriginals.commit;
      sessionProto.abortTransaction = sessionOriginals.abort;
    },
  };
}

/** Count the transactions started from now on (`startTransaction` on any session) until `restore()`. */
export function countTransactions(mongo) {
  const session = mongo.getMongo().startSession();
  const proto = Object.getPrototypeOf(session);
  void session.endSession();
  const original = proto.startTransaction;
  let started = 0;
  proto.startTransaction = function counted(...args) { started++; return original.apply(this, args); };
  return { started: () => started, restore: () => { proto.startTransaction = original; } };
}
