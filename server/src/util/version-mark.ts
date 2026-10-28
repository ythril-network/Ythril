/**
 * How high may this space's version counter already have gone, as known OUTSIDE the database.
 *
 * ## The question it answers
 *
 * A space's version counter lives in `ythril_counters`, in the database. A restore onto an empty database, a counter wipe (`docker compose down -v`
 * with config.json kept), an admin import onto an emptied instance, or a rename whose counter move failed leaves it BELOW versions this instance
 * already handed out. The next edit is then stamped below the copy the peers hold, and every peer keeps its own: the edit is lost on every
 * peer, with no error on either side (Q-556). So this instance keeps a high-water mark per space in config.json (`versionMarks`), and
 * `util/version-stamp.ts` raises the counter to it before it stamps.
 *
 * ## The rule (owner decision 2026-10-28)
 *
 *  - **The mark follows the COUNTER**, never a stamp. After an allocation, when the counter it left is at or above the mark, the mark becomes
 *    `min(counter + {@link VERSION_MARK_STEP}, VERSION_FLOOR_CAP - {@link VERSION_MARK_STEP})`, and a save is asked for only when that is a raise. The
 *    counter takes the versions of records this instance held and never a held tombstone's term (`util/version-stamp.ts`), so a tombstone a peer
 *    planted cannot ratchet the mark.
 *  - **No write waits on the save.** Asking for it is synchronous and cheap (`saveConfigSoon`), inside a try that reports and never throws, and a
 *    no-op while no config is loaded. The mark is saved in steps: at most one save per {@link VERSION_MARK_STEP} versions plus one per space per
 *    process start. What a crash between two saves costs is stated where the saves are made (`config/loader.ts`).
 *  - **Read before the stamp, in ONE place**: `allocate` in `util/version-stamp.ts`. Nothing else reads a mark to move a counter, and
 *    `every-counter-writer-sits-behind-the-version-mark` holds that no other file writes the counter doc, so no restart or restore path can
 *    skip it.
 *
 * ## What it keeps, and what a hand-written copy would drop
 *
 *  - **A mark is read only as a valid number**: `Number.isSafeInteger(v) && 0 <= v <= VERSION_FLOOR_CAP - STEP`, for an OWN key of a plain object (an
 *    inherited name is never read), and written into an object with no prototype, so every space id is a plain key. A value above that limit would raise a counter into the ceiling reserve, where every later stamp is refused
 *    by every peer; a value that is not a number would raise it to nothing. Anything else is ignored and said once per space ({@link warnOnce}), and
 *    the next save rewrites the entry from memory.
 *  - **A read never lowers a valid mark** (an older config.json put back, a hand edit), and a garbage value never pins one, because "never lowered"
 *    holds for valid values only.
 *  - **It reaches every config object through the loader's overlay** ({@link registerConfigOverlay}), which the loader runs on every object it loads,
 *    reloads or writes: a caller holding a detached or fresh config object cannot drop the marks, and the loader does not import this module.
 *  - **The per-process state** (which spaces have stamped, the last counter each showed) is forgotten when the database is replaced underneath the
 *    process (`reportDatabaseReplaced`, the end of a restore), so the next allocation is a first one again.
 *
 * ## Residuals, stated so they are not rediscovered
 *
 * A crash or a lost config write after the counter passed the last SAVED mark, together with a database loss, can reuse the versions of that stretch.
 * config.json lost as well, or replaced by an older copy before the first start, is the ordinary D-48 case (records are sorted out by id and
 * version). A counter goes up by at most one step at each process start.
 */
import { col, onRecordCollectionWrite } from '../db/mongo.js';
import { EVERY_COLLECTION } from '../db/record-write-observer.js';
import { getConfig, isConfigLoaded, registerConfigOverlay, saveConfig, saveConfigSoon } from '../config/loader.js';
import type { Config, SpaceCounterDoc } from '../config/types.js';
import { countVersionCounterRaise, type VersionRaiseReason } from '../metrics/version-raise-count.js';
import { log, peerText } from './log.js';
import { VERSION_FLOOR_CAP } from './seq.js';
import { warnOnce } from './warn-once.js';

/** How far above the counter a mark is set, and so the most a counter goes up at a process start, and the interval between two saves of one space's mark. */
export const VERSION_MARK_STEP = 100_000;

/** The largest valid mark: a counter raised to it still has `VERSION_MARK_STEP` of room below the cap. */
const MARK_LIMIT = VERSION_FLOOR_CAP - VERSION_MARK_STEP;

/** Each space's mark, as this process knows it. Memory is the source the file is written from; the file can only raise it. */
const marks = new Map<string, number>();
/** The spaces this process has already stamped (or checked) since the database was last replaced. */
const started = new Set<string>();
/** The highest counter each space showed this process since the database was last replaced: a counter found below it has gone back. */
const seen = new Map<string, number>();
/** An entry of config.json that is not a valid mark, said once per space. */
const invalidSaid = warnOnce<string>();

/** Whether `v` is a version a counter may be raised to: a safe integer from 0 to the largest valid mark. */
function isValidMark(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MARK_LIMIT;
}

/** The space's mark as this process knows it, or `undefined` when it has none. */
export function versionMarkOf(spaceId: string): number | undefined {
  return marks.get(spaceId);
}

/** Raise the space's mark in memory to `target` when that is higher and valid. Answers whether it rose. */
function raiseMark(spaceId: string, target: number): boolean {
  if (!isValidMark(target)) return false;
  const current = marks.get(spaceId);
  if (current !== undefined && target <= current) return false;
  marks.set(spaceId, target);
  return true;
}

/**
 * Ask for the save of config.json that carries the marks. Synchronous, off the write's path: the flush runs on a later tick, and a failure
 * to ask is reported and never thrown into the write that raised the mark. A no-op while no config is loaded (a unit test, early boot).
 */
function askForSave(): void {
  try {
    if (isConfigLoaded()) saveConfigSoon(getConfig());
  } catch (err) {
    log.warn(`Could not ask for the save of the version marks in config.json: ${peerText(err)}`);
  }
}

/**
 * The mark follows the counter: called by `allocate` with the counter the allocation LEFT. Records what this process has seen of the counter, and
 * raises the mark to `min(counter + STEP, VERSION_FLOOR_CAP - STEP)` when the counter is at or above it (asking for a save only when that is a rise).
 * A counter above the cap is a poisoned one that the carry repairs: it is neither remembered nor allowed to pin the mark at the limit.
 */
export function followCounter(spaceId: string, counter: number): void {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > VERSION_FLOOR_CAP) return;
  if (counter > (seen.get(spaceId) ?? -1)) seen.set(spaceId, counter);
  const mark = marks.get(spaceId);
  if (mark !== undefined && counter < mark) return;
  if (raiseMark(spaceId, Math.min(counter + VERSION_MARK_STEP, MARK_LIMIT))) askForSave();
}

/** The highest counter this process has seen for the space since the database was last replaced; `-1` when none. Read BEFORE the update that asks for the next. */
export function counterSeenBefore(spaceId: string): number {
  return seen.get(spaceId) ?? -1;
}

/** Whether this is the first stamp of the space since the process started (or the database was replaced), so its counter must be raised first. */
export function isFirstStampOf(spaceId: string): boolean {
  return !started.has(spaceId);
}

/** The space's counter was raised (or needed no raise) before its first stamp: later stamps of it are not firsts. Called only after the raise succeeded. */
export function firstStampChecked(spaceId: string): void {
  started.add(spaceId);
}

/**
 * Say that a raise moved a counter, once, through the log and the metric. Information at a process start (every restart of an instance that has been
 * written to does it, by up to one step), a warning when the counter went back while the process ran (something replaced the database underneath it).
 */
export function reportCounterRaised(spaceId: string, from: number, to: number, reason: VersionRaiseReason): void {
  const line = `Space '${peerText(spaceId)}': the version counter (${from}) was below the mark kept in config.json; raised to ${to}.`;
  if (reason === 'went_back') log.warn(line); else log.info(line);
  countVersionCounterRaise(reason);
}

/** The database was replaced underneath the process (the end of a restore): every space's next stamp is a first one again. The marks stay. */
function forgetCounterState(): void {
  started.clear();
  seen.clear();
}
// A listener with no collections of its own: `reportDatabaseReplaced()` tells every listener whatever its predicate (`db/mongo.ts`).
onRecordCollectionWrite(() => false, (name, effect) => { if (name === EVERY_COLLECTION && effect.forget) forgetCounterState(); });

/**
 * Take what config.json holds into memory and write what memory holds into it, on a config object the loader is taking in or writing out.
 * Registered with the loader (`registerConfigOverlay`), which runs it on every load, reload and save: the object that ends up on disk carries
 * every mark this process knows (a higher one from the file included), and an entry that is not a valid mark is said once and left out.
 */
function overlayMarks(config: Config): void {
  const raw: unknown = config.versionMarks;
  if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of Object.keys(raw)) {
      const value = (raw as Record<string, unknown>)[key];
      if (isValidMark(value)) raiseMark(key, value);
      else invalidSaid(key, () => log.warn(`config.json holds versionMarks['${peerText(key)}'] = ${peerText(JSON.stringify(value))}, which is not a version mark (a whole number from 0 to ${MARK_LIMIT}); it is ignored and the next save rewrites it.`));
    }
  } else if (raw !== undefined) {
    invalidSaid('versionMarks', () => log.warn(`config.json holds versionMarks as ${peerText(JSON.stringify(raw))}, which is not an object of space ids and marks; it is ignored and the next save rewrites it.`));
  }
  if (marks.size === 0) {
    if (raw !== undefined) delete config.versionMarks;
    return;
  }
  // No prototype, so every key is a plain property here: `constructor` and `prototype` are valid space ids and get their marks like any other.
  const out = Object.create(null) as Record<string, number>;
  for (const [spaceId, mark] of marks) out[spaceId] = mark;
  config.versionMarks = out;
}
registerConfigOverlay(overlayMarks);

/**
 * At boot, after the database connects: every space whose counter is above its mark (no mark yet, as a space not written since the upgrade, or a
 * counter that outran it) gets one at `counter + STEP`, so a loss of the database before the space's next write still finds a mark. One read of
 * `ythril_counters`, one save asked for; local state only, nothing replicated.
 */
export async function seedVersionMarks(): Promise<void> {
  let raised = false;
  const docs = await col<SpaceCounterDoc>('ythril_counters').find({}, { projection: { seq: 1 } }).toArray();
  for (const doc of docs) {
    const counter = doc.seq;
    if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0 || counter > VERSION_FLOOR_CAP) continue;
    if (raiseMark(String(doc._id), Math.min(counter + VERSION_MARK_STEP, MARK_LIMIT))) raised = true;
  }
  if (raised) askForSave();
}

/**
 * A rename's counter moved to a new id: the mark moves with it (the greater of the two when the new id already has one), BEFORE the counter
 * moves, so a move that fails half way is covered by the raise before the next stamp. Saved at once: a rename is rare and not a write's hot path.
 */
export function moveVersionMark(oldId: string, newId: string): void {
  const moved = marks.get(oldId);
  if (moved === undefined) return;
  raiseMark(newId, moved);
  marks.delete(oldId);
  started.delete(oldId);
  seen.delete(oldId);
  started.delete(newId);
  seen.delete(newId);
  if (isConfigLoaded()) {
    const cfg = getConfig();
    if (cfg.versionMarks) delete cfg.versionMarks[oldId];
    saveConfig(cfg);
  }
}

/**
 * A space's mark is forgotten, inside the config write that removes the space and only after its collections are dropped: a space created later
 * under the same id starts without one. Takes the entry out of memory and out of `config`, the object being saved.
 */
export function forgetVersionMark(config: Config, spaceId: string): void {
  marks.delete(spaceId);
  started.delete(spaceId);
  seen.delete(spaceId);
  if (config.versionMarks) delete config.versionMarks[spaceId];
}
