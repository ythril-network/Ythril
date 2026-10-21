import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { UPLOAD_QUEUE_STYLES } from './file-manager.styles';

/** Where one queued file is in its lifecycle. */
export type UploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

/**
 * One row in the upload panel — a single file's lifecycle (U12).
 *
 * Declared here and imported by the page, as `PreviewKind` is: the page owns the queue and this owns how a
 * row looks, so the vocabulary belongs with the renderer and there is exactly one of it.
 */
export interface UploadItem {
  id: number;
  file: File;
  name: string;
  status: UploadStatus;
  percent: number;
  error?: string;
}

/**
 * The upload panel: one row per file, with its progress and the actions its state allows.
 *
 * ## What stays behind, and why
 *
 * **The queue itself.** Ordering, the one-at-a-time rule, the HTTP subscriptions, retry and cancel semantics
 * — all of that is `file-upload.store.ts`'s, and it is what `file-manager.component.spec.ts`'s upload cases
 * exercise. This component reports which button was pressed and renders what it is given; it holds no state
 * at all.
 *
 * That division is deliberate rather than minimal. An upload in flight owns a subscription, and a component
 * that owned it would abort on destroy — so navigating away from the tab, or any structural change that
 * remounted this panel, would silently cancel a running upload. The store is provided by the PAGE, which
 * outlives both.
 *
 * The row's shape is declared here rather than there for the same reason `FileMetaModel` lives with the
 * editor that binds to it: the vocabulary belongs with the renderer, and there is exactly one of it. The
 * queue adds the space and path each file was dropped on, which are its bookkeeping and not a row's.
 *
 * ## The actions are per-state, and that is the behaviour worth keeping in one place
 *
 * Retry belongs to a failed row, cancel to one that is queued or uploading, dismiss to one that is finished
 * either way. Written out three times in the old markup, and each `@if` was the only thing standing between a
 * user and a cancel button on a completed upload.
 */
@Component({
  selector: 'app-upload-queue',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent],
  styles: [UPLOAD_QUEUE_STYLES],
  host: { class: 'upload-panel' },
  template: `
    <div class="upload-panel-head">
      <span>{{ 'files.upload.queueTitle' | transloco }}</span>
      @if (hasFinished()) {
        <button class="btn-ghost btn btn-sm" type="button" (click)="clearFinished.emit()">
          {{ 'files.upload.clearFinished' | transloco }}
        </button>
      }
    </div>
    @for (u of uploads(); track u.id) {
      <div class="upload-row" [class.failed]="u.status === 'failed'" [class.done]="u.status === 'done'">
        <ph-icon class="upload-row-icon" [name]="iconFor(u.status)" [size]="14"/>
        <div class="upload-row-body">
          <div class="upload-row-top">
            <span class="upload-name" [title]="u.name">{{ u.name }}</span>
            <span class="upload-state">
              @switch (u.status) {
                @case ('queued') { {{ 'files.upload.status.queued' | transloco }} }
                @case ('uploading') { {{ u.percent }}% }
                @case ('done') { {{ 'files.upload.status.done' | transloco }} }
                @case ('failed') { {{ u.error || ('files.upload.status.failed' | transloco) }} }
              }
            </span>
          </div>
          @if (u.status === 'uploading' || u.status === 'queued') {
            <div class="upload-bar">
              <div class="upload-bar-fill" [style.width.%]="u.percent"></div>
            </div>
          }
        </div>
        <!-- a personal view never uploads: nothing here can be retried, cancelled or dismissed -->
        @if (!isView()) {
        <div class="upload-row-actions">
          @if (u.status === 'failed') {
            <button class="btn-ghost btn btn-sm" type="button" (click)="retry.emit(u)">{{ 'common.retry' | transloco }}</button>
          }
          @if (u.status === 'queued' || u.status === 'uploading') {
            <button class="btn-ghost btn btn-sm" type="button" (click)="cancel.emit(u)">{{ 'common.cancel' | transloco }}</button>
          }
          @if (u.status === 'done' || u.status === 'failed') {
            <button class="icon-btn" type="button" [attr.aria-label]="'files.upload.dismiss' | transloco" (click)="dismiss.emit(u)">
              <ph-icon name="x" [size]="12"/>
            </button>
          }
        </div>
        }
      </div>
    }
  `,
})
export class UploadQueueComponent {
  readonly uploads = input<readonly UploadItem[]>([]);
  /** Whether any row is finished — the page decides, because it is the page that knows the whole queue. */
  readonly hasFinished = input<boolean>(false);
  /** THE flag, from the page: the open id is a personal view, which never uploads (and so has no queue to act on). */
  readonly isView = input(false);

  readonly retry = output<UploadItem>();
  readonly cancel = output<UploadItem>();
  readonly dismiss = output<UploadItem>();
  readonly clearFinished = output<void>();

  /**
   * The icon for a status — a pure mapping, and it belongs here rather than on the page.
   *
   * It was `uploadIcon` on a 1 618-line component that also uploads files. Which glyph means "queued" is a
   * question about how a row LOOKS, and nothing else on that page needed the answer.
   */
  iconFor(status: UploadStatus): string {
    switch (status) {
      case 'done': return 'check-circle';
      case 'failed': return 'warning';
      case 'uploading': return 'arrow-up';
      default: return 'timer';
    }
  }
}
