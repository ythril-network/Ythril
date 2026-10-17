/**
 * What the store was told, in what order, about one space's collections: the question "did the first delete of the act come after the last
 * write of the exchange", answered once for every test that holds an act to the exchange it interrupted (bundle-106, §3.3a, R-W4a-d).
 *
 * ## What it is
 *
 * A listener on the server's own Mongo client (the door must be opened with `monitorCommands: true`) that numbers every command of the harness
 * database as it STARTS and as it ENDS, with the collection it names. `firstDeleteStart` is the number of the first delete command on a space's
 * collections; `lastWriteEnd` the number of the last write that finished on them. "A follows B" is then a comparison of two integers from one
 * sequence, never of two clocks.
 *
 * ## The guard a hand-written copy drops
 *
 * **Completion, not start.** A write that was admitted before the act and LANDS after its first delete started first and finished last: ordering
 * by the moment the command was issued reads that as safe. `lastWriteEnd` is taken from the command's success event, matched to its start by
 * request id, so a write that survives the delete is found by where it ended.
 *
 * ## What it is not
 *
 * Not a command counter (`commandsDuring` in `_push-door.mjs` counts one window as strings) and not a filter of the server's housekeeping: the
 * caller names the collections whose order it asks about, so a write to an unrelated collection cannot make an order assertion pass or fail.
 */

/** The write commands the server's driver issues for a document write. */
const WRITES = new Set(['insert', 'update', 'findAndModify', 'findandmodify']);

/** An update document's operators and the paths each sets, sorted: `$unset(faceEntityId,faceScore)`; a replacement is `replace`. */
const updateKeys = (u) => (u && typeof u === 'object' && !Array.isArray(u)
  ? Object.keys(u).sort().map(k => (k.startsWith('$') && u[k] && typeof u[k] === 'object' ? `${k}(${Object.keys(u[k]).sort().join(',')})` : 'replace')).join(' ')
  : Array.isArray(u) ? 'pipeline' : '');

/** What a write command does, without its values: the command, the collection and, for an update, each statement's operators, paths and `multi`. */
function shapeOf(name, coll, command) {
  if (name === 'update') {
    const statements = (command?.updates ?? []).map(s => `${updateKeys(s?.u)}${s?.multi ? ' multi' : ''}${s?.upsert ? ' upsert' : ''}`);
    return `update ${coll} [${[...new Set(statements)].sort().join('; ')}]`;
  }
  if (name === 'findAndModify' || name === 'findandmodify') return `${name} ${coll} [${updateKeys(command?.update)}]`;
  return `${name} ${coll}`;
}

/**
 * @param {object} mongo  the server's `db/mongo.js` module (`door.mongo`), connected with command monitoring
 */
export function openStoreCommandLog(mongo) {
  const client = mongo.getMongo();
  const db = mongo.getDb().databaseName;
  let seq = 0;
  /** @type {{ n: number, phase: 'start' | 'end', name: string, coll: string, ok: boolean }[]} */
  let events = [];
  const byRequest = new Map();

  const onStarted = (ev) => {
    if (ev.databaseName !== db) return;
    const coll = String(ev.command?.[ev.commandName] ?? '');
    const shape = shapeOf(ev.commandName, coll, ev.command);
    byRequest.set(ev.requestId, { name: ev.commandName, coll, shape });
    events.push({ n: seq++, phase: 'start', name: ev.commandName, coll, ok: true, shape });
  };
  const onEnded = (ok) => (ev) => {
    const started = byRequest.get(ev.requestId);
    if (!started) return;
    byRequest.delete(ev.requestId);
    events.push({ n: seq++, phase: 'end', name: started.name, coll: started.coll, ok, shape: started.shape });
  };
  const onSucceeded = onEnded(true);
  const onFailed = onEnded(false);
  client.on('commandStarted', onStarted);
  client.on('commandSucceeded', onSucceeded);
  client.on('commandFailed', onFailed);

  const named = (space, parts) => new Set(parts.map(p => `${space}_${p}`));
  return {
    /** Forget everything so far (the fixture's own writes). */
    reset() { events = []; byRequest.clear(); },
    /** Number of the first DELETE command on any of `space`'s `parts` that started, or -1. */
    firstDeleteStart(space, parts) {
      const colls = named(space, parts);
      return events.find(e => e.phase === 'start' && e.name === 'delete' && colls.has(e.coll))?.n ?? -1;
    },
    /** Number of the last write on `space`'s `parts` that finished successfully, or -1. */
    lastWriteEnd(space, parts) {
      const colls = named(space, parts);
      const done = events.filter(e => e.phase === 'end' && e.ok && WRITES.has(e.name) && colls.has(e.coll));
      return done.length ? done[done.length - 1].n : -1;
    },
    /** Writes on `space`'s `parts` that FINISHED after the first delete on them started: what survived, or was written back, past the act. */
    writesEndedAfterFirstDelete(space, parts, { actOperations } = {}) {
      const first = this.firstDeleteStart(space, parts);
      if (first < 0) return [];
      const colls = named(space, parts);
      return events.filter(e => e.n > first && e.phase === 'end' && e.ok && WRITES.has(e.name) && colls.has(e.coll))
        .filter(e => !actOperations?.has(e.shape))
        .map(e => `${e.name} ${e.coll}`);
    },
    /**
     * The shapes of the writes on `space`'s `parts` in the log so far. Asked after an act ran ALONE (nothing else writing the space), it is the
     * set of operations the act body issues - what `writesEndedAfterFirstDelete` leaves out with `{ actOperations }`, so the rule reads "no
     * EXCHANGE write lands after the act's first delete" without a clock: an act's own write (the wipe's face unlabel on the files rows) is the
     * act, not something it raced. A shape is the command and its collection plus, for an update, each statement's operators and paths and its
     * `multi` - the arrival writer's upserts and the act's unlabel never share one.
     */
    writeShapes(space, parts) {
      const colls = named(space, parts);
      return new Set(events.filter(e => e.phase === 'start' && WRITES.has(e.name) && colls.has(e.coll)).map(e => e.shape));
    },
    /** The sequence as one line, for a failure message (the last `last` events: a long window is a wall of text). */
    describe(space, parts, last = 14) {
      const colls = named(space, parts);
      return events.filter(e => colls.has(e.coll) && (e.name === 'delete' || WRITES.has(e.name))).slice(-last).map(e => `${e.n}:${e.phase}:${e.name}:${e.coll}`).join(' ');
    },
    stop() {
      client.off('commandStarted', onStarted);
      client.off('commandSucceeded', onSucceeded);
      client.off('commandFailed', onFailed);
    },
  };
}
