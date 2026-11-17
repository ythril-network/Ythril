/**
 * A bounded async loop: the one place that says how many jobs run at once (Q-863).
 *
 * ## What it prevents
 *
 * Preflight's pure test batches and its parse check each ran one child at a time, so the machine's other cores sat idle while one slow file
 * finished. Running them through a pool uses the cores, but a pool is only worth having if no caller can exceed the width it was given, and if
 * a width that starts nothing cannot pass for a clean run: a width of 0, a fraction or a string would otherwise start no job and answer an empty
 * result. The width is therefore checked here, before any job starts, and refused (the promise rejects) unless it is a positive integer.
 *
 * ## The rule
 *
 * `poolEach(items, width, work)` calls `work(item, index)` for every item with at most `width` calls alive at once, each worker taking the next
 * unstarted item when it finishes one (so a slow item holds one worker, not a whole row), and answers the results in INPUT order. An empty
 * list answers `[]` and starts nothing. A `work` that rejects rejects the pool; callers that must run every item to the end (the test units) give
 * a `work` that never rejects.
 */

/** Runs `work(item, index)` over `items`, at most `width` at once; answers the results in the order of `items`. */
export async function poolEach(items, width, work) {
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError(`poolEach: the width must be a positive integer, got ${String(width)}`);
  }
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
