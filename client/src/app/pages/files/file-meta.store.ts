import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { FilesApi } from '../../core/files-api.service';
import { httpErrorReason } from '../../core/http-error';
import type { FileMeta } from '../../core/api.types';
// The model type lives with the EDITOR that binds to it, not here: a second declaration of one shape is
// how the comma-joined `linkEntities` would end up an array on one side and a string on the other.
import type { FileMetaModel } from './file-meta-editor.component';

/** Which write failed, so the page can pick the wording. The MESSAGE is never this store's business. */
export type MetaFailure = 'save' | 'requeue';

/**
 * A file's metadata record: the three requests, the edit model, and the rules that connect them.
 *
 * `G-3`'s tenth cut, and the last of the four `filesApi` groups the page shell owned.
 *
 * ## The edit model stays a PLAIN OBJECT
 *
 * Everything else here is a signal. This is not, and it is the one piece of state on the page that a
 * signal-based rewrite would silently change the semantics of — which is why a characterization case has
 * stood over it since the fifth cut. It is re-seeded wholesale on open, on cancel and after a save, and the
 * form binds into its fields with `ngModel`; a signal would make each of those a set() and change when the
 * template sees a half-updated model.
 *
 * `tags`, `linkFacts` and `linkChronos` are arrays and `linkEntities` is a comma-joined STRING, because its
 * control is free text. A rewrite that made all four the same shape breaks the round trip in one direction
 * only, and only for entity references.
 *
 * ## What this store deliberately does NOT do
 *
 * **It does not prime the picker.** `seed()` publishes the model it built and the page primes the entity,
 * memory and chrono chip labels from it — the picker is a `ViewChild`, and a store reaching for one would
 * couple this file to the template's shape.
 *
 * **It does not toast, and it does not reload the directory.** Both are the page's: the wording is the
 * page's (this file holds no translations, same rule as the listing store) and the directory belongs to the
 * listing store. What this publishes is that a write SUCCEEDED, which is the fact both of those follow from.
 *
 * ## The rule that is easy to get almost right
 *
 * A successful save re-seeds from the RESPONSE, never from what was typed. The server normalises — it may
 * drop an id it cannot resolve, or return the description it actually stored — so re-seeding from the model
 * that was just sent shows the user what they asked for instead of what exists, and the difference only
 * surfaces on a later reload, by which time nobody connects the two.
 */
@Injectable()
export class FileMetaStore {
  private readonly filesApi = inject(FilesApi);

  /** The loaded record, or `null` when the file has none yet — which is not an error. */
  readonly selectedMeta = signal<FileMeta | null>(null);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  /** The path whose embedding is being re-queued, or `''`. One at a time, by path, so one row greys out. */
  readonly requeueingPath = signal('');

  /** The form model. Replaced wholesale rather than mutated — see the class note. */
  model: FileMetaModel = { description: '', tags: [], linkEntities: '', linkFacts: [], linkChronos: [] };

  /** A fresh model was seeded. The page primes the picker's chip labels from it. */
  readonly seeded = new Subject<FileMetaModel>();
  /** A write succeeded — the page toasts and reloads the listing, both of which are its business. */
  readonly saved = new Subject<void>();
  readonly requeued = new Subject<void>();
  /** A write failed. The page owns the wording; this says only which one. */
  readonly failed = new Subject<MetaFailure>();

  /** Copy a record into the form model, or clear it when there is none. */
  seed(fm: FileMeta | null): void {
    this.model = {
      description: fm?.description ?? '',
      tags: [...(fm?.tags ?? [])],
      linkEntities: (fm?.linkEntities ?? []).join(', '),
      linkFacts: [...(fm?.linkFacts ?? [])],
      linkChronos: [...(fm?.linkChronos ?? [])],
    };
    // Copied, not referenced: editing the form must not reach back into the loaded record, or cancelling
    // would restore the edits it is supposed to discard.
    this.seeded.next(this.model);
  }

  /** Re-seed from the record as loaded, discarding edits. Used by both cancel and opening the edit face. */
  reseed(): void {
    this.seed(this.selectedMeta());
    this.error.set(null);
  }

  /**
   * Load the record for one file.
   *
   * A missing record is NOT an error: it means no description or links yet, so the model is seeded empty and
   * the error stays clear. Reporting it would put a red message on every file nobody has annotated.
   */
  load(spaceId: string, path: string): void {
    this.selectedMeta.set(null);
    this.error.set(null);
    this.filesApi.getFileMeta(spaceId, path).subscribe({
      next: (fm) => { this.selectedMeta.set(fm); this.seed(fm); },
      error: () => { this.seed(null); },
    });
  }

  /** Persist the edited model. Re-seeds from the RESPONSE on success — see the class note. */
  save(spaceId: string, path: string): void {
    this.saving.set(true);
    this.error.set(null);
    this.filesApi.updateFileMeta(spaceId, path, {
      description: this.model.description.trim(),
      tags: this.model.tags,
      // Blanks dropped: a trailing comma would otherwise post an empty id.
      linkEntities: this.model.linkEntities.split(',').map(s => s.trim()).filter(Boolean),
      linkFacts: this.model.linkFacts,
      linkChronos: this.model.linkChronos,
    }).subscribe({
      next: (fm) => {
        this.selectedMeta.set(fm);
        this.seed(fm);
        this.saving.set(false);
        this.saved.next();
      },
      error: (e) => {
        // The model is left as typed. Losing an edit to a failed request is the one outcome that cannot be
        // undone by trying again.
        this.error.set(httpErrorReason(e));
        this.saving.set(false);
        this.failed.next('save');
      },
    });
  }

  /** Re-queue embedding for one file. Same request from the row and from the pane, so one method. */
  requeue(spaceId: string, path: string): void {
    this.requeueingPath.set(path);
    this.filesApi.retryEmbedding(spaceId, path).subscribe({
      next: () => { this.requeueingPath.set(''); this.requeued.next(); },
      error: (e) => {
        this.requeueingPath.set('');
        this.error.set(httpErrorReason(e));
        this.failed.next('requeue');
      },
    });
  }
}
