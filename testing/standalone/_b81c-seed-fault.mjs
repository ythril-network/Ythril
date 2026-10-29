/**
 * Make the position clock's SEED read fail for one space: the descending read of the stored maximum `pos` (`(pos, _id)` read backwards,
 * limit 1, rev 8 §1b). Only that read rejects (a `find` whose `sort` names `pos: -1`), so the fault is the seed's and a page read, which
 * sorts ascending, is untouched.
 *
 * ## The question it answers
 *
 * "How does a test make exactly the seed of a stream fail, and end it?" Asked by the failed-seed test of decision 34 and by the
 * `positions-continue-above-every-start` test (a failed seed with the wall clock behind the stored maximum refuses the write).
 *
 * ## What it prevents
 *
 * A fault that rejects every read of the space also fails the thing the test claims still works (the page the peer is owed), and the
 * test then proves nothing about the seed. A space this process never stamped in must be used: a seeded stream never reads again.
 *
 * @param {object} mongo  the server's `db/mongo.js` module
 * @param {string} space
 * @param {{ field?: string, error?: Error }} [opts]  the stream's position field (`pos` for the records, `positionAt` for the file
 *   tombstones) and what the read rejects with
 * @returns {() => void} restores the driver
 */
export function failTheSeedRead(mongo, space, { field = 'pos', error = new Error('b81c: the seed read failed') } = {}) {
  const proto = Object.getPrototypeOf(mongo.col('probe'));
  const find = proto.find;
  proto.find = function failing(...args) {
    const cursor = find.apply(this, args);
    if (!String(this.collectionName).startsWith(`${space}_`)) return cursor;
    const sort = cursor.sort.bind(cursor);
    cursor.sort = (spec, ...rest) => {
      const out = sort(spec, ...rest);
      if (spec && typeof spec === 'object' && !Array.isArray(spec) && spec[field] === -1) {
        out.toArray = async () => { throw error; };
      }
      return out;
    };
    return cursor;
  };
  return () => { proto.find = find; };
}
