/**
 * At most N things running per key, a bounded queue behind them, and a refusal past it — the bound a burst needs per key.
 *
 * ## What it prevents
 *
 * A caller that starts one piece of work per event, un-awaited, has no bound: ten thousand events are ten thousand simultaneous
 * outbound connections, and a key whose work hangs (one webhook sink) holds every one of its own and, through a single shared pool,
 * every other key's as well. `mapLimit` bounds a list that exists up front; this bounds work that ARRIVES, per key, so a hung key
 * holds only its own slots.
 *
 * ## What a hand-written copy drops
 *
 * **The bound on the queue.** A limiter that only caps concurrency is a queue that grows with the burst, in memory, for as long as
 * the key hangs. `submit` answers `refused` past `bound` (running plus queued) and the CALLER decides where the refused item goes
 * (the webhook dispatcher persists it); the limiter never drops an item silently and never throws one away. And **`close`**: it
 * hands back every item that was queued and never started, so a shutdown can persist them instead of losing them, and refuses
 * everything after.
 *
 * ## One question
 *
 * "May this item for this key start now, wait, or not be taken?" It does not persist, count or log: `run` is the caller's, and a
 * rejection from it is handed to `onError`, never swallowed. An idle key leaves no entry behind, so the map is bounded by the keys
 * with work in it.
 */

export type Admission = 'started' | 'queued' | 'refused';

export interface KeyedLimiterOptions<K, T> {
  /** How many items of one key run at once. A positive integer. */
  concurrency: number;
  /** The most items of one key running plus queued; at least `concurrency`. */
  bound: number;
  /** Runs one item. Called synchronously by `submit` when a slot is free, otherwise when one frees. */
  run(key: K, item: T): Promise<void>;
  /** A rejection from `run`: the slot is freed and the next item starts regardless. */
  onError(key: K, err: unknown): void;
}

export interface KeyedLimiter<K, T> {
  /** Take `item` for `key`: started now, queued behind the key's running items, or refused (the key is at its bound, or the limiter is closed). */
  submit(key: K, item: T): Admission;
  /** Refuse everything from now on and hand back the items that were queued and never started, oldest first per key. Running items are not touched. */
  close(): T[];
  readonly closed: boolean;
}

interface Lane<T> { running: number; queue: T[] }

export function keyedLimiter<K, T>({ concurrency, bound, run, onError }: KeyedLimiterOptions<K, T>): KeyedLimiter<K, T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`keyedLimiter: concurrency must be a positive integer, got ${concurrency}`);
  if (!Number.isInteger(bound) || bound < concurrency) throw new Error(`keyedLimiter: bound must be an integer of at least the concurrency (${concurrency}), got ${bound}`);
  const lanes = new Map<K, Lane<T>>();
  let closed = false;

  const start = (key: K, lane: Lane<T>, item: T): void => {
    lane.running++;
    let ran: Promise<void>;
    try { ran = run(key, item); } catch (err) { ran = Promise.reject(err); }
    // A reporter that itself throws must not leak the slot: the lane would then hold a running item that never ends.
    ran.catch(err => { try { onError(key, err); } catch { /* the slot frees below whatever the reporter did */ } }).then(() => {
      lane.running--;
      const next = lane.queue.shift();
      if (next !== undefined) start(key, lane, next);
      else if (lane.running === 0 && lanes.get(key) === lane) lanes.delete(key);
    });
  };

  return {
    submit(key, item) {
      if (closed) return 'refused';
      let lane = lanes.get(key);
      if (!lane) { lane = { running: 0, queue: [] }; lanes.set(key, lane); }
      if (lane.running + lane.queue.length >= bound) return 'refused';
      if (lane.running < concurrency) { start(key, lane, item); return 'started'; }
      lane.queue.push(item);
      return 'queued';
    },
    close() {
      closed = true;
      const queued: T[] = [];
      for (const lane of lanes.values()) queued.push(...lane.queue.splice(0));
      return queued;
    },
    get closed() { return closed; },
  };
}
