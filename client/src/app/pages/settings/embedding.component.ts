import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { HttpClient } from '@angular/common/http';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { refusalText } from '../../core/refusal-text';
import { TranslocoService } from '@jsverse/transloco';

/**
 * Who may frame and restyle this instance.
 *
 * ## Why this page exists
 *
 * `embed.allowedOrigins` has worked since embedding shipped, and it lived only in `config.json` — so granting a
 * portal permission to frame a brain meant shell access to the server and a text editor. The canary operator asked
 * for this on 2026-08-19, and their case is the one that shape does not serve: **someone runs a brain, someone else
 * wants to use it inside a portal, and the person who must act has to be talked through editing JSON on a server.**
 * In practice that does not happen and the brain stays in a browser tab.
 *
 * ## The warning is on the page, not only in the guide
 *
 * Listing an origin grants two things TOGETHER — framing (a clickjacking primitive) and runtime theming (a
 * UI-spoofing one) — and it is a deliberate design that they share one list: an origin you trust to render Ythril
 * inside its chrome is exactly the origin you trust to restyle it. An operator adding a line to a text box has to
 * be told that, at the moment they do it.
 *
 * ## Nothing here validates an origin
 *
 * The server does, with the same function the config-file path uses, and a refused entry comes back named. A copy of
 * that rule here would be the defect this repo produces most — and the weaker copy would be deciding who may frame
 * the admin UI. What this page must NOT do is drop a bad entry quietly: the operator typed it and is watching, so
 * the failure is shown rather than absorbed.
 */
@Component({
  selector: 'app-embedding',
  standalone: true,
  imports: [FormsModule, TranslocoModule, PhIconComponent, SettingsCardComponent],
  // NOTE: no backticks anywhere in this template. A backtick inside an inline template terminates the string and
  // Angular reports `NG1001: Decorator argument must be literal`, pointing at @Component rather than at the line.
  styles: [`
    .embed-page { display: flex; flex-direction: column; gap: 16px; }
    .origins { display: flex; flex-direction: column; gap: 8px; }
    .origin-row { display: flex; gap: 8px; align-items: center; }
    .origin-row input {
      flex: 1; padding: 8px 10px; font-family: var(--font-mono); font-size: 13px;
      background: var(--bg-primary); color: var(--text-primary);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
    }
    .origin-row input:focus { outline: none; border-color: var(--accent); }
    .origin-row input.rejected { border-color: var(--error); }
    .rm {
      display: grid; place-items: center; width: 30px; height: 30px; flex: none;
      background: none; border: 1px solid var(--border); border-radius: var(--radius-sm);
      color: var(--text-muted); cursor: pointer;
    }
    .rm:hover { color: var(--error); border-color: var(--error); }
    .actions { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
    .danger-note {
      display: flex; gap: 8px; padding: 10px 12px; margin: 0 0 12px;
      border: 1px solid var(--warning); border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--warning) 8%, transparent);
      font-size: 13px; line-height: 1.5; color: var(--text-primary);
    }
    .danger-note ph-icon { flex: none; color: var(--warning); margin-top: 2px; }
    .hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .problem { font-size: 13px; color: var(--error); margin: 8px 0 0; }
    .problem code { font-family: var(--font-mono); }
    .saved { font-size: 13px; color: var(--success); margin: 0; }
    .empty { font-size: 13px; color: var(--text-muted); margin: 0; }
  `],
  template: `
    <div class="embed-page">
      <app-settings-card
        icon="corners-out"
        [heading]="'embedding.origins.title' | transloco"
        [purpose]="'embedding.origins.subtitle' | transloco">

        <p class="danger-note">
          <ph-icon name="warning" [size]="16"/>
          <span>{{ 'embedding.origins.warning' | transloco }}</span>
        </p>

        @if (origins().length === 0) {
          <p class="empty">{{ 'embedding.origins.none' | transloco }}</p>
        }

        <div class="origins">
          @for (o of origins(); track $index) {
            <div class="origin-row">
              <input
                type="text" spellcheck="false" autocomplete="off"
                placeholder="https://portal.example.com"
                [class.rejected]="rejected().includes(o)"
                [ngModel]="o" (ngModelChange)="setOrigin($index, $event)"
                [attr.aria-label]="'embedding.origins.entryLabel' | transloco" />
              <button type="button" class="rm" (click)="removeOrigin($index)"
                [attr.aria-label]="'common.remove' | transloco">
                <ph-icon name="x" [size]="12"/>
              </button>
            </div>
          }
        </div>

        <div class="actions">
          <button type="button" class="btn" (click)="addOrigin()">
            {{ 'embedding.origins.add' | transloco }}
          </button>
          <button type="button" class="btn btn-primary" [disabled]="saving()" (click)="save()">
            {{ (saving() ? 'common.saving' : 'common.save') | transloco }}
          </button>
          @if (savedAt()) {
            <p class="saved">{{ 'embedding.origins.saved' | transloco }}</p>
          }
        </div>

        @if (problem()) {
          <p class="problem">{{ problem() }}</p>
        }

        <p class="hint">{{ 'embedding.origins.hint' | transloco }}</p>
      </app-settings-card>
    </div>
  `,
})
export class EmbeddingComponent {
  private http = inject(HttpClient);
  private transloco = inject(TranslocoService);

  origins = signal<string[]>([]);
  /** Entries the SERVER refused, so the row that is wrong is the row that is marked. */
  rejected = signal<string[]>([]);
  problem = signal<string | null>(null);
  saving = signal(false);
  savedAt = signal(false);

  constructor() { this.load(); }

  load(): void {
    this.http.get<{ allowedOrigins: string[]; invalid: string[] }>('/api/admin/embed-config').subscribe({
      next: r => {
        this.origins.set([...(r.allowedOrigins ?? [])]);
        /*
         * A stored entry the validator drops is shown as rejected on arrival, not only after a save. An operator
         * whose portal will not frame is looking at this page to find out why, and an invalid line in config.json
         * that rendered identically to a valid one would be the whole answer, hidden.
         */
        this.rejected.set([...(r.invalid ?? [])]);
      },
      error: () => this.problem.set('Could not load the embed configuration.'),
    });
  }

  addOrigin(): void {
    this.origins.update(list => [...list, '']);
  }

  setOrigin(i: number, value: string): void {
    /*
     * The PREVIOUS value is what leaves the rejected list — read before the update, because after it the old text
     * is gone. My first version filtered the NEW value instead, which removes nothing and leaves the old entry
     * sitting in `rejected` forever. It looked right on screen (the row compares against its current text, which no
     * longer matches) and was wrong in the state, so a row could come back red on an edit that had cleared it.
     */
    const previous = this.origins()[i];
    this.origins.update(list => list.map((o, n) => (n === i ? value : o)));
    if (previous !== undefined) this.rejected.update(list => list.filter(o => o !== previous));
    this.savedAt.set(false);
  }

  removeOrigin(i: number): void {
    this.origins.update(list => list.filter((_, n) => n !== i));
    this.savedAt.set(false);
  }

  save(): void {
    this.saving.set(true);
    this.problem.set(null);
    this.savedAt.set(false);
    // Blank rows are dropped rather than sent: an empty input is somebody who clicked Add and changed their mind,
    // not an origin they want refused.
    const allowedOrigins = this.origins().map(o => o.trim()).filter(Boolean);
    this.http.patch<{ allowedOrigins: string[] }>('/api/admin/embed-config', { allowedOrigins }).subscribe({
      next: r => {
        this.origins.set([...r.allowedOrigins]);
        this.rejected.set([]);
        this.saving.set(false);
        this.savedAt.set(true);
      },
      error: err => {
        this.saving.set(false);
        const invalid: string[] = err?.error?.invalid ?? [];
        this.rejected.set(invalid);
        this.problem.set(refusalText(this.transloco, err, 'refusal.failed.embeddingChange'));
      },
    });
  }
}
