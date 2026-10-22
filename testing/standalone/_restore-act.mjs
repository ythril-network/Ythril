/**
 * What a test of the RESTORE ACT needs (bundle-157, Q-552/Q-554), answered once: a backup of the harness database under the
 * instance's own backups root, the data router's restore doors driven past their middleware, and the restore acts the route
 * registered, run through the real runner.
 *
 * ## The question each answers, and what a hand-written copy drops
 *
 * - {@link takeBackup} - *"a backup this instance would list"*. It dumps through the server's own `dumpDatabase` into
 *   `<dataRoot>/backups/<id>`, the directory the route resolves a `backupId` under; a dump written anywhere else is a backup the
 *   route answers 404 for, and the test is then about the 404.
 * - {@link dataRoute} / {@link answerOf} - one data-router handler, found by method and path, answered as `{ status, body }`. A route
 *   the design names and the router lacks is `null`, so {@link callDataDoor}'s assertion names the missing door instead of a TypeError.
 * - {@link restoreEntries} / {@link startRestoreActs} - the standing acts of kind `restore` and their runs. The route may already have
 *   started them; `runSpaceAct` of a running entry joins its run, so starting them again here is never a second body.
 *
 * ## What it does not do
 *
 * It does not replace a body, a hook or a knob: those are the runner's `setSpaceActHooksForTest` / `setSpaceActKnobsForTest`, which a
 * test installs, and `_space-act-harness.mjs` resets.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { testMongoUri } from './_mongo-harness.mjs';
import { entriesOf, untilRunnerIdle } from './_space-act-harness.mjs';

/** The modules every restore-act test reads: the data router, the runner, the config loader and the dump. */
export async function restoreModules() {
  const { dataRouter } = await import('../../server/dist/api/data.js');
  const runner = await import('../../server/dist/spaces/space-act-runner.js');
  const loader = await import('../../server/dist/config/loader.js');
  const dump = await import('../../server/dist/db/dump.js');
  return { dataRouter, runner, loader, dump };
}

/** The final handler of `method routePath` on `router`, past its middleware; `null` when the router has no such route. */
export function dataRoute(router, method, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods?.[method]);
  return layer ? layer.route.stack.at(-1).handle : null;
}

/** Invoke a route handler as a request reaches it; resolves `{ status, body }` (a handler that throws is a 500). */
export async function answerOf(handler, { body = {}, query = {}, params = {} } = {}) {
  const res = {
    statusCode: 200, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
    setHeader() { return this; }, set() { return this; }, get() { return undefined; },
  };
  const req = { method: 'POST', params, query, body, headers: {}, ip: '127.0.0.1', authToken: { id: 'restore-test', name: 'restore-test' }, get: () => undefined };
  try { await handler(req, res); } catch (err) { return { status: 500, body: { error: String(err?.message ?? err) }, threw: err }; }
  return { status: res.statusCode, body: res.body };
}

/** The data router's door `method routePath`, asserted present (naming the design's door when it is not), then answered. */
export async function callDataDoor(router, method, routePath, opts) {
  const handler = dataRoute(router, method, routePath);
  assert.ok(handler, `the data router has no ${method.toUpperCase()} ${routePath}: the door the design names does not exist`);
  return answerOf(handler, opts);
}

/** `POST /api/admin/data/restore` with `body` (`{ backupId, leaveOut? }`). */
export const requestRestore = (router, body) => callDataDoor(router, 'post', '/restore', { body });

/** Dump the harness database of `suite` into `<dataRoot>/backups/<id>` through the server's own dump; returns `{ id, dir, manifest }`. */
export async function takeBackup(suite, id) {
  const { getDataRoot } = await import('../../server/dist/config/loader.js');
  const { dumpDatabase } = await import('../../server/dist/db/dump.js');
  const dir = path.join(getDataRoot(), 'backups', id);
  const manifest = await dumpDatabase(testMongoUri(`ythril_harness_${suite}`), dir);
  return { id, dir, manifest };
}

/** The standing acts of kind `restore`, as the live config holds them. */
export const restoreEntries = (loader) => entriesOf(loader).filter(e => e.kind === 'restore');

/** Start (or join) the run of every standing restore act; the promises, in entry order. */
export const startRestoreActs = (runner, loader) => restoreEntries(loader).map(e => runner.runSpaceAct(e.id, { via: 'test' }));

/** Run every standing restore act to its end, then wait until the runner is idle; the settled answers. */
export async function settleRestoreActs(runner, loader) {
  const out = await Promise.all(startRestoreActs(runner, loader));
  await untilRunnerIdle(runner, loader);
  return out;
}

/**
 * A restore through the route, whatever today's route answers: the acts it registered (if any) are run to their end. For a test whose
 * rule is about the OUTCOME (what the database and the marks are afterwards), so it is red on the outcome and not on the status.
 */
export async function restoreToTheEnd(modules, body) {
  const answer = await requestRestore(modules.dataRouter, body);
  assert.ok(answer.status === 200 || answer.status === 202, `POST /restore failed: ${answer.status} ${JSON.stringify(answer.body)}`);
  await settleRestoreActs(modules.runner, modules.loader);
  return answer;
}

/** A restore through the route that answered 202 with acts registered: asserted, so a test past it is about the acts. */
export async function restoreAsActs(modules, body) {
  const answer = await requestRestore(modules.dataRouter, body);
  assert.equal(answer.status, 202, `POST /restore answered ${answer.status}, not 202 with its acts registered - the restore is not a space act: ${JSON.stringify(answer.body)}`);
  assert.ok(restoreEntries(modules.loader).length > 0, `POST /restore answered 202 and registered no restore act: ${JSON.stringify(answer.body)}`);
  return answer;
}

// ── what a restore says about a space's files (bundle-111, Q-557) ──────────────────────────────────────────────────────────

/**
 * The classes a restore's per-space `files` report names, in the order the design lists them (rev 3 step 6). The first three are the
 * pull's `FileRepairReason`s (`sync/file-sync.ts` `repairReasonOf`); the last two are the restore's own and are NOT pull reasons (V-S7).
 */
export const FILE_CLASSES = Object.freeze(['missing_row', 'stale_row', 'unprocessed', 'row_without_bytes', 'soft_deleted_with_bytes']);

/**
 * The per-class path cap of the report (rev 3 step 8: "at most 10 paths per class"). The server's named constant is the authority; this is
 * the number the design states, and a suite that disagrees with it fails on the design, not on a guess.
 */
export const REPORT_PATHS_PER_CLASS = 10;

/**
 * The shape this suite reads, one place: a space's row of `GET /api/admin/data/restore` carries
 * `files: { checked: true, classes: { <class>: { count, paths } } }` (a class with nothing to say may be absent) or
 * `files: { checked: false, reason }` when the check could not run. `count` is every file of that class; `paths` is at most
 * {@link REPORT_PATHS_PER_CLASS} of them, peerText-bounded.
 */
export const classOf = (files, cls) => files?.classes?.[cls] ?? { count: 0, paths: [] };

/** Every path a `files` report names, whatever its class. */
export const reportedPaths = (files) => FILE_CLASSES.flatMap(c => classOf(files, c).paths);

/** `GET /api/admin/data/restore`, asserted 200; the body. */
export async function restoreReportBody(router) {
  const answer = await callDataDoor(router, 'get', '/restore');
  assert.equal(answer.status, 200, `GET /restore answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

/** The space rows of a restore report, by space id. */
export const spaceRowsOfReport = (body) => Object.fromEntries((body?.spaces ?? []).map(s => [s.id, s]));

/** Restore `backupId` through the acts, run them to their end, and answer the report the operator would then read. */
export async function restoreThenReport(modules, backupId) {
  await restoreAsActs(modules, { backupId });
  await settleRestoreActs(modules.runner, modules.loader);
  return restoreReportBody(modules.dataRouter);
}
