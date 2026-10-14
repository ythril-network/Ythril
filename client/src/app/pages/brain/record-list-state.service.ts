import { Injectable, signal } from '@angular/core';
import { httpErrorReason, type RefusalSource } from '../../core/refusal-text';

/**
 * Singleton interaction state shared by every record tab (memories/entities/edges/chrono/filemeta).
 *
 * Extracted from BrainComponent (A17.9b-6c) as the keystone before the tabs become their own
 * components. These signals are singleton by nature — only one record is being loaded, inline-edited,
 * or delete-confirmed at a time — so a single shared instance is faithful to today's behaviour and
 * lets the shell's unified loading overlay and each future tab component read the same state without
 * duplication. The per-tab FILTERS and pagination (`recordFilter`, `filterEntity`, `skip*`) are NOT
 * here — those are genuinely per-tab and move to each tab component as it is extracted.
 *
 * Provided by BrainComponent (not root): one instance per mounted page.
 */
@Injectable()
export class RecordListState {
  /** True while the active tab's list is loading (drives the shell's content overlay). */
  loading = signal(false);
  /** Failure reason for the active tab's last load; null when it succeeded (or hasn't run). */
  loadError = signal<string | null>(null);

  /** The `_id` of the row being inline-edited (empty = none). */
  editingId = signal('');
  editSaving = signal(false);
  /** The refused answer of the last inline-edit save, as the request gave it; the tab that shows it words it and marks the rows it names. */
  readonly editFailure = signal<RefusalSource | null>(null);
  /** The same failure as one plain, untranslated sentence ('' when none): for a host that wants a string and not rows. */
  editError = signal('');

  /** The `_id` of the row whose delete is awaiting confirmation (empty = none). */
  confirmDeleteId = signal('');

  /**
   * Why the last delete did not happen, empty when nothing is wrong.
   *
   * All four record tabs answered a failed delete with `error: () => {}`. The row stayed on screen
   * and nothing said anything, so the operator's own click looked like it had not registered —
   * reported by the owner against entities, where the server refuses a delete that would orphan an
   * edge and says so in detail.
   *
   * It lives HERE rather than in each tab because it was the same omission four times, and the four
   * already share this state. A fifth tab gets the surface by using the signal that is already
   * there.
   */
  deleteError = signal('');

  /** The inline edit's save was refused: hold the answer itself, and its sentence for whoever wants a string. */
  failEdit(failure: RefusalSource): void {
    this.editFailure.set(failure);
    this.editError.set(httpErrorReason(failure) || String(failure.status ?? '') || 'error');
  }

  clearEditFailure(): void {
    this.editFailure.set(null);
    this.editError.set('');
  }

  cancelEdit(): void {
    this.editingId.set('');
    this.clearEditFailure();
  }
}
