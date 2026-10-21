import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { FILE_TOOLBAR_STYLES } from './file-manager.styles';
import type { Space } from '../../core/api.types';
import { injectIsView } from '../../core/views.store';

/**
 * One step of the breadcrumb: a label and the path clicking it navigates to.
 *
 * Declared here rather than on the page, as `FileRow`, `TreeNode` and `UploadItem` are: the vocabulary
 * belongs with the renderer, and there is exactly one of it. The page still BUILDS the trail — the
 * accumulator is one of only two places that construct a path, and `join` is the other.
 */
export interface BreadcrumbSegment { label: string; path: string; }

/**
 * The toolbar above the listing: where you are, and the four things you can do from here.
 *
 * `G-3.3`. The space selector, the breadcrumb trail, the new-folder form, the upload picker and the sidebar
 * toggle — one strip of controls that share a row and nothing else.
 *
 * ## Dumb, like every other child on this page
 *
 * `input()` for what to draw, `model()` for the form state the page needs to see, `output()` for a gesture.
 * The page decides what a click MEANS: `navigate` also refills the tree, `createFolder` goes through the
 * listing store and may be refused, and `toggleSidebar` belongs to the tree store.
 *
 * **The new-folder form is `model()` and not local state, and that is load-bearing.** A refused create has
 * to keep what was typed — losing an edit to a failed request is the one outcome trying again cannot undo —
 * so the page closes the form on the ANSWER, not on the attempt. If this component owned `open` outright it
 * would have to be told the outcome, which is a second channel for a decision the page already makes. A
 * characterization case has stood over that rule since the eighth cut.
 *
 * ## The file input clears itself
 *
 * A file input fires `change` only when its value CHANGES, so leaving it set makes picking the same file
 * twice silent — no row, no upload, and nothing on screen to explain it. The clearing happens here because
 * the element is here; what the files MEAN is the page's, which is why the output carries them on.
 */
@Component({
  selector: 'app-file-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent],
  styles: [FILE_TOOLBAR_STYLES],
  template: `
    <!-- Space selector, hidden when embedded in the Brain — there the host chose the space. -->
    @if (!embedded()) {
      <div class="space-selector">
        @for (s of spaces(); track s.id) {
          <button
            class="btn"
            [class.btn-primary]="activeSpaceId() === s.id"
            [class.btn-secondary]="activeSpaceId() !== s.id"
            (click)="selectSpace.emit(s.id)"
          >{{ s.label }}</button>
        }
      </div>
    }

    <div class="toolbar">
      <div class="breadcrumb">
        @for (seg of breadcrumbs(); track seg.path; let last = $last) {
          <button
            class="breadcrumb-item"
            [class.current]="last"
            (click)="navigate.emit(seg.path)"
          >{{ seg.label }}</button>
          @if (!last) { <span class="breadcrumb-sep">/</span> }
        }
      </div>

      <!-- New folder, and Upload below it: neither is offered on a personal view, which never writes. -->
      @if (isView()) {
        <!-- read-only -->
      } @else if (!folderFormOpen()) {
        <button class="btn-secondary btn btn-sm" (click)="folderFormOpen.set(true)">{{ 'files.newFolder' | transloco }}</button>
      } @else {
        <form class="rename-form" (ngSubmit)="createFolder.emit()">
          <input type="text" [(ngModel)]="newFolderName" name="fn" [placeholder]="'files.newFolderPlaceholder' | transloco" [attr.aria-label]="'files.newFolderAriaLabel' | transloco" style="width:160px" />
          <button class="btn-primary btn btn-sm" type="submit">{{ 'files.createFolder' | transloco }}</button>
          <button class="btn-ghost btn btn-sm" type="button" (click)="folderFormOpen.set(false)">{{ 'common.cancel' | transloco }}</button>
        </form>
      }

      @if (!isView()) {
        <label class="btn-secondary btn btn-sm" style="cursor:pointer; display:inline-flex; align-items:center; gap:6px;">
          <ph-icon name="upload" [size]="14"/> {{ 'files.upload' | transloco }}
          <input type="file" multiple hidden (change)="onFileInput($event)" />
        </label>
      }

      <button class="sidebar-toggle" (click)="toggleSidebar.emit()">
        @if (sidebarOpen()) { <ph-icon name="caret-left" [size]="12"/> {{ 'files.sidebar.hideTree' | transloco }} }
        @else { <ph-icon name="caret-right" [size]="12"/> {{ 'files.sidebar.showTree' | transloco }} }
      </button>
    </div>
  `,
})
export class FileToolbarComponent {
  readonly spaces = input<readonly Space[]>([]);
  readonly activeSpaceId = input('');
  /** THE flag: the open id is a personal view, which never writes, so no new folder and no upload (`injectIsView`). */
  readonly isView = injectIsView(() => this.activeSpaceId());
  /** Hides the space selector: embedded in the Brain, the host has already chosen the space. */
  readonly embedded = input(false);
  readonly breadcrumbs = input<readonly BreadcrumbSegment[]>([]);
  readonly sidebarOpen = input(false);

  /** Two-way, so a refused create can keep the form open with what was typed — see the class note. */
  readonly folderFormOpen = model(false);
  readonly newFolderName = model('');

  readonly selectSpace = output<string>();
  readonly navigate = output<string>();
  readonly createFolder = output<void>();
  readonly filesPicked = output<FileList>();
  readonly toggleSidebar = output<void>();

  /**
   * Hand the picked files on, then clear the input so the same file can be picked again.
   *
   * Without the clear, a second pick of the same file fires no `change` event at all: the row never
   * appears, the upload never happens, and there is nothing on screen to explain either.
   */
  onFileInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (!files || files.length === 0) return;
    this.filesPicked.emit(files);
    input.value = '';
  }
}
