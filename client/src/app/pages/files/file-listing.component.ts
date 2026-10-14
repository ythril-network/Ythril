import { ChangeDetectionStrategy, Component, ElementRef, inject, input, model, output, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ErrorStateComponent } from '../../shared/error-state.component';
import { TimestampComponent } from '../../shared/timestamp.component';
import { StepProgressBarComponent } from '../../shared/step-progress-bar.component';
import { SortableHeaderComponent } from '../brain/sortable-header.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import { FileEntry } from '../../core/api.types';
import { formatSize } from './file-format';
import { FILE_LISTING_STYLES } from './file-manager.styles';

/**
 * One row, with the three per-row questions already answered.
 *
 * They were `canRequeue(entry)`, `requeueingPath() === relPath(entry)` and `renamingEntry() === entry.name`,
 * evaluated inside the loop — so the table needed the page's requeue policy, its path helper and its rename
 * state just to decide which buttons to draw. Answering them once, where the answers come from, is what took
 * this component's interface from sixteen bindings to nine.
 */
export interface FileRow {
  entry: FileEntry;
  /** This row's name field is an open rename form rather than a link. */
  renaming: boolean;
  /** A re-embed for this row is already in flight, so its button is disabled rather than absent. */
  requeueing: boolean;
  /** Whether re-embedding is offered at all — a policy question, and the page owns the policy. */
  canRequeue: boolean;
  /** A delete for this row is in flight: its delete button is disabled and the row says it is busy. */
  deleting: boolean;
}

/**
 * The directory listing: one row per entry, with its status, tags, size, modified time and actions.
 *
 * ## The last cut of G-3, and the widest
 *
 * The other four pieces of the detail pane render one thing each. This is the page's core — the reason
 * somebody opens the Files tab — so its interface is inherently wider, and the honest way to keep it
 * legible was to answer the per-row questions before they arrive rather than to pass the machinery that
 * answers them.
 *
 * ## Actions are separate outputs, deliberately
 *
 * A single `action` output carrying a discriminated union would have been fewer bindings and worse to read:
 * the parent would gain a `switch` where it currently has seven one-line handlers, and a template is the one
 * place where naming each event is clearer than dispatching on a tag.
 *
 * ## Rename is two-way because the input lives here
 *
 * `renameValue` is a `model()`: the text box is in this component, and the page needs the value when the form
 * is submitted. Everything else is one-directional.
 */
@Component({
  selector: 'app-file-listing',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, ErrorStateComponent, TimestampComponent,
    StepProgressBarComponent, SortableHeaderComponent, HscrollTopDirective],
  styles: [FILE_LISTING_STYLES],
  template: `
    <div class="table-wrapper" hscrollTop>
      <table>
        <!-- The caption names the table for a screen reader, and is where the focus lands after the last row is deleted:
             there is no next row to give it to, and the page would otherwise leave it on a button that no longer exists. -->
        <caption #caption tabindex="-1" class="sr-only">{{ 'files.table.caption' | transloco }}</caption>
        <thead>
          <tr>
            <th style="width:24px"><span class="sr-only">{{ 'files.table.icon' | transloco }}</span></th>
            <th app-sort-th field="name" label="files.table.name" [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="status" label="files.table.status" [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th>{{ 'files.table.tags' | transloco }}</th>
            <th app-sort-th field="size" label="files.table.size" [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th app-sort-th field="modified" label="files.table.modified" [activeField]="sortField()" [dir]="sortDir()" (sort)="sort.emit($event)"></th>
            <th class="actions-cell">{{ 'files.table.actions' | transloco }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.entry.name) {
            <tr [attr.aria-busy]="row.deleting ? 'true' : null">
              <td><span class="file-icon">@if (row.entry.isDirectory) { <ph-icon name="folder" [size]="16"/> } @else { <ph-icon name="file" [size]="16"/> }</span></td>
              <td class="name-cell">
                @if (row.renaming) {
                  <form class="rename-form" (ngSubmit)="renameConfirm.emit(row.entry)">
                    <input type="text" [(ngModel)]="renameValue" name="rn" [attr.aria-label]="'files.renameEntryAriaLabel' | transloco" style="width:200px" />
                    <button class="btn-primary btn btn-sm" type="submit">{{ 'common.save' | transloco }}</button>
                    <button class="btn-ghost btn btn-sm" type="button" (click)="renameCancel.emit()">{{ 'common.cancel' | transloco }}</button>
                  </form>
                } @else {
                  <button
                    class="file-name-btn"
                    [class.dir]="row.entry.isDirectory"
                    [attr.title]="row.entry.name"
                    (click)="open.emit(row.entry)"
                  >{{ row.entry.name }}</button>
                }
              </td>
              <td>
                @if (row.entry.isFile && row.entry.progress) {
                  <!-- In flight AND the worker has reported a stage: show WHICH stage of this
                       file's own route is running, rather than a generic "embedding" + spinner
                       that looks identical whether the job is working or wedged. Falls back to
                       the pill below the moment the job finishes or before it reports. -->
                  <app-step-progress-bar
                    [progress]="row.entry.progress"
                    [progressAt]="row.entry.progressAt" />
                } @else if (row.entry.isFile && row.entry.embeddingStatus) {
                  <span class="emb-pill" [class]="'emb-' + row.entry.embeddingStatus">
                    <span class="emb-dot"></span>{{ 'files.embStatus.' + row.entry.embeddingStatus | transloco }}
                  </span>
                }
              </td>
              <td>
                @if (row.entry.tags?.length) {
                  <span class="tag-list">@for (t of row.entry.tags; track t) { <span class="tag-chip">{{ t }}</span> }</span>
                }
              </td>
              <td style="color:var(--text-muted)">
                {{ formatSize(row.entry.size) }}
              </td>
              <td><app-timestamp [value]="row.entry.modified"/></td>
              <!-- The flex is on an inner wrapper, not on the cell: a table cell that is display:flex stops being a table cell,
                   so it left the row's baseline and borders, and its width was nobody's to share. -->
              <td class="actions-cell">
                <div class="row-actions">
                  @if (row.entry.isFile) {
                    <button
                      type="button"
                      class="btn-ghost btn btn-sm"
                      (click)="download.emit(row.entry)"
                      [attr.aria-label]="'files.downloadAriaLabel' | transloco"
                    ><ph-icon name="download-simple" [size]="16"/></button>
                  }
                  @if (row.canRequeue) {
                    <!-- Re-embedding was reachable only from the detail pane, so fixing a file whose
                         embedding failed meant OPENING it first — and the row already tells you it
                         failed. The action belongs where the diagnosis is. Hidden while a job is
                         pending or processing: the server refuses that with a 409, and an action that
                         exists only to be refused is worse than one that is absent. -->
                    <button
                      type="button"
                      class="btn-ghost btn btn-sm"
                      [disabled]="row.requeueing"
                      (click)="requeue.emit(row.entry)"
                      [attr.title]="'brain.fileMeta.retryEmbedding' | transloco"
                      [attr.aria-label]="'files.reembedAriaLabel' | transloco"
                    ><ph-icon name="arrows-clockwise" [size]="16"/></button>
                  }
                  <!-- Rename is a pencil, not the word: it sat as the one text button among icons, so it
                       set the width of the actions column on every row and pushed delete off the edge on
                       a narrow window. Same label, on hover and for assistive tech. -->
                  <button class="btn-ghost btn btn-sm" (click)="renameStart.emit(row.entry)"
                    [attr.title]="'files.rename' | transloco"
                    [attr.aria-label]="'files.renameEntryAriaLabel' | transloco"
                  ><ph-icon name="pencil-simple" [size]="16"/></button>
                  <button class="icon-btn danger" type="button" [disabled]="row.deleting" (click)="remove.emit(row.entry)"
                    [attr.title]="'files.deleteEntryAriaLabel' | transloco: { name: row.entry.name }"
                    [attr.aria-label]="'files.deleteEntryAriaLabel' | transloco: { name: row.entry.name }"><ph-icon name="x" [size]="16"/></button>
                </div>
              </td>
            </tr>
          } @empty {
            <tr><td colspan="7">
              @if (error() !== null) {
                <app-error-state [message]="'files.error.loadFiles' | transloco" [reason]="error() ?? ''" (retry)="retryLoad.emit()" />
              } @else {
              <div class="empty-state" style="padding:32px">
                <div class="empty-state-icon"><ph-icon name="folder-open" [size]="48"/></div>
                <h3>{{ 'files.emptyFolder.title' | transloco }}</h3>
                <p>{{ 'files.emptyFolder.body' | transloco }}</p>
              </div>
              }
            </td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class FileListingComponent {
  readonly rows = input<readonly FileRow[]>([]);
  readonly sortField = input<string>('');
  readonly sortDir = input<'asc' | 'desc'>('asc');
  /** The directory load's failure, shown in place of the empty state — an empty folder is not an error. */
  readonly error = input<string | null>(null);

  /** Two-way: the text box is here, and the page reads the value when the form is submitted. */
  readonly renameValue = model<string>('');

  readonly sort = output<string>();
  readonly open = output<FileEntry>();
  readonly download = output<FileEntry>();
  readonly requeue = output<FileEntry>();
  readonly renameStart = output<FileEntry>();
  readonly renameConfirm = output<FileEntry>();
  readonly renameCancel = output<void>();
  /** `remove`, not `delete` — the latter is a reserved word and cannot be a member name. */
  readonly remove = output<FileEntry>();
  readonly retryLoad = output<void>();

  protected readonly formatSize = formatSize;

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly caption = viewChild<ElementRef<HTMLElement>>('caption');

  /**
   * Put the focus on the name of the row called `name`, or on the table's caption when there is no such row (`null`, or a row that
   * is not drawn: the last one was just deleted).
   *
   * It is here and not on the page because only this component knows what a row IS in the DOM: the page hands over a name and
   * never reaches into the table's markup. The caption is always there to land on, so the focus is never left on the body.
   */
  focusRow(name: string | null): void {
    const names = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('tbody .file-name-btn'));
    (names.find(button => (button.textContent ?? '').trim() === name) ?? this.caption()?.nativeElement)?.focus();
  }
}
