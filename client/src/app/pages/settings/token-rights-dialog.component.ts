import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { withInstanceFlag } from '../../core/token-capability';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { AuthApi } from '../../core/auth-api.service';
import { RightsMatrixComponent } from './rights-matrix.component';
import { DIALOG_STYLES } from './dialog.styles';
import { FormsModule } from '@angular/forms';
import type { TokenRights } from './rights-glyph.component';
import type { Space, TokenRecord } from '../../core/api.types';

/**
 * Edit an existing token's rights.
 *
 * ## Why the server's refusals are surfaced verbatim
 *
 * Two guards can reject this save, and both are decisions the operator needs the reason for:
 *
 *  - **the cap** — a token may not grant rights it does not hold, and the 403 names every level that was
 *    over the line;
 *  - **the floor** — a token may not raise its OWN floor, and the 403 names the areas that would have gone
 *    up.
 *
 * Replacing either with a generic "could not save" would leave the operator guessing between "I asked for
 * too much" and "I am not allowed to do this to myself", which are different problems with different next
 * steps. So the message is shown as it arrives.
 *
 * ## Why the draft starts from what the token has
 *
 * Starting from an empty matrix would make every save a silent narrowing of everything the operator did not
 * happen to re-enter.
 */
@Component({
  selector: 'app-token-rights-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, ModalDirective, RightsMatrixComponent, FormsModule],
  styles: [DIALOG_STYLES, `
    /* The matrix is areas x rungs, once per space. At the shared 600px default it renders as a column of
       squeezed cells and the space rows wrap — reported as "too narrow". The --dialog-max-width variable exists
       precisely so a host can say this; sizing was always the caller's decision. */
    :host { --dialog-max-width: min(1400px, 94vw); }
    /* .danger-zone, .danger-title and .permission-help moved to DIALOG_STYLES when the CREATE dialog
       gained the same instance-level flags — its markup used these names and rendered unstyled, because
       per-component encapsulation means this copy could not reach it. The rows below stay here: rotate and
       revoke exist in this dialog only. */
    .danger-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .danger-row + .danger-row {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
    .danger-label { font-size: 13px; font-weight: 500; }
    .danger-hint { font-size: 11.5px; color: var(--text-muted); margin-top: 2px; }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" [appModal]="'tokens.rights.title' | transloco"
           (dismiss)="close.emit()" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <h3>{{ 'tokens.rights.title' | transloco }} — {{ token().name }}</h3>
          <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="close.emit()">
            <ph-icon name="x" [size]="14"/>
          </button>
        </div>

        @if (error()) {
          <!-- Verbatim: the server names the areas or levels that were refused, and a generic message would
               leave the operator guessing which of the two guards fired. -->
          <p class="form-error" role="alert" style="white-space:pre-wrap;">{{ error() }}</p>
        }

        <!-- The label, editable here and nowhere else. This dialog used to edit the rights matrix ALONE, so a
             token's name was write-once: it could be set while minting and never corrected afterwards, even
             though PATCH has always accepted it. The two travel in one request, so a rename and a rights
             change are one audited edit rather than two that can half-fail. -->
        <div class="field" style="margin-bottom:14px;">
          <label for="tokenLabel">{{ 'tokens.create.label' | transloco }}</label>
          <input id="tokenLabel" type="text" [(ngModel)]="draftName" name="name"
                 [placeholder]="'tokens.create.labelPlaceholder' | transloco" maxlength="200" />
        </div>

        <label style="display:block;margin-bottom:6px;">{{ 'tokens.create.permission' | transloco }}</label>
        <app-rights-matrix [rights]="draft()" [spaces]="spaceIds()" (changed)="draft.set($event)"/>


        <!-- Danger zone. Present because this editor is where a token is managed, and rotate/revoke were
             reachable only as two small icons on the list row — so the whole token was managed in two places.
             Both EMIT rather than acting: the page owns the confirmation, the failure toast, the list removal,
             and the copy-once banner that a rotated secret appears in. It also closes this dialog first,
             because that banner renders behind it. -->
        <div class="danger-zone">
          <div class="danger-title">{{ 'tokens.danger.title' | transloco }}</div>
          <div class="danger-title">{{ 'tokens.rights.instanceLevel' | transloco }}</div>
          <p class="permission-help" style="margin-top:6px;">
            <ph-icon name="info" [size]="14" />
            <span>{{ 'tokens.rights.instanceLevelHint' | transloco }}</span>
          </p>
          <label style="display:flex;align-items:center;gap:8px;margin-top:10px;">
            <input type="checkbox" [checked]="draft().instanceAdmin"
                   (change)="setFlag('instanceAdmin', $any($event.target).checked)" />
            <span>{{ 'tokens.rights.instanceAdmin' | transloco }}</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;margin-top:8px;">
            <input type="checkbox" [checked]="draft().createSpaces"
                   (change)="setFlag('createSpaces', $any($event.target).checked)" />
            <span>{{ 'tokens.rights.createSpaces' | transloco }}</span>
          </label>

          <div class="danger-row">
            <div>
              <div class="danger-label">{{ 'tokens.rotateButton' | transloco }}</div>
              <div class="danger-hint">{{ 'tokens.danger.rotateHint' | transloco }}</div>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" (click)="rotate.emit()">
              {{ 'tokens.rotateButton' | transloco }}
            </button>
          </div>
          <div class="danger-row">
            <div>
              <div class="danger-label">{{ 'common.revoke' | transloco }}</div>
              <div class="danger-hint">{{ 'tokens.danger.revokeHint' | transloco }}</div>
            </div>
            <button class="btn btn-danger btn-sm" type="button" (click)="revoke.emit()">
              {{ 'common.revoke' | transloco }}
            </button>
          </div>
        </div>

        <div class="form-grid-bottom" style="margin-top:12px;">
          <button class="btn-secondary btn" type="button" (click)="close.emit()">
            {{ 'common.cancel' | transloco }}
          </button>
          <button class="btn-primary btn" type="button" style="margin-left:auto;"
                  [disabled]="saving()" (click)="save()">
            {{ 'common.save' | transloco }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class TokenRightsDialogComponent {
  private authApi = inject(AuthApi);
  private transloco = inject(TranslocoService);

  token = input.required<TokenRecord>();
  availableSpaces = input<Space[]>([]);
  close = output<void>();
  saved = output<TokenRecord>();
  /**
   * The danger actions, as requests rather than deeds.
   *
   * Neither is performed here. The host owns the confirm dialog, the failure toast, the list removal, and the
   * copy-once banner a rotated secret appears in — and it closes this dialog before acting, because that
   * banner renders behind the modal. Doing either here would mean a second confirmation flow and, for rotate,
   * a second place a credential is shown once.
   */
  rotate = output<void>();
  revoke = output<void>();

  saving = signal(false);
  error = signal('');

  /** Starts from what the token HAS — an empty start would make every save narrow everything not re-entered. */
  draft = signal<TokenRights>({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} });
  /** Same reasoning for the label: prefilled, so saving without touching it is not a rename to empty. */
  draftName = '';
  /**
   * The two instance-level flags, which had no control at all until now.
   *
   * They are part of the matrix the server already stores and PATCH already accepts — `migrateToken` sets
   * `instanceAdmin` from the legacy admin flag — so tokens HELD them while the editor could neither grant
   * nor revoke one. An instance admin could not be demoted from the UI.
   *
   * In the danger zone because that is where the owner placed them: they are not a rung on a space, they are
   * the whole instance. The server refuses a space-restricted administrator who tries to grant either, so
   * this control offers what the caller may actually do and the server remains the authority.
   */
  setFlag(key: 'instanceAdmin' | 'createSpaces', on: boolean): void {
    this.draft.update(d => withInstanceFlag(d, key, on));
  }

  /**
   * Still sent, never shown. The second-factor controls were removed from token management on the owner's
   * instruction — the SERVER behaviour is untouched: `mfa` remains on the PATCH body and granting an
   * exemption still costs a live TOTP code. This dialog simply stops offering to change it, so the value
   * round-trips as whatever the token already had.
   */
  draftMfa: 'inherit' | 'exempt' | 'required' = 'inherit';
  totpCode = '';

  /**
   * Ask for a code only when GRANTING an exemption — not when a token already has one and something else is
   * being edited, and not when moving away from one.
   *
   * Deliberately not conditioned on whether MFA is enabled instance-wide: this component would have to fetch
   * that, and a second source for "is MFA on" is a second answer that can disagree with the server's. When the
   * switch is off the server ignores the code, so offering the field costs nothing; when it is on, the code is
   * required and asking here beats a 403 the operator cannot connect to the field they changed.
   *
   * Save is NOT gated on it for the same reason — the server owns that decision, and gating locally would
   * refuse a save the instance would have accepted.
   */
  needsCode = () => this.draftMfa === 'exempt' && (this.token().mfa ?? 'inherit') !== 'exempt';

  spaceIds = () => this.availableSpaces().map(s => s.id);

  ngOnInit(): void {
    const r = this.token().rights;
    if (r) this.draft.set({ ...r } as TokenRights);
    this.draftName = this.token().name;
    this.draftMfa = this.token().mfa ?? 'inherit';
  }

  save(): void {
    this.saving.set(true);
    this.error.set('');
    // Each field goes only when it actually changed. Sending one unchanged would work — PATCH accepts it — but
    // it would write a `token.update` audit entry claiming an edit that did not happen, and for the second
    // factor that is the entry someone will one day read to find out when an exemption was granted.
    const trimmed = this.draftName.trim();
    const renamed = trimmed && trimmed !== this.token().name;
    const mfaChanged = this.draftMfa !== (this.token().mfa ?? 'inherit');
    this.authApi.updateToken(this.token().id, {
      rights: this.draft(),
      ...(renamed ? { name: trimmed } : {}),
      ...(mfaChanged ? { mfa: this.draftMfa } : {}),
    }, this.totpCode.trim() || undefined).subscribe({
      next: ({ token }) => { this.saving.set(false); this.saved.emit(token); },
      error: (err) => {
        this.saving.set(false);
        // The exemption refusal is a 403 whose `message` carries the actionable half; `error` is the code
        // `MFA_REQUIRED`, which on its own reads as "you are not allowed" rather than "type your code".
        this.error.set(err.error?.message ?? err.error?.error
          ?? this.transloco.translate('tokens.error.rightsFailed'));
      },
    });
  }
}
