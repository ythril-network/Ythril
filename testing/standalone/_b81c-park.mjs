/**
 * Park a write that carries a POSITION (`pos`) behind a gate the test opens, and read the position it carries.
 *
 * ## The question it answers
 *
 * "Which position is this in-flight write about to commit, and can the test hold it there?" `_write-faults.mjs parkWrites` answers it
 * for a `seq` (`seqCarriedBy`); bundle-81 pages by `pos`, and a write stamps `{seq, pos, posAtSeq, writtenHere}` in one patch (rev 8 §1b),
 * so the position is read out of the same write arguments.
 *
 * ## What it prevents
 *
 * A hold test that parks the wrong write (before the stamp, or one that carries no position) passes whatever the code does. `arm`
 * parks only a write whose arguments carry a numeric `pos`, and `reached` hands the test that number, so the test can assert the hold
 * sits between the stamp and the commit. A write that ends without ever carrying a `pos` is the caller's to report (the test races
 * `reached` against the write's own end, as `a-pull-never-passes-an-uncommitted-seq-db` does).
 */
import { ASYNC_MUTATORS } from './_document-mutators.mjs';

/** The lowest numeric `pos` anywhere in a write's arguments (a `$set`, a replacement, an inserted document, a bulk op, a pipeline stage), or undefined. */
export function posCarriedBy(args) {
  const seen = new WeakSet();
  let lowest;
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object' || depth > 7 || seen.has(v)) return;
    seen.add(v);
    if (typeof v.pos === 'number' && (lowest === undefined || v.pos < lowest)) lowest = v.pos;
    for (const [k, child] of Object.entries(v)) if (k !== 'session') walk(child, depth + 1);
  };
  walk(args, 0);
  return lowest;
}

/** Park writes on `Collection.prototype` whose arguments carry a `pos`. Restore it BEFORE the door closes. */
export function parkPositionWrites(proto) {
  const originals = {};
  let armed = [];
  for (const m of ASYNC_MUTATORS) {
    const orig = proto[m];
    originals[m] = orig;
    proto[m] = async function parked(...args) {
      const pos = posCarriedBy(args);
      const a = pos === undefined ? undefined : armed.find(x => x.left > 0 && x.names.includes(this.collectionName) && x.when(m, args));
      if (a) {
        a.left -= 1;
        a.reached({ method: m, pos, inSession: args.some(x => x && typeof x === 'object' && x.session !== undefined) });
        await a.gate;
      }
      return orig.apply(this, args);
    };
  }
  return {
    /** Park the next `count` position-carrying writes to any of `names`; `reached` is `{ method, pos, inSession }` of the first. */
    arm(names, { count = 1, when = () => true } = {}) {
      let reached, release;
      const reachedP = new Promise(r => { reached = r; });
      const gate = new Promise(r => { release = r; });
      armed.push({ names: [].concat(names), left: count, when, reached, gate });
      return { reached: reachedP, release };
    },
    restore() {
      armed = [];
      for (const [m, f] of Object.entries(originals)) proto[m] = f;
    },
  };
}
