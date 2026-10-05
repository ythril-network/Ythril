/**
 * What the server is doing on one collection RIGHT NOW — the question "is a write of mine still alive", answered
 * from the server's own account (`currentOp`) rather than from the client's promise.
 *
 * ## Why a module
 *
 * A client promise that settled says the CLIENT stopped waiting. A driver timer fires before the server's own, so a
 * write answered "timed out" can still be alive in the server and land later (`Q-372`). Everything that must know the
 * write has really ENDED — a lock handed back (`_write-faults.mjs`), a space wiped (`_push-door.mjs`), the tests of
 * both — asks the server, and asks it the same way: this.
 *
 * ## The guard a hand-written copy drops
 *
 * **The poll's own command.** `currentOp` lists itself when it runs; filtered to a collection's namespace it does not
 * (its namespace is `admin.$cmd`), but a filter that was typed wrongly would match nothing, and "no active operation"
 * would pass over a write that is very much alive. So the namespace is built from the connected database's own name,
 * and `activeOperations` is exercised against a real stalled write by the tests that use it (`a-released-lock-leaves-no-live-write-db`).
 */

/** Command names a `command` operation carries when it is a write (`findAndModify` is the one that is reported as a command). */
const WRITE_COMMANDS = new Set(['findAndModify', 'findandmodify', 'insert', 'update', 'delete']);

/**
 * The WRITES active on `collName` of the connected database: `[{ op, ns, secs_running, writeConflicts, … }]`.
 *
 * **Writes only, and why.** A change stream's cursor is a `getMore` that is active for as long as the stream is open
 * (the push door's spaces keep one on their collections), so "no active operation" over everything would never hold
 * and a drain would wait for ever. Nothing but a write can land a document after the caller moved on.
 */
export async function activeOperations(mongo, collName) {
  const ns = `${mongo.getDb().databaseName}.${collName}`;
  const r = await mongo.getMongo().db('admin').command({ currentOp: 1, active: true, ns });
  return r.inprog.filter(o => ['insert', 'update', 'remove'].includes(o.op)
    || (o.op === 'command' && WRITE_COMMANDS.has(Object.keys(o.command ?? {})[0])));
}

/** One line per operation, for a failure message. */
export function describeOperations(ops) {
  return ops.map(o => `${o.op} on ${o.ns} running ${o.secs_running ?? '?'} s${o.writeConflicts ? `, ${o.writeConflicts} write conflicts` : ''}`).join('; ');
}
