import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { FilesApi } from '../../core/files-api.service';
import { httpErrorReason } from '../../core/http-error';
import type { FileEntry } from '../../core/api.types';
import type { refusalText } from '../../core/refusal-text';

/** A failed request as the client receives it: the answer's body under `error`. The shape `refusalText` words. */
type RefusedAnswer = Parameters<typeof refusalText>[1];

/**
 * The family of translation keys a file act's answer code names: `files.refusal.<code>`. A prefix, not a key — the
 * code arrives with the answer, so the key cannot be written out here.
 */
export const FILE_REFUSAL_PREFIX = 'files.refusal';

/** The code of a move whose bytes moved and whose records the server is still finishing — not a failure. */
const MOVE_STILL_OWED = 'move_still_owed';

/** The code of a move whose bytes moved and whose records are held back by another file's — refused, but the file did move. */
const DESTINATION_HELD = 'destination_held_after_move';

/**
 * The answers that tell the operator what to do about them. Their toast stays until it is dismissed: one that times out
 * takes the instruction with it, and a screen reader's user may not have reached it yet. The others state a fact and expire.
 */
export const FILE_REFUSALS_WITH_REMEDY: ReadonlySet<string> = new Set([
  'path_blocked', 'destination_exists', DESTINATION_HELD, 'act_not_recorded', 'file_system_fault',
]);

/** How long to wait before looking again when the answer names no `Retry-After`, and the bounds on one that does. */
const OWED_DEFAULT_SECONDS = 5;
const OWED_MAX_SECONDS = 60;

/** The seconds an answer asks the caller to wait: its `Retry-After`, bounded, or the default when it names none. */
function retryAfterSeconds(err: unknown): number {
  const raw = (err as { headers?: { get(name: string): string | null } } | null)?.headers?.get('Retry-After');
  const seconds = raw === null || raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return OWED_DEFAULT_SECONDS;
  return Math.min(seconds, OWED_MAX_SECONDS);
}

/**
 * A write that failed: which one, and the answer exactly as the client received it (the page words it).
 * `bytesMoved` is true for a refused move whose file did move, so the row is no longer the one being edited.
 */
export interface ListingMutationFailure {
  kind: ListingMutationKind;
  error: RefusedAnswer;
  bytesMoved: boolean;
}

/** What a mutation did, for whoever cares beyond the reload this store already performs. */
export type ListingMutation = 'created' | 'moved' | 'removed';

/** Which mutation failed. The MESSAGE is the page's business — this class holds no translations. */
export type ListingMutationKind = 'create' | 'move' | 'remove';

/**
 * The translation KEY for each write's failure — a lookup, not a translation.
 *
 * It lives beside the writes because this is the file that knows which of them is which, and it stays a key
 * rather than a message because nothing here should be able to render text. Whoever shows it owns the
 * wording, the locale and the channel.
 */
export const LISTING_FAILURE_KEYS: Record<ListingMutationKind, string> = {
  create: 'files.error.createFolderFailed',
  move: 'files.error.renameFailed',
  remove: 'files.error.deleteFailed',
};

/**
 * The directory listing: its state, its five requests, and the one rule that decides how it loads.
 *
 * G-3's eighth cut, and the largest of the four `filesApi` groups the page shell still owned.
 *
 * ## The rule that had to move as ONE thing
 *
 * `load` decides **load-versus-refresh** from three facts at once — is this the path we are already showing,
 * are there rows on screen, and did the last attempt fail — and drives four flags from the answer. It has six
 * callers: the navigation, the progress poll, the retry button and three post-mutation reloads.
 *
 * It is one function on purpose. Asking each caller to classify itself is how five get it right and one does
 * not, which is the exact shape of the retention bug fixed in #632. **So the callers say what they did, never
 * what it counts as** — there is no `isRefresh` parameter here, and adding one would undo the fix.
 *
 * **Two facts, not three.** The rule tested `loadError` as well until `G-14`; see `load` for why that
 * clause is now a comment. It is the second line in two commits that turned out to be unable to decide
 * anything, and both were found the same way — by mutating them and watching the suite stay green.
 *
 * The two halves of that rule are opposite by design and both have a bug behind them:
 *
 * - **A failed NAVIGATION clears the rows.** The failure message renders in place of the "empty folder"
 *   state, so rows left on screen hide it completely — the breadcrumb said one folder and the table listed
 *   another, with nothing to say the listing had failed.
 * - **A failed REFRESH keeps them** and marks them not-current. A poll that loses a request during an ingest
 *   must not blank a table that is perfectly good.
 *
 * A refactor flattening those two into one branch is the most likely way to break this file, which is why
 * both are pinned by characterization cases and by mutants.
 *
 * ## Why a store and not a component, and why page-provided
 *
 * The same reason the tree's store gives, and it applies harder here: the listing renders inside the Brain's
 * tab strip, so a component owning `listFiles` would cancel the request whenever the operator looked at
 * another tab. `providers: [FileListingStore]` on the page — one instance per page, because a listing belongs
 * to the space and folder that page is showing.
 *
 * ## What it publishes rather than does
 *
 * `listed` and `listingFailed` carry the outcome of a listing; the page connects them to the tree sidebar and
 * to the progress poll. That indirection is deliberate: **this store does not know the tree exists.** The
 * page owns both and is the only place that knows they are related, which is also what the tree store's own
 * docblock asks for. `mutated` and `mutationFailed` are the same idea for the writes — this class reloads the
 * directory, and everything else a mutation means is the page's decision.
 */
@Injectable()
export class FileListingStore {
  private readonly filesApi = inject(FilesApi);

  /** The rows for the directory `loadedPath` describes. Empty after a failed navigation, never stale. */
  readonly entries = signal<FileEntry[]>([]);

  /**
   * True only while a load that has **nothing to show** is in flight — the state that replaces the view.
   *
   * A REFRESH must never enter it. It used to: every call set this, including the 4-second progress poll, so
   * watching an ingest meant the whole table was unmounted and replaced by a spinner every four seconds. A
   * reporting operator, verbatim: *"i only want to see progress bars move while waiting and not a
   * screenflickering."* They were right about the mechanism too — the view treated "a refetch is in flight"
   * as "we have no data yet".
   *
   * The rule, worth stating as a rule: **a refresh must never re-enter the empty state a first load uses.**
   */
  readonly loading = signal(false);

  /** True while a reload of the SAME directory is in flight over rows already on screen. Never unmounts them. */
  readonly refreshing = signal(false);

  /** Set when a background refresh failed, so stale rows are not passed off as current. Cleared on success. */
  readonly refreshFailed = signal(false);

  /** Failure reason for the directory listing; null when it loaded (U3). */
  readonly loadError = signal<string | null>(null);

  /** A listing landed: the path it was for, and the entries it returned. */
  readonly listed = new Subject<{ path: string; entries: FileEntry[] }>();

  /** A listing failed: the path it was for, and why. */
  readonly listingFailed = new Subject<{ path: string; reason: string }>();

  /** A write succeeded and the directory has been reloaded. */
  readonly mutated = new Subject<ListingMutation>();

  /** A write failed. The answer travels with it; the page owns the wording. */
  readonly mutationFailed = new Subject<ListingMutationFailure>();

  /**
   * A write was ACCEPTED and is being finished by the server (`move_still_owed`). Not a failure: the bytes moved.
   * The listing is reloaded once, after the seconds the server asked for, so no stale row outlives the move.
   */
  readonly moveOwed = new Subject<void>();

  /** The listing the page last asked for, so a delayed reload never drags the operator back to a folder they left. */
  private requested: { spaceId: string; path: string } | null = null;
  private owedReload: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.owedReload));
  }

  /**
   * The path `entries()` currently describes, or null before the first successful listing.
   *
   * This is what decides load-vs-refresh, rather than a flag at each call site. Comparing the PATH is the
   * only correct rule: rows from the directory you are leaving must not be shown under the name of the one
   * you are entering, so a navigation is always a foreground load.
   */
  private loadedPath: string | null = null;

  load(spaceId: string, path: string): void {
    /*
     * A refresh only when there is something on screen that this listing will replace in place.
     *
     * There used to be a third clause — `&& this.loadError() === null` — and a surviving mutant is what
     * retired it. It was load-bearing until this week: retrying a path whose listing had FAILED had to be a
     * foreground load, and back then a failed listing left its rows on screen, so the rows test alone would
     * have called that retry a refresh. `G-14` cleared those rows, and the state the clause guarded against
     * stopped existing in the same commit. Kept as a note rather than as code, because a condition that
     * cannot change an outcome is a condition no test can protect.
     */
    this.requested = { spaceId, path };
    const isRefresh = this.loadedPath === path && this.entries().length > 0;
    if (isRefresh) this.refreshing.set(true);
    else { this.loading.set(true); this.loadError.set(null); }
    this.filesApi.listFiles(spaceId, path).subscribe({
      next: ({ entries }) => {
        this.entries.set(entries);
        this.loadedPath = path;
        this.loadError.set(null);
        this.refreshFailed.set(false);
        this.loading.set(false);
        this.refreshing.set(false);
        this.listed.next({ path, entries });
      },
      error: (e) => {
        const reason = httpErrorReason(e);
        this.listingFailed.next({ path, reason });
        if (isRefresh) {
          // A failed POLL must not throw away good rows — that is the same defect in another dress, and a
          // transient failure during an ingest is exactly when it would happen. Keep the rows, mark them as
          // not-current, and let the next tick clear it.
          this.refreshFailed.set(true);
          this.refreshing.set(false);
          return;
        }
        /*
         * A failed first listing must not fall through to the "empty folder" state (U3) — and a failed
         * NAVIGATION must not leave the rows of the folder you came FROM under the name of the one you tried
         * to enter (`G-14`).
         *
         * The error is rendered inside the table's empty state, which is right for a first load and useless
         * here: rows on screen hide it completely, so the breadcrumb said `root / docs` while the table
         * listed `root` and nothing anywhere said the listing had failed.
         *
         * Clearing the rows rather than moving the message is the fix, because the rows are the lie. A banner
         * above a table of the wrong directory's contents is the same claim with a caption.
         *
         * `loadedPath` is deliberately NOT reset, and a surviving mutant is what settled that. It looked
         * like the honest thing to do — the field means "the path `entries()` describes" and `entries()` now
         * describes nothing — but `isRefresh` needs the path, some rows AND no error all at once, and the
         * rows have just gone. No behaviour can reach the stale value, so resetting it was a line no test
         * could pin.
         */
        this.entries.set([]);
        this.loadError.set(reason);
        this.loading.set(false);
      },
    });
  }

  /**
   * The three writes, each followed by a reload of `reloadPath`.
   *
   * The reload is HERE rather than at the three call sites for the same reason `load` classifies itself: it
   * was the same statement written three times, and the fourth copy is how one of them ends up missing. What
   * a caller does BEYOND the reload — refresh the tree's root, tell the host the file set changed — is its
   * own decision and arrives on `mutated`.
   */
  createDir(spaceId: string, path: string, reloadPath: string): void {
    this.filesApi.createDir(spaceId, path).subscribe({
      next: () => { this.load(spaceId, reloadPath); this.mutated.next('created'); },
      error: (err) => this.settleUnsuccessfulWrite('create', err, spaceId, reloadPath),
    });
  }

  move(spaceId: string, from: string, to: string, reloadPath: string): void {
    this.filesApi.moveFile(spaceId, from, to).subscribe({
      next: () => { this.load(spaceId, reloadPath); this.mutated.next('moved'); },
      error: (err) => this.settleUnsuccessfulWrite('move', err, spaceId, reloadPath),
    });
  }

  remove(spaceId: string, path: string, reloadPath: string): void {
    this.filesApi.deleteFile(spaceId, path).subscribe({
      next: () => { this.load(spaceId, reloadPath); this.mutated.next('removed'); },
      error: (err) => this.settleUnsuccessfulWrite('remove', err, spaceId, reloadPath),
    });
  }

  /**
   * What an answer to a write that did not succeed means — decided in ONE place for the three writes.
   *
   * `move_still_owed` is the one answer that is not a failure: the server has moved the bytes and finishes the
   * records itself, so saying the write failed would be false. It is published as `moveOwed`. `destination_held_after_move`
   * IS a refusal, and travels as one, but the bytes moved there too. For both, the listing is reloaded ONCE after the
   * `Retry-After` the server named (a default when it named none) rather than polled, so no row outlives the move under its
   * old name. Every other answer is a failure, and travels with its body.
   */
  private settleUnsuccessfulWrite(kind: ListingMutationKind, err: unknown, spaceId: string, reloadPath: string): void {
    const code = (err as { error?: { code?: string } | null } | null)?.error?.code;
    if (code === MOVE_STILL_OWED) this.moveOwed.next();
    else this.mutationFailed.next({ kind, error: err as RefusedAnswer, bytesMoved: code === DESTINATION_HELD });
    if (code !== MOVE_STILL_OWED && code !== DESTINATION_HELD) return;
    clearTimeout(this.owedReload);
    this.owedReload = setTimeout(() => {
      // Only if that folder is still the one being shown: an operator who moved on is not pulled back.
      if (this.requested?.spaceId === spaceId && this.requested.path === reloadPath) this.load(spaceId, reloadPath);
    }, retryAfterSeconds(err) * 1000);
  }

  /** The file GET URL. No token in it — auth goes in the fetch header, never the URL (#134). */
  downloadUrl(spaceId: string, path: string): string {
    return this.filesApi.getFileDownloadUrl(spaceId, path);
  }
}
