import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { AuthApi } from '../../core/auth-api.service';
import { RightsMatrixComponent } from './rights-matrix.component';
import { RightsGlyphComponent, type TokenRights } from './rights-glyph.component';

/**
 * Your OWN token's rights, read-only.
 *
 * ## The gap this closes
 *
 * Owner: *"everyone else at least view their own"*. `GET /api/tokens/me` has always returned the caller's whole
 * record, `rights` included — but the typed client declared the response as `{ id, name, spaces? }`, so the
 * matrix was discarded on arrival and nothing could render it. The tokens page lists through the admin-only
 * `GET /api/tokens`, so a non-admin opening Settings → Tokens saw an ERROR where their own access should be.
 *
 * Same shape as three other things fixed this week: the server returns it, the client's type does not admit it,
 * and no wrong behaviour is observable — only a person missing information they are entitled to.
 *
 * ## Read-only by REUSE, not by re-rendering
 *
 * It renders the same `app-rights-matrix` an admin edits, in `readonlyView` mode. A second renderer for a
 * permission grid would be two places the clamping and the colours could disagree, and the one a reader trusted
 * would be whichever they happened to open.
 *
 * A token with no `rights` object at all is a pre-2.6 record on the legacy path. It gets a sentence rather than
 * an empty grid, because an empty grid reads as "you have nothing".
 */
@Component({
  selector: 'app-own-token-rights',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, RightsMatrixComponent, RightsGlyphComponent],
  styles: [`
    :host { display: block; margin-bottom: 20px; }
    .own {
      border: 1px solid var(--border); border-radius: var(--radius-md);
      background: var(--bg-surface); padding: 14px 16px;
    }
    .head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .head h3 { margin: 0; font-size: 13.5px; }
    .name { font-family: var(--font-mono, monospace); font-size: 12px; color: var(--text-secondary); }
    .legacy { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
  `],
  template: `
    @if (rights(); as r) {
      <div class="own">
        <div class="head">
          <h3>{{ 'tokens.own.title' | transloco }}</h3>
          @if (name(); as n) { <span class="name">{{ n }}</span> }
          <app-rights-glyph [rights]="r"/>
        </div>
        <!-- Read-only, said to assistive technology rather than in a visible sentence (the owner removed the sentence): a group named so, around disabled controls. -->
        <app-rights-matrix role="group" [attr.aria-label]="'tokens.own.matrixLabel' | transloco" [rights]="r" [spaces]="spaces()" [readonlyView]="true"/>
      </div>
    } @else if (legacy()) {
      <div class="own">
        <div class="head"><h3>{{ 'tokens.own.title' | transloco }}</h3></div>
        <p class="legacy">{{ 'tokens.own.legacy' | transloco }}</p>
      </div>
    }
  `,
})
export class OwnTokenRightsComponent implements OnInit {
  private auth = inject(AuthApi);

  readonly rights = signal<TokenRights | null>(null);
  readonly name = signal<string | null>(null);
  /** A pre-2.6 token: authenticated, but carrying no matrix to show. */
  readonly legacy = signal(false);
  readonly spaces = signal<string[]>([]);

  ngOnInit(): void {
    this.auth.verifyToken().subscribe({
      next: (me) => {
        this.name.set(me.name ?? null);
        if (me.rights) {
          this.rights.set(me.rights);
          // The rows to draw are the spaces this token's own grid names. Not every space on the instance —
          // listing those needs a right this caller may not hold, and a row per unreachable space would say
          // the opposite of what it means.
          this.spaces.set(Object.keys(me.rights.perSpace ?? {}).sort());
        } else {
          this.legacy.set(true);
        }
      },
      // Silent: this panel is an extra on a page that has its own error surface, and a second error banner for
      // the same failed session is noise.
      error: () => {},
    });
  }
}
