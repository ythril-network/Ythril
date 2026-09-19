/**
 * A Ythril client that records what it was asked to write, so `writeSpace` runs for real without a server.
 *
 * ## What this makes un-skippable
 *
 * The ids. A hand-written stub returns something id-shaped, and the easiest something is a constant — at
 * which point every link in the space points at one record and every assertion about linking passes. The
 * writer's whole job is resolving local keys to ids, so a stub that cannot tell two records apart tests
 * nothing while looking like it tests everything. `nextId` is monotonic and `assertDistinct` is run on
 * every read, so that failure is impossible rather than merely unlikely.
 *
 * ## Why it has no `ok`/`fail` switch
 *
 * It answers one question: *what did the writer send?* A failure-injecting variant answers a different one
 * and belongs in its own helper — a shared stub that grows a flag per caller makes every test depend on
 * every other test's needs.
 */

/**
 * @returns a client with a `wrote` bag holding, per collection, the record objects the writer sent — in the
 *   order it sent them. Every call returns `{ id }` with an id no other call returned.
 */
export function recordingYthril() {
  let n = 0;
  const wrote = { entities: [], chrono: [], memories: [], edges: [], files: [] };
  const seen = new Set();
  const id = () => {
    const v = `id-${++n}`;
    // A stub that repeats an id is the failure this module exists to prevent; refuse rather than return it.
    if (seen.has(v)) throw new Error(`recordingYthril issued '${v}' twice — ids must be distinct`);
    seen.add(v);
    return v;
  };
  const push = (bucket) => async (_space, record) => { wrote[bucket].push(record); return { id: id() }; };
  return {
    wrote,
    createSpace: async () => ({}),
    writeEntity: push('entities'),
    writeChrono: push('chrono'),
    writeMemory: push('memories'),
    writeEdge: push('edges'),
    writeFile: push('files'),
  };
}
