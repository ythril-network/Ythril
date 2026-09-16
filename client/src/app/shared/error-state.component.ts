/**
 * Error-state — the counterpart to the empty state, for when a list *failed to
 * load* rather than legitimately having no rows (UX U3).
 *
 * A failed request must never fall through to a friendly "No facts yet…"
 * empty state: that tells the user, in the app's own reassuring voice, that
 * their data does not exist — so they won't retry and may conclude the brain
 * was wiped. This renders a visually distinct state (warning icon, "Couldn't
 * load …", the failure reason, and a Retry button) that call sites show
 * *before* the empty state whenever their error signal is set.
 *
 * Usage:
 *   @if (loadError()) {
 *     <app-error-state [message]="'brain.error.loadFacts' | transloco"
 *                      [reason]="loadError()" (retry)="reload()" />
 *   } @else if (rows().length === 0) { ...empty state... }
 */
import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from './ph-icon.component';

@Component({
  selector: 'app-error-state',
  standalone: true,
  imports: [CommonModule, TranslocoPipe, PhIconComponent],
  styles: [`
    .error-state {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center;
      padding: 40px 24px;
      color: var(--text-secondary);
    }
    .error-icon { color: var(--error); margin-bottom: 12px; opacity: 0.85; }
    .error-title { font-size: 15px; font-weight: 600; color: var(--text-primary); margin: 0 0 4px; }
    .error-reason {
      font-size: 12px; color: var(--text-muted); margin: 0 0 16px;
      max-width: 420px; word-break: break-word;
      font-family: var(--font-mono, monospace);
    }
    .retry-btn { display: inline-flex; align-items: center; gap: 6px; }
  `],
  template: `
    <div class="error-state" role="alert">
      <div class="error-icon"><ph-icon name="warning" [size]="icon()"/></div>
      <p class="error-title">{{ message() || ('common.loadFailed' | transloco) }}</p>
      @if (reason()) {
        <p class="error-reason">{{ reason() }}</p>
      }
      <button type="button" class="btn btn-secondary btn-sm retry-btn" (click)="retry.emit()">
        <ph-icon name="arrows-clockwise" [size]="14"/>{{ 'common.retry' | transloco }}
      </button>
    </div>
  `,
})
export class ErrorStateComponent {
  /** Headline, e.g. "Couldn't load memories". Falls back to a generic message. */
  message = input<string>('');
  /** Optional failure detail (HTTP status text / server error message). */
  reason = input<string>('');
  /** Icon size (defaults to 48 to match the empty-state icons). */
  icon = input<number>(48);
  /** Emitted when the user clicks Retry — the call site re-runs its load. */
  retry = output<void>();
}
