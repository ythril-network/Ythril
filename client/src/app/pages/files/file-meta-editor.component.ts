import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { TagInputComponent } from '../../shared/tag-input.component';
import { EntityRefFieldComponent } from '../brain/entity-ref-field.component';
import { FactRefFieldComponent } from '../brain/fact-ref-field.component';
import { ChronoRefFieldComponent } from '../brain/chrono-ref-field.component';
import { FILE_META_EDITOR_STYLES } from './file-manager.styles';

/**
 * The edit model for a file's metadata record.
 *
 * **`entityIds` is a STRING while the other two reference fields are arrays**, and that asymmetry is not an
 * oversight: its control is free text, so the page joins on the way in and splits on the way out. A rewrite
 * that made all three the same shape would break the round-trip in one direction, for one field, which is
 * exactly the sort of thing the characterization suite was written to catch.
 */
export interface FileMetaModel {
  description: string;
  tags: string[];
  entityIds: string;
  memoryIds: string[];
  chronoIds: string[];
}

/**
 * The file-meta edit face of the docked detail pane — description, tags, and the three reference fields.
 *
 * ## The model is MUTATED IN PLACE, and that is the existing contract
 *
 * `app-entity-ref-field` and its two siblings take a `[target]` object and write their results straight into
 * it. So this component passes the object it was given, unchanged and unwrapped: copying it defensively — the
 * instinct an extraction usually rewards — would make every reference edit vanish on save, because the page
 * would still be holding the original.
 *
 * The page replaces the whole object when it re-seeds (opening the face, or cancelling), which is a new input
 * value and re-renders this component. Mutation for the fields, replacement for the reset: both already true
 * before the split, and both easy to get wrong while moving them.
 *
 * ## Saving stays on the page
 *
 * Same reasoning as the upload queue's. The request is the page's — it knows the space, the path, and what to
 * reload afterwards — and a component that owned it would cancel a save in flight if the pane closed. This
 * one reports that Save was pressed.
 */
@Component({
  selector: 'app-file-meta-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, TagInputComponent, EntityRefFieldComponent,
    FactRefFieldComponent, ChronoRefFieldComponent],
  styles: [FILE_META_EDITOR_STYLES],
  template: `
    @if (model(); as m) {
      <form class="detail-meta-form" (ngSubmit)="save.emit()">
        <div class="field">
          <label>{{ 'brain.fileMeta.table.description' | transloco }}</label>
          <textarea [(ngModel)]="m.description" name="detailDesc" rows="3"></textarea>
        </div>
        <div class="field">
          <label>{{ 'brain.fileMeta.table.tags' | transloco }}</label>
          <app-tag-input [(value)]="m.tags" inputName="detailTags" />
        </div>
        <div class="field">
          <label>{{ 'brain.fileMeta.table.entities' | transloco }}</label>
          <app-entity-ref-field [target]="m" [spaceId]="spaceId()" />
        </div>
        <div class="field">
          <label>{{ 'brain.fileMeta.table.facts' | transloco }}</label>
          <app-fact-ref-field [target]="m" />
        </div>
        <div class="field">
          <label>{{ 'brain.fileMeta.table.chrono' | transloco }}</label>
          <app-chrono-ref-field [target]="m" />
        </div>
        @if (error()) { <div class="alert alert-error" role="alert">{{ error() }}</div> }
        <div class="detail-meta-actions">
          <button class="btn btn-sm btn-primary" type="submit" [disabled]="saving()">{{ 'common.save' | transloco }}</button>
          <button class="btn btn-sm btn-secondary" type="button" (click)="cancel.emit()">{{ 'common.cancel' | transloco }}</button>
          @if (canRetryEmbedding()) {
            <button class="btn btn-sm btn-ghost" type="button" [disabled]="retryPending()"
              (click)="retryEmbedding.emit()">{{ 'brain.fileMeta.retryEmbedding' | transloco }}</button>
          }
        </div>
      </form>
    }
  `,
})
export class FileMetaEditorComponent {
  /** Passed through unwrapped — the reference widgets write into this object. See the class docblock. */
  readonly model = input<FileMetaModel | null>(null);
  readonly spaceId = input<string>('');
  readonly error = input<string | null>(null);
  readonly saving = input<boolean>(false);

  /**
   * Whether a re-embed is worth offering, decided by the page.
   *
   * It is a question about the FILE's embedding status, not about this form, and answering it here would mean
   * teaching the editor what a partial embedding is.
   */
  readonly canRetryEmbedding = input<boolean>(false);
  readonly retryPending = input<boolean>(false);

  readonly save = output<void>();
  readonly cancel = output<void>();
  readonly retryEmbedding = output<void>();
}
