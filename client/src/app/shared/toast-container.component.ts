/**
 * Toast container — renders the ToastService stack in a fixed, theme-aware
 * region. Mount once in the app shell (<app-toast-container />).
 *
 * Accessibility: the region is an aria-live polite log so screen readers
 * announce new messages without stealing focus; each toast has a labelled
 * dismiss button.
 */
import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { ToastService } from '../core/toast.service';

@Component({
  selector: 'app-toast-container',
  standalone: true,
  imports: [CommonModule, TranslocoPipe],
  styles: [`
    .toast-region {
      position: fixed;
      bottom: 1.25rem; right: 1.25rem;
      display: flex; flex-direction: column; gap: 0.6rem;
      z-index: 10001;            /* above the CDK overlay backdrop */
      max-width: min(92vw, 420px);
      pointer-events: none;      /* let clicks through the gaps */
    }
    .toast {
      pointer-events: auto;
      display: flex; align-items: flex-start; gap: 0.6rem;
      padding: 0.7rem 0.85rem;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      box-shadow: var(--shadow-sm, 0 4px 12px rgba(0,0,0,0.25));
      color: var(--text-primary);
      font-size: 0.86rem; line-height: 1.35;
      border-left-width: 3px;
    }
    .toast.success { border-left-color: var(--success); }
    .toast.error   { border-left-color: var(--error); }
    .toast.info    { border-left-color: var(--info); }
    .icon { flex: 0 0 auto; font-weight: 700; line-height: 1.35; }
    .toast.success .icon { color: var(--success); }
    .toast.error   .icon { color: var(--error); }
    .toast.info    .icon { color: var(--info); }
    /* pre-line: a toast that lists several things (one failed conflict per line) keeps its line breaks. */
    .message { flex: 1 1 auto; word-break: break-word; white-space: pre-line; }
    .dismiss {
      flex: 0 0 auto;
      background: none; border: none; cursor: pointer;
      color: var(--text-muted); font-size: 1rem; line-height: 1;
      padding: 0 0.15rem;
    }
    .dismiss:hover { color: var(--text-primary); }
    @media (prefers-reduced-motion: no-preference) {
      .toast { animation: toast-in 140ms ease-out; }
    }
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `],
  template: `
    <div class="toast-region" aria-live="polite" aria-relevant="additions" role="log">
      @for (t of toasts(); track t.id) {
        <div class="toast" [class]="'toast ' + t.kind">
          <span class="icon" aria-hidden="true">{{ icon(t.kind) }}</span>
          <span class="message">{{ t.message }}</span>
          <button
            type="button"
            class="dismiss"
            [attr.aria-label]="'common.close' | transloco"
            (click)="toastService.dismiss(t.id)"
          >&times;</button>
        </div>
      }
    </div>
  `,
})
export class ToastContainerComponent {
  readonly toastService = inject(ToastService);
  readonly toasts = this.toastService.toasts;

  icon(kind: string): string {
    return kind === 'success' ? '✓' : kind === 'error' ? '⚠' : 'ℹ';
  }
}
