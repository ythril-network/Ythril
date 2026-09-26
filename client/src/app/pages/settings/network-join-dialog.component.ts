import { Component, inject, signal, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Space } from '../../core/api.types';
import { decodeInviteCode, looksLikeInviteCode } from '../../core/invite-code';
import { NetworksApi } from '../../core/networks-api.service';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';

/**
 * Join-network dialog, extracted from the (large) NetworksComponent (PR-U3). Owns the invite-bundle
 * textarea, the bundle validation (JSON / required fields / this brain's URL), the space-id
 * **space mapping** step — every invited space gets a target: its own name here, an existing local space, or a new
 * name (F-38.2) — and the `joinRemote` call.
 *
 * `myUrl` is a one-way input: the host computes this brain's own URL (used to gate the enable-networks
 * flow) and passes it in; the join dialog never lets the user edit it, it only needs it to submit. On a
 * successful join the dialog shows its result message and emits `joined` so the host reloads the network
 * list and refreshes its spaces (a join can create new local spaces). Behaviour matches the inline
 * version; the join characterization tests moved here with it.
 */
@Component({
  selector: 'app-network-join-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, ModalDirective],
  styles: [`
    .dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--bg-scrim);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .dialog {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: 90%;
      max-width: 600px;
      max-height: 90vh;
      overflow-y: auto;
    }
    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" [appModal]="'networks.dialog.join.title' | transloco" (dismiss)="close.emit()" (click)="$event.stopPropagation()">
        <div class="dialog-header">
          <div class="card-title">{{ 'networks.dialog.join.title' | transloco }}</div>
          <button class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="close.emit()"><ph-icon name="x" [size]="14"/></button>
        </div>

        @if (joinError()) { <div class="alert alert-error">{{ joinError() }}</div> }
        @if (joinSuccess()) { <div class="alert alert-success">{{ joinSuccess() }}</div> }

        <div class="field">
          <label>{{ 'networks.dialog.join.bundleLabel' | transloco }}</label>
          <textarea
            [(ngModel)]="joinBundle"
            name="joinBundle"
            rows="5"
            [placeholder]="'networks.dialog.join.bundlePlaceholder' | transloco"
            [attr.aria-label]="'networks.dialog.join.bundleAriaLabel' | transloco"
            style="font-family:var(--font-mono); font-size:12px; resize:vertical;"
          ></textarea>
        </div>
        @if (isPublishedKey()) {
          <!-- F-41: a pub/sub's published key joins with the publisher's URL alone, no admission. -->
          <div class="field">
            <label>{{ 'networks.dialog.join.publisherUrlLabel' | transloco }}</label>
            <input type="url" [(ngModel)]="publisherUrl" name="publisherUrl"
                   [placeholder]="'networks.dialog.join.publisherUrlPlaceholder' | transloco"
                   [attr.aria-label]="'networks.dialog.join.publisherUrlLabel' | transloco" />
            <p style="font-size:12px; color:var(--text-muted); margin:4px 0 0;">{{ 'networks.dialog.join.publishedKeyHint' | transloco }}</p>
          </div>
        }

        @if (joinMapSpaces().length > 0) {
          <div style="margin:0 0 12px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-elevated);">
            <div style="font-weight:600; font-size:13px; margin-bottom:8px;">{{ 'networks.dialog.join.mapping.title' | transloco }}</div>
            <!-- F-38.2: mapping is additive, and the operator is told so beside the choice (owner 2026-09-25). -->
            <p style="font-size:12px; color:var(--text-muted); margin:0 0 12px;">{{ 'networks.dialog.join.mapping.additive' | transloco }}</p>
            @for (remoteId of joinMapSpaces(); track remoteId) {
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
                <span class="badge badge-gray mono" style="min-width:80px;">{{ remoteId }}</span>
                <select
                  [ngModel]="joinSpaceActions[remoteId]"
                  (ngModelChange)="onCollisionActionChange(remoteId, $event)"
                  [name]="'target-' + remoteId"
                  [attr.aria-label]="'networks.dialog.join.mapping.targetAriaLabel' | transloco: { remoteId }"
                  style="width:210px;"
                >
                  <option value="merge">{{ (existsLocally(remoteId) ? 'networks.dialog.join.mapping.sameMerge' : 'networks.dialog.join.mapping.sameCreate') | transloco: { remoteId } }}</option>
                  <option value="mapToExisting">{{ 'networks.dialog.join.mapping.mapToExisting' | transloco }}</option>
                  <option value="alias">{{ 'networks.dialog.join.mapping.newName' | transloco }}</option>
                </select>
                @if (joinSpaceActions[remoteId] === 'mapToExisting') {
                  <select
                    [(ngModel)]="joinSpaceTargets[remoteId]"
                    [name]="'existing-' + remoteId"
                    [attr.aria-label]="'networks.dialog.join.mapping.existingAriaLabel' | transloco: { remoteId }"
                    style="width:160px;"
                  >
                    <option value="">{{ 'networks.dialog.join.mapping.pickSpace' | transloco }}</option>
                    @for (s of availableSpaces(); track s.id) {
                      <option [value]="s.id">{{ s.label || s.id }}</option>
                    }
                  </select>
                }
                @if (joinSpaceActions[remoteId] === 'alias') {
                  <input
                    type="text"
                    [(ngModel)]="joinSpaceAliases[remoteId]"
                    [name]="'alias-' + remoteId"
                    [placeholder]="'networks.dialog.join.aliasPlaceholder' | transloco"
                    [attr.aria-label]="'networks.dialog.join.mapping.newNameAriaLabel' | transloco: { remoteId }"
                    pattern="[a-z0-9-]+"
                    maxlength="40"
                    style="width:160px; padding:4px 8px; font-size:12px;"
                    required
                  />
                }
              </div>
            }
          </div>
        }

        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn-secondary btn" type="button" (click)="close.emit()">{{ 'common.cancel' | transloco }}</button>
          <button
            class="btn-primary btn"
            (click)="joinMapSpaces().length > 0 ? confirmJoin() : joinNetwork()"
            [disabled]="joining() || !joinBundle.trim() || !myUrl().trim() || (isPublishedKey() && !publisherUrl.trim())"
          >
            @if (joining()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            {{ joinMapSpaces().length > 0 ? ('networks.dialog.join.confirmJoinButton' | transloco) : ('networks.dialog.join.submitButton' | transloco) }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class NetworkJoinDialogComponent {
  private networksApi = inject(NetworksApi);
  private transloco = inject(TranslocoService);

  /** Local spaces (for collision detection). */
  readonly availableSpaces = input<Space[]>([]);
  /** This brain's own URL, computed by the host — used to submit the join (never edited here). */
  readonly myUrl = input('');

  /** Emitted after a successful join so the host reloads networks and refreshes its spaces list. */
  readonly joined = output<void>();
  /** Emitted when the user cancels/dismisses. */
  readonly close = output<void>();

  joinBundle = '';
  joining = signal(false);
  joinError = signal('');
  joinSuccess = signal('');
  /** Every space the invite carries, each waiting for a target (F-38.2) — not only the ones whose id collides. */
  joinMapSpaces = signal<string[]>([]);
  /** Per invited space: `merge` keeps its id (into the local space of that name, or a new one), `alias` creates it
   *  under a new id, `mapToExisting` lands it on a local space the operator picks. */
  joinSpaceActions: Record<string, 'merge' | 'alias' | 'mapToExisting'> = {};
  joinSpaceAliases: Record<string, string> = {};
  joinSpaceTargets: Record<string, string> = {};
  private joinParsedBundle: any = null;
  /** The publisher's base URL, asked for when a pub/sub's published invite key is pasted (F-41). */
  publisherUrl = '';
  /** A published pub/sub key rather than a handshake invite: it joins by key, with no mapping step. */
  isPublishedKey(): boolean { return this.joinBundle.trim().startsWith('ythril_invite_'); }

  joinNetwork(): void {
    this.joinError.set('');
    this.joinSuccess.set('');
    this.joinMapSpaces.set([]);
    if (this.isPublishedKey()) {
      if (!this.myUrl().trim()) { this.joinError.set(this.transloco.translate('networks.dialog.join.error.missingMyUrl')); return; }
      this.joining.set(true);
      this.networksApi.joinByKey({ publisherUrl: this.publisherUrl.trim(), inviteKey: this.joinBundle.trim(), myUrl: this.myUrl().trim() })
        .subscribe({ next: (result) => this.onJoined(result), error: (err) => this.onJoinFailed(err) });
      return;
    }
    /*
     * TWO input shapes, and which one it is decided by what the text STARTS with rather than by trying
     * both and seeing what sticks.
     *
     * `ythril1_...` is the one-line invite code, which is what an operator is handed now. The JSON bundle
     * is what older instances produce and what people already have in flight, so it keeps working -- an
     * invite generated before the upgrade must not become unusable by upgrading the joiner.
     *
     * The two failures need different messages: a mistyped code and a truncated JSON blob are different
     * mistakes, and "invalid JSON" for a pasted code is the message that sends someone looking in the
     * wrong place.
     */
    let bundle: any;
    if (looksLikeInviteCode(this.joinBundle)) {
      bundle = decodeInviteCode(this.joinBundle);
      if (!bundle) {
        this.joinError.set(this.transloco.translate('networks.dialog.join.error.invalidCode'));
        return;
      }
    } else {
      try {
        bundle = JSON.parse(this.joinBundle);
      } catch {
        this.joinError.set(this.transloco.translate('networks.dialog.join.error.invalidJson'));
        return;
      }
      if (!bundle.handshakeId || !bundle.inviteUrl || !bundle.rsaPublicKeyPem || !bundle.networkId) {
        this.joinError.set(this.transloco.translate('networks.dialog.join.error.incompleteBundle'));
        return;
      }
    }
    if (!this.myUrl().trim()) {
      this.joinError.set(this.transloco.translate('networks.dialog.join.error.missingMyUrl'));
      return;
    }

    // Every invited space gets a target before the join runs (F-38.2): the same name here, an existing local space,
    // or a new name. Holding here also shows the operator, once, what the join will touch.
    if (bundle.spaces?.length) {
      this.joinParsedBundle = bundle;
      this.joinSpaceActions = {};
      this.joinSpaceAliases = {};
      this.joinSpaceTargets = {};
      for (const id of bundle.spaces as string[]) {
        this.joinSpaceActions[id] = 'merge';
        this.joinSpaceAliases[id] = '';
        this.joinSpaceTargets[id] = '';
      }
      this.joinMapSpaces.set(bundle.spaces as string[]);
      return; // wait for the operator to confirm the targets
    }

    this.joinParsedBundle = bundle;
    this.executeJoin();
  }

  onCollisionActionChange(remoteId: string, action: 'merge' | 'alias' | 'mapToExisting'): void {
    this.joinSpaceActions[remoteId] = action;
    if (action === 'alias' && !this.joinSpaceAliases[remoteId]) {
      this.joinSpaceAliases[remoteId] = remoteId + '-local';
    }
  }

  /** Whether this instance already holds a space with the invited id — what "same name" then means. */
  existsLocally(remoteId: string): boolean {
    return this.availableSpaces().some(s => s.id === remoteId);
  }

  confirmJoin(): void {
    const localIds = new Set(this.availableSpaces().map(s => s.id));
    for (const remoteId of this.joinMapSpaces()) {
      const action = this.joinSpaceActions[remoteId];
      if (action === 'alias') {
        const alias = this.joinSpaceAliases[remoteId]?.trim();
        if (!alias) {
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasRequired', { remoteId }));
          return;
        }
        if (!/^[a-z0-9-]+$/.test(alias)) {
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasInvalid', { alias }));
          return;
        }
        if (localIds.has(alias)) {
          this.joinError.set(this.transloco.translate('networks.dialog.join.error.aliasExists', { alias }));
          return;
        }
      }
      if (action === 'mapToExisting' && !localIds.has(this.joinSpaceTargets[remoteId] ?? '')) {
        this.joinError.set(this.transloco.translate('networks.dialog.join.error.pickExisting', { remoteId }));
        return;
      }
    }
    this.executeJoin();
  }

  private executeJoin(): void {
    const bundle = this.joinParsedBundle;
    if (!bundle) return;

    // Build spaceMap from the operator's targets
    const spaceMap: Record<string, string> = {};
    for (const remoteId of this.joinMapSpaces()) {
      const action = this.joinSpaceActions[remoteId];
      if (action === 'alias') spaceMap[remoteId] = this.joinSpaceAliases[remoteId].trim();
      // Onto an existing local space: the same kind of entry, naming a space that already exists — join-remote merges.
      if (action === 'mapToExisting' && this.joinSpaceTargets[remoteId] !== remoteId) spaceMap[remoteId] = this.joinSpaceTargets[remoteId];
    }

    this.joining.set(true);
    this.networksApi.joinRemote({
      handshakeId: bundle.handshakeId,
      inviteUrl:   bundle.inviteUrl,
      rsaPublicKeyPem: bundle.rsaPublicKeyPem,
      networkId:   bundle.networkId,
      myUrl:       this.myUrl().trim(),
      expiresAt:   bundle.expiresAt,
      ...(Object.keys(spaceMap).length > 0 ? { spaceMap } : {}),
    }).subscribe({ next: (result) => this.onJoined(result), error: (err) => this.onJoinFailed(err) });
  }

  /** One outcome for both joins, by handshake invite and by published key. */
  private onJoined(result: { status: string; networkLabel: string; createdSpaces?: string[]; existingSpaces?: string[]; spaceMap?: Record<string, string> }): void {
    this.joining.set(false);
    // Vote-governed networks hold the join in a vote round on the inviter's
    // side; sync begins once the members/ancestors approve.
    const successKey = result.status === 'vote_pending'
      ? 'networks.dialog.join.success.votePending'
      : 'networks.dialog.join.success.joined';
    let msg = this.transloco.translate(successKey, { networkLabel: result.networkLabel });
    if (result.createdSpaces?.length) {
      msg += ` ${this.transloco.translate('networks.dialog.join.success.createdSpaces', { spaces: result.createdSpaces.join(', ') })}`;
    }
    if (result.existingSpaces?.length) {
      msg += ` ${this.transloco.translate('networks.dialog.join.success.existingSpaces', { spaces: result.existingSpaces.join(', ') })}`;
    }
    if (result.spaceMap && Object.keys(result.spaceMap).length > 0) {
      const aliases = Object.entries(result.spaceMap).map(([r, l]) => `${r} → ${l}`).join(', ');
      msg += ` ${this.transloco.translate('networks.dialog.join.success.aliases', { aliases })}`;
    }
    this.joinSuccess.set(msg);
    this.joinBundle = '';
    this.joinParsedBundle = null;
    this.joinMapSpaces.set([]);
    this.joinSpaceActions = {};
    this.joinSpaceAliases = {};
    this.publisherUrl = '';
    this.joined.emit(); // host reloads networks + refreshes spaces (a join can create local spaces)
  }

  private onJoinFailed(err: { error?: { error?: string } }): void {
    this.joining.set(false);
    this.joinError.set(err.error?.error ?? this.transloco.translate('networks.error.joinFailed'));
  }
}
