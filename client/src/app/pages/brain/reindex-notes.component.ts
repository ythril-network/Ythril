/**
 * What the Indexing panel says about reindexing: that one is needed, or how far a running one has got.
 *
 * Its own component because `overview-tab.component.ts` is frozen by the size ratchet, and these lines answer
 * one question together — they replace one another as the state changes, and reading them apart is how the panel once
 * recommended a reindex directly above the progress of the one already running (Q-99 part 2).
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import type { ReindexRunState } from '../../core/embed-ops.types';

@Component({
  selector: 'app-reindex-notes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent],
  styles: [`
    :host { display: block; }
    .reindex-note { display: flex; align-items: flex-start; gap: 8px; margin-top: 13px; padding: 10px 12px;
      border-radius: 8px; font-size: 12.5px; border: 1px solid var(--warning-border); background: var(--warning-bg); }
    .reindex-note ph-icon { flex: none; margin-top: 1px; color: var(--warning); }
    .reindex-note .spinner { width: 12px; height: 12px; border-width: 2px; flex: none; margin-top: 2px; }
  `],
  template: `
    @if (run()?.running) {
      <!-- A run's progress, read from the server while it lasts: role=status so a screen reader hears it change
           without the focus moving. It replaces the recommendation, which would point at a button held for exactly
           this reason. -->
      <div class="reindex-note" role="status">
        <span class="spinner"></span>
        <span>{{ 'brain.overview.reindexProgress' | transloco: { remaining: run()!.remaining, failed: run()!.failed } }}</span>
      </div>
    } @else if (needsReindex()) {
      <div class="reindex-note">
        <ph-icon name="warning" [size]="15"/>
        <span>{{ 'brain.overview.reindexNeeded' | transloco }}</span>
      </div>
    }
  `,
})
export class ReindexNotesComponent {
  readonly needsReindex = input(false);
  readonly run = input<ReindexRunState | null>(null);
}
