/**
 * Files awaiting bytes — the word beside a space's file count when records of it wait for their bytes (bundle-70, Q-337).
 *
 * A file record whose bytes are gone from this instance's disk is left out of `files` and counted apart, as `filesAwaitingBytes`
 * (`GET /api/brain/spaces/:spaceId/stats`). A page that shows `files` alone shows a number that dropped with no word: this says how many
 * records wait, and on hover what that means. Nothing is rendered while the count is 0 or the server did not send one (an older server).
 *
 * The Brain page's tab strip says the same through the same two plural bases (`brain.filesAwaitingBytes`, `brain.filesAwaitingBytesHint`), with the
 * `plural` pipe inline: that page is at its size limit and takes no import.
 *
 * Usage:  <app-files-awaiting-bytes [count]="stats.filesAwaitingBytes"/>
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { PluralPipe } from '../core/plural.pipe';

declare module '../core/api.types' {
  interface SpaceStats {
    /** File records whose bytes are gone from this instance's disk, left out of `files` while they wait (absent from an older server). */
    filesAwaitingBytes?: number;
  }
}

@Component({
  selector: 'app-files-awaiting-bytes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PluralPipe],
  styles: [`.awaiting { color: var(--text-muted); font-size: 12px; margin-left: 6px; }`],
  template: `@if (count(); as n) {<span class="awaiting" data-testid="files-awaiting-bytes" [attr.title]="n | plural:'brain.filesAwaitingBytesHint'">{{ n | plural:'brain.filesAwaitingBytes' }}</span>}`,
})
export class FilesAwaitingBytesComponent {
  /** How many file records wait for their bytes; 0 or undefined renders nothing. */
  readonly count = input<number | undefined>(undefined);
}
