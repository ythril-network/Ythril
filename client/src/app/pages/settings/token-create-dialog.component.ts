import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { withInstanceFlag } from '../../core/token-capability';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { AuthApi } from '../../core/auth-api.service';
import { RightsMatrixComponent } from './rights-matrix.component';
import { DIALOG_STYLES } from './dialog.styles';
import type { TokenRights } from './rights-glyph.component';
import type { Space, TokenRecord } from '../../core/api.types';

/**
 * The create-token dialog: a label, an optional expiry, and the rights matrix.
 *
 * ## Why it is its own component
 *
 * It was over a quarter of `tokens.component.ts` and pushed that file past the god-file ceiling.
 *
 * That extraction also produced the bug this file's styles now fix. `.dialog-backdrop` and `.dialog` were
 * defined in `tokens.component.ts`, and Angular scopes component styles — so moving the markup out left the
 * CSS behind and the "dialog" rendered as a plain full-width block at the top of the page, no backdrop, no
 * centring, pushing the token list down. Nothing failed: it compiled, it rendered, the tests passed, and it
 * was simply wrong to look at. The shell now comes from `DIALOG_STYLES`, which a move cannot leave behind.
 *
 * ## Why three controls became one
 *
 * The form used to carry a spaces checkbox list, a three-way permission radio (read-only / standard / admin)
 * AND the matrix behind a "Use the per-space matrix" button. Those are two vocabularies for one decision, and
 * the server treats them as **mutually exclusive** — so the form could compose a body the API refuses, and
 * the operator would read that 400 as a bug rather than as a choice they had made.
 *
 * The matrix expresses everything the radio and the checkbox list expressed, and things they could not
 * (admin on Files in one space and nothing anywhere else). So they are gone, not kept beside it.
 *
 * The second-factor selector is gone from CREATE for a different reason: MFA is a property of the token, set
 * on the token, not a decision folded into minting it.
 *
 * ## The contract this must not change
 *
 * The REQUEST BODY. It is what the server's mint cap and the audit log see, and `tokens.component.spec.ts`
 * characterizes it. Those tests were rewritten with this change rather than around it: the body is now always
 * `{ name, rights }` plus an optional `expiresAt`, and never the legacy trio.
 */
@Component({
  selector: 'app-token-create-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective, RightsMatrixComponent],
  styles: [DIALOG_STYLES, `
    /*
     * WIDEN FOR THE MATRIX — the edit dialog does this and this one did not, so two of the four areas were
     * unreachable when MINTING a token.
     *
     * Found by screenshotting the dialog, and it could not have been found any other way: all five columns
     * are in the DOM and countable (5 headers, 8 rung pickers), and Data quality was simply not on screen
     * while Schema's rungs were clipped mid-cell. Measured at the shared 600px default: clientWidth 598,
     * maxWidth 600px, and scrollWidth EQUAL to clientWidth — so nothing scrolled and nothing overflowed in a
     * way any assertion would notice. The table was squeezed, not scrollable.
     *
     * The same value as the rights dialog, which carries the reason: at 600px the matrix renders as a column
     * of squeezed cells and the space rows wrap, reported as 'too narrow'. Same table, same need, same
     * number — a different one here would be a second answer to one question.
     */
    :host { --dialog-max-width: min(1400px, 94vw); }
  `],
  template: `
      <div class="dialog-backdrop">
        <div class="dialog" [appModal]="'tokens.create.title' | transloco" (dismiss)="close.emit()" (click)="$event.stopPropagation()">
          <div class="dialog-header">
            <div class="card-title">{{ 'tokens.create.title' | transloco }}</div>
            <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="close.emit()"><ph-icon name="x" [size]="14"/></button>
          </div>

          @if (createError()) {
            <div class="alert alert-error" style="margin-bottom:16px;">{{ createError() }}</div>
          }

          <form (ngSubmit)="createToken()" #f="ngForm">
            <div class="form-grid">
              <div class="field" style="margin-bottom:0;">
                <label>{{ 'tokens.create.label' | transloco }}</label>
                <input type="text" [(ngModel)]="newName" name="name" [placeholder]="'tokens.create.labelPlaceholder' | transloco" maxlength="200" required />
              </div>
              <div class="field" style="margin-bottom:0;">
                <label>{{ 'tokens.create.expires' | transloco }}</label>
                <input type="date" class="styled-input" [(ngModel)]="newExpiry" name="expiry" />
              </div>
              <div class="field" style="margin-bottom:0;">
                <label>{{ 'tokens.create.rateLimit' | transloco }}</label>
                <input type="number" class="styled-input" [(ngModel)]="newRateLimit" name="rateLimit"
                  min="1" step="1" [placeholder]="'tokens.create.rateLimitInherit' | transloco" />
                <div class="hint">{{ 'tokens.create.rateLimitHint' | transloco }}</div>
              </div>
            </div>

            <!-- The per-space matrix, and it is the whole permission model now.
                 It used to sit behind a "Use the per-space matrix" button, below a spaces checkbox list and a
                 three-way permission radio that described the SAME access in the pre-2.6.0 vocabulary. Three
                 controls for one decision, two of which the server treats as mutually exclusive with the
                 third — so the form could express bodies the API refuses. The matrix says everything they
                 said and things they could not (admin on Files in one space and nothing anywhere else), so
                 they are gone rather than kept beside it. -->
            <div class="field" style="margin-top:14px; margin-bottom:0;">
              <label>{{ 'tokens.create.permission' | transloco }}</label>
              <p class="permission-help">
                <ph-icon name="info" [size]="14" />
                <span>{{ 'tokens.matrix.help' | transloco }}</span>
              </p>
              @if (spacesLoadFailed()) {
                <div class="alert alert-error" style="margin-top:6px; font-size:12px;">{{ 'tokens.create.spacesLoadFailed' | transloco }}</div>
              } @else if (availableSpaces().length === 0) {
                <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">{{ 'tokens.create.loadingSpaces' | transloco }}</div>
              } @else {
                <app-rights-matrix
                  [rights]="draftRights()"
                  [spaces]="spaceIds()"
                  (changed)="draftRights.set($event)"/>
              }
            </div>

            <!-- INSTANCE-LEVEL RIGHTS, and this dialog had none of them.
                 draftRights hardcoded instanceAdmin and createSpaces to false with no control, so a token
                 that should hold either had to be created and then EDITED — while the create API has always
                 accepted both (CreateTokenBody declares them). The edit dialog grew these controls in #908
                 and nothing brought them here. Reported by the canary operator 2026-08-17 §9 as the two forms
                 presenting different rights surfaces; it is one missing block, not a diverged surface.

                 OUTSIDE the spaces check above, deliberately. That branch renders nothing when the instance
                 has no spaces yet — and a fresh instance with no spaces is exactly when createSpaces is the
                 right thing to grant. Nesting these inside it would leave the one case they matter most
                 unreachable.

                 Shown rather than hidden from a scoped editor, matching the edit dialog and its stated reason:
                 the server refuses a space-restricted administrator who tries to grant either, so the control
                 offers what the caller may attempt and the server stays the authority. -->
            <div class="danger-zone" style="margin-top:14px;">
              <div class="danger-title">{{ 'tokens.rights.instanceLevel' | transloco }}</div>
              <p class="permission-help" style="margin-top:6px;">
                <ph-icon name="info" [size]="14" />
                <span>{{ 'tokens.rights.instanceLevelHint' | transloco }}</span>
              </p>
              <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
                <input type="checkbox" [checked]="draftRights().instanceAdmin"
                       (change)="setFlag('instanceAdmin', $any($event.target).checked)" />
                <span>{{ 'tokens.rights.instanceAdmin' | transloco }}</span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;margin-top:8px;">
                <input type="checkbox" [checked]="draftRights().createSpaces"
                       (change)="setFlag('createSpaces', $any($event.target).checked)" />
                <span>{{ 'tokens.rights.createSpaces' | transloco }}</span>
              </label>
            </div>

            <div class="form-grid-bottom" style="margin-top:12px;">
              <button class="btn-secondary btn" type="button" (click)="close.emit()">{{ 'common.cancel' | transloco }}</button>
              <button class="btn-primary btn" type="submit" style="margin-left:auto;" [disabled]="creating() || !newName.trim()">
                @if (creating()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
                {{ 'tokens.create.submitButton' | transloco }}
              </button>
            </div>
          </form>
        </div>
      </div>
  `,
})
export class TokenCreateDialogComponent {
  private authApi = inject(AuthApi);
  private transloco = inject(TranslocoService);

  availableSpaces = input<Space[]>([]);
  spacesLoadFailed = input(false);
  close = output<void>();
  created = output<{ token: TokenRecord; plaintext: string }>();

  creating = signal(false);
  createError = signal('');
  /** Just the ids: the matrix keys rows by id and does not need the rest of a space. */
  spaceIds = computed(() => this.availableSpaces().map(s => s.id));
  draftRights = signal<TokenRights>({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} });
  newName = '';
  newExpiry = '';
  /*
   * Empty means INHERIT the instance value, which is what most tokens should carry — so the field is left
   * blank by default and an empty string is never sent as a number. Sending a resolved default instead would
   * freeze today's instance value onto every token minted through this dialog.
   */
  newRateLimit: number | null = null;

  /**
   * The two instance-level flags, settable at MINT time — which they were not.
   *
   * `draftRights` initialised both to `false` and nothing could change them, so a token that should hold
   * either had to be created and then edited. The create API accepted both throughout (`CreateTokenBody`),
   * and the edit dialog grew the controls in #908; only this form was left behind.
   *
   * Same signature and same one-line body as the edit dialog's `setFlag`, on purpose: two spellings of one
   * update is how the two forms drift apart again, and this defect IS that drift.
   */
  setFlag(key: 'instanceAdmin' | 'createSpaces', on: boolean): void {
    this.draftRights.update(d => withInstanceFlag(d, key, on));
  }

  createToken(): void {
    if (!this.newName.trim()) return;
    this.creating.set(true);
    this.createError.set('');

    // ONE description of access, always the matrix. The legacy `spaces`/`admin`/`readOnly` trio is mutually
    // exclusive with `rights` on the server, so a form offering both could compose a body the API refuses —
    // and the operator would read that 400 as a bug rather than as a choice they had made.
    const body: { name: string; expiresAt?: string; rights: TokenRights; rateLimitPerMinute?: number } = {
      name: this.newName.trim(),
      rights: this.draftRights(),
    };
    if (this.newExpiry) body.expiresAt = new Date(this.newExpiry).toISOString();
    // Only when actually given. A blank field means inherit, and `0` is not a legal quota — the server
    // refuses it — so a falsy check is the right test rather than a null check.
    if (this.newRateLimit) body.rateLimitPerMinute = Number(this.newRateLimit);

    this.authApi.createToken(body).subscribe({
      next: ({ token, plaintext }) => {
        this.creating.set(false);
        this.close.emit();
        this.created.emit({ token, plaintext });
        this.newName = '';
        this.newExpiry = '';
        this.newRateLimit = null;
      },
      error: (err) => {
        this.creating.set(false);
        this.createError.set(err.error?.error ?? this.transloco.translate('tokens.error.createFailed'));
      },
    });
  }
}
