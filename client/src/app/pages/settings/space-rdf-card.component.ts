/**
 * The space's "RDF names" card on the Settings tab (Q-942, layout D "one list of bases"): the switch, the base and vocabulary addresses with
 * what they mean, a recommendation to use an address that outlives the instance, and on a shared space one list of bases (held, offered by
 * a network, proposed by a vote) with each row's act on its row.
 *
 * The switch and a first base ride the dialog's own Save (`SpaceSettingsState.rdfForm`, sent by `rdfOfForm`); a base, once given out, moves
 * only by the card's two acts, each confirmed and sent alone (`meta.rdf` with `rebase: true`): accepting a base a network offers (it lands
 * here at once, with no vote) and a base change (on a space in no network at once, on a shared space as a `space_rebase` vote).
 *
 * ## What it prevents
 *
 * - **A base moved by accident.** The stored base is shown, never an input; the save sends it back as stored.
 * - **A refusal in the server's English.** Every act's refusal is worded by `rdf-refusal.ts` in the reader's language.
 * - **A button that cannot work.** Accepting and changing a base need the schema `admin` rung on the space: without it the buttons are
 *   disabled and say why; "Propose base change…" is disabled while a vote runs, one base change at a time, and says why.
 * - **A conflict nobody finds.** The card says, once, above the list, what a conflict blocks, and marks the rows that need someone.
 * - **"In no network" said of a space whose networks could not be read.** A token that may not read the networks (or a lost connection) leaves
 *   the list empty; the card then says it could not read them, words the confirm of a base change neutrally, and takes its notice from the
 *   server's answer (a `202 vote_pending` is a vote), never from what it guessed.
 * - **A default base the server will not store.** The address the card names for a switch-on with none typed is the one the server stores,
 *   from the instance's public address (`GET /api/about`), or none is named; never the address of the browser tab.
 * - **A card that takes the focus on every visit.** A link to it brings it into view in the dialog's own scrolling body and focuses it once.
 */
import { ChangeDetectionStrategy, Component, ElementRef, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { firstValueFrom, forkJoin, of, catchError, map } from 'rxjs';
import { SettingsCardComponent } from '../../shared/settings-card.component';
import { StatusPillComponent, type StatusVariant } from '../../shared/status-pill.component';
import { InstantComponent } from '../../shared/instant.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { showAndFocus } from '../../core/scroll-in-container';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { holdsSchemaAdmin } from '../../core/token-capability';
import type { TokenRights } from './rights-glyph.component';
import type { VoteRound } from '../../core/vote-round-view';
import {
  baseLooksValid, defaultBaseOf, rdfBaseRows, rdfIsShared, rdfPillOf, recordAddressExample, vocabOf,
  type NetworkWithRdf, type OfferedRow, type RdfPill,
} from '../../core/rdf-names';
import { rdfRefusalText } from '../../core/rdf-refusal';

const PILL_VARIANT: Readonly<Record<RdfPill, StatusVariant>> = { off: 'off', on: 'active', vote: 'pending', conflict: 'warn' };
/** The base the example address is drawn on while the card knows none (an instance with no public address, nothing typed yet). */
const EXAMPLE_BASE = 'https://example.org/ld/space/';

@Component({
  selector: 'app-space-rdf-card',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslocoPipe, SettingsCardComponent, StatusPillComponent, InstantComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: block; }
    .hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; line-height: 1.45; }
    .check { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 14px; cursor: pointer; }
    .check input { margin-top: 3px; }
    .field { margin-bottom: 12px; }
    .field label { display: block; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 5px; }
    .opt { font-weight: 400; color: var(--text-muted); }
    .bases-h { margin: 4px 0 8px; font-size: 13px; font-weight: 600; }
    .bases { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .base-row { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 11px 12px;
      border-top: 1px solid var(--border); }
    .base-row:first-child { border-top: 0; }
    .base-row.needs { box-shadow: inset 3px 0 0 var(--warning); background: rgba(210, 153, 34, 0.06); }
    .addr { font-family: var(--font-mono, monospace); font-size: 12.5px; overflow-wrap: anywhere; }
    .what { font-size: 12px; color: var(--text-secondary); margin-top: 3px; line-height: 1.45; }
    .tally { display: grid; grid-template-columns: auto minmax(60px, 140px) auto; gap: 4px 10px; align-items: center; margin-top: 8px;
      font-size: 12px; color: var(--text-secondary); }
    .bar { height: 6px; border-radius: 3px; background: var(--bg-elevated, var(--border)); overflow: hidden; }
    .bar i { display: block; height: 100%; background: var(--accent); }
    .derived { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 12px 0 0; font-size: 12.5px; }
    .derived dt { color: var(--text-secondary); }
    .derived dd { margin: 0; font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
    .foot-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
    .reason { font-size: 12px; color: var(--text-muted); }
    .warn-line { color: var(--warning); font-size: 12.5px; margin: 0 0 8px; }
    .change { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-top: 12px; }
    .change .field { flex: 1 1 280px; margin: 0; }
    @media (max-width: 560px) {
      .base-row { grid-template-columns: minmax(0, 1fr); }
      .base-row .act .btn { width: 100%; justify-content: center; }
    }
  `],
  template: `
<app-settings-card icon="link" [heading]="'rdf.card.title' | transloco" [purpose]="'rdf.card.purpose' | transloco" data-testid="rdf-card">
  <app-status-pill pill [variant]="pillVariant()" [dot]="true" data-testid="rdf-pill">{{ 'rdf.card.pill.' + pill() | transloco }}</app-status-pill>
  <h4 class="sr-only" tabindex="-1" #focusTarget id="rdf-card-focus">{{ 'rdf.card.title' | transloco }}</h4>

  @if (notice()) { <div class="alert alert-success" role="status" data-testid="rdf-notice">{{ notice() }}</div> }
  @if (refusal()) { <div class="alert alert-error" role="alert" data-testid="rdf-refusal">{{ refusal() }}</div> }

  <label class="check">
    <input type="checkbox" [(ngModel)]="state.rdfForm.enabled" (ngModelChange)="touched.set(touched() + 1)" aria-describedby="rdf-sw-h" data-testid="rdf-switch" />
    <span><b>{{ 'rdf.card.switch' | transloco }}</b>
      <div class="hint" id="rdf-sw-h">{{ (stored() ? 'rdf.card.switchOffKeeps' : 'rdf.card.switchHint') | transloco }}</div></span>
  </label>

  @if (!stored()) {
    @if (state.rdfForm.enabled) {
      <div class="field">
        <label for="rdf-base">{{ 'rdf.card.base' | transloco }}</label>
        <input id="rdf-base" type="url" [(ngModel)]="state.rdfForm.base" [placeholder]="defaultBase()" aria-describedby="rdf-base-h rdf-base-r" data-testid="rdf-base" />
        <div class="hint" id="rdf-base-h">{{ 'rdf.card.baseHint' | transloco: { example: example() } }}</div>
        @if (state.rdfForm.base.trim() && !baseLooksValid(state.rdfForm.base.trim())) {
          <div class="hint" style="color:var(--error)" data-testid="rdf-base-invalid">{{ 'rdf.card.baseInvalid' | transloco }}</div>
        }
      </div>
      <div class="alert alert-info" id="rdf-base-r" data-testid="rdf-persistent">{{ (defaultBase() ? 'rdf.card.persistent' : 'rdf.card.persistentNoDefault') | transloco: { fallback: defaultBase() } }}</div>
      <div class="field">
        <label for="rdf-vocab">{{ 'rdf.card.vocab' | transloco }} <span class="opt">{{ 'rdf.card.optional' | transloco }}</span></label>
        <input id="rdf-vocab" type="url" [(ngModel)]="state.rdfForm.vocab" [placeholder]="vocabPlaceholder()" aria-describedby="rdf-vocab-h" data-testid="rdf-vocab" />
        <div class="hint" id="rdf-vocab-h">{{ 'rdf.card.vocabHint' | transloco }}</div>
      </div>
    }
  } @else {
    @if (networksFailed()) { <p class="warn-line" role="status" data-testid="rdf-networks-unread">{{ 'rdf.card.networksUnread' | transloco }}</p> }
    <h4 class="bases-h" id="rdf-bases-h">{{ 'rdf.card.base' | transloco }}</h4>
    @if (offered().length) { <p class="warn-line" data-testid="rdf-conflict-line">{{ 'rdf.card.conflictBlocks' | transloco }}</p> }
    <div class="bases" role="list" aria-labelledby="rdf-bases-h">
      @for (row of rows(); track row.kind + row.base) {
        @switch (row.kind) {
          @case ('held') {
            <div class="base-row" role="listitem" data-testid="rdf-row-held">
              <div><app-status-pill variant="active" [dot]="true">{{ 'rdf.card.row.held' | transloco }}</app-status-pill></div>
              <div><div class="addr">{{ row.base }}</div><div class="what">{{ 'rdf.card.row.heldWhat' | transloco }}</div></div>
              <div class="act"></div>
            </div>
          }
          @case ('offered') {
            <div class="base-row needs" role="listitem" data-testid="rdf-row-offered">
              <div><app-status-pill variant="warn" [dot]="true">{{ 'rdf.card.row.offered' | transloco }}</app-status-pill></div>
              <div><div class="addr">{{ row.base }}</div><div class="what">{{ offeredWho(row) }}</div></div>
              <div class="act">
                <button class="btn btn-secondary btn-sm" type="button" data-testid="rdf-accept" [disabled]="!canAdmin() || busy()"
                  [attr.aria-describedby]="canAdmin() ? null : 'rdf-admin-r'" [attr.aria-label]="'rdf.card.acceptAria' | transloco: { who: row.members.join(', ') || row.networkLabel }"
                  (click)="accept(row)">{{ 'rdf.card.accept' | transloco }}</button>
              </div>
            </div>
          }
          @case ('vote') {
            <div class="base-row" role="listitem" data-testid="rdf-row-vote">
              <div><app-status-pill variant="pending" [dot]="true">{{ 'rdf.card.row.vote' | transloco }}</app-status-pill></div>
              <div><div class="addr">{{ row.base }}</div>
                <div class="what">{{ 'rdf.card.row.voteWhat' | transloco }} <app-instant [value]="row.deadline" variant="datetime"/></div>
                <div class="tally" [attr.aria-label]="'rdf.card.tally' | transloco">
                  @for (t of row.tallies; track t.networkId) {
                    <span>{{ t.networkLabel }}</span>
                    <span class="bar" role="img" [attr.aria-label]="'rdf.card.yesOf' | transloco: { yes: t.yes, of: t.of }"><i [style.width.%]="t.of ? (t.yes / t.of) * 100 : 0"></i></span>
                    <span>{{ 'rdf.card.yesOf' | transloco: { yes: t.yes, of: t.of } }}</span>
                  }
                </div>
              </div>
              <div class="act"><a class="btn btn-secondary btn-sm" routerLink="/settings/networks" data-testid="rdf-vote-link">{{ 'rdf.card.voteLink' | transloco }}</a></div>
            </div>
          }
        }
      }
    </div>
    @if (offered().length) { <p class="hint" style="margin-top:8px">{{ 'rdf.card.acceptHint' | transloco }}</p> }
    <dl class="derived"><dt>{{ 'rdf.card.vocab' | transloco }}</dt><dd data-testid="rdf-vocab-derived">{{ vocab() }}</dd></dl>

    @if (changing()) {
      <div class="change">
        <div class="field"><label for="rdf-new-base">{{ 'rdf.card.newBase' | transloco }}</label>
          <input id="rdf-new-base" type="url" [(ngModel)]="newBase" data-testid="rdf-new-base" /></div>
        <button class="btn btn-primary btn-sm" type="button" data-testid="rdf-change-go" [disabled]="busy() || !baseLooksValid(newBase.trim())" (click)="changeBase()">{{ (shared() ? 'rdf.card.proposeGo' : 'rdf.card.changeGo') | transloco }}</button>
        <button class="btn btn-secondary btn-sm" type="button" (click)="changing.set(false)">{{ 'common.cancel' | transloco }}</button>
      </div>
    } @else {
      <div class="foot-row">
        <button class="btn btn-secondary btn-sm" type="button" data-testid="rdf-change" [disabled]="!canAdmin() || voteOpen() || busy()"
          [attr.aria-describedby]="changeReasonId" (click)="changing.set(true)">{{ (shared() ? 'rdf.card.propose' : 'rdf.card.change') | transloco }}</button>
        <span class="reason" [id]="changeReasonId" data-testid="rdf-change-reason">{{ changeReason() | transloco }}</span>
      </div>
    }
    @if (!canAdmin()) { <p class="hint" id="rdf-admin-r" data-testid="rdf-admin-only">{{ 'rdf.card.adminOnly' | transloco }}</p> }
  }
</app-settings-card>
  `,
})
export class SpaceRdfCardComponent {
  readonly state = inject(SpaceSettingsState);
  private readonly spacesApi = inject(SpacesApi);
  private readonly networksApi = inject(NetworksApi);
  /** The page's list of networks, read once for every screen that shows a network's doing; the card asks it to read again. */
  private readonly store = inject(SpacesStore);
  private readonly injector = inject(Injector);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly transloco = inject(TranslocoService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly baseLooksValid = baseLooksValid;
  /** Bumped by the switch: the form is a plain object, so the computeds that read it are told it moved. */
  readonly touched = signal(0);
  readonly networks = computed(() => this.store.networks() as NetworkWithRdf[]);
  /** The last read of the networks failed: a conflict or a vote may exist that the card cannot show, and "in no network" is not known. */
  readonly networksFailed = this.store.networksFailed;
  /** The instance's public address as `GET /api/about` says it; '' when the instance has none set (or the page cannot read it). */
  readonly publicUrl = signal('');
  readonly rounds = signal<VoteRound[]>([]);
  private readonly rights = signal<TokenRights | null>(null);
  readonly busy = signal(false);
  readonly changing = signal(false);
  readonly notice = signal('');
  readonly refusal = signal('');
  newBase = '';

  private readonly spaceId = computed(() => this.state.settingsSpace()?.id ?? '');
  /** Bumped after an act, so the stored setting is read again. */
  private readonly storedTick = signal(0);
  readonly stored = computed(() => { this.storedTick(); this.touched(); return this.state.rdfStored?.base ? this.state.rdfStored : undefined; });
  readonly rows = computed(() => rdfBaseRows(this.stored(), this.networks(), this.rounds(), this.spaceId()));
  readonly offered = computed(() => this.rows().filter((r): r is OfferedRow => r.kind === 'offered'));
  readonly voteOpen = computed(() => this.rows().some(r => r.kind === 'vote'));
  readonly shared = computed(() => rdfIsShared(this.networks(), this.spaceId()));
  readonly pill = computed(() => { this.touched(); return rdfPillOf(this.stored() ? { ...this.stored()!, enabled: this.state.rdfForm.enabled } : undefined, this.rows()); });
  readonly pillVariant = computed(() => PILL_VARIANT[this.pill()]);
  readonly vocab = computed(() => vocabOf(this.stored()));
  readonly canAdmin = computed(() => holdsSchemaAdmin(this.rights(), this.spaceId()));
  /**
   * The base the server will store for a switch-on with none typed: the instance's public address, `/ld/` and the space id
   * (`defaultBaseFor` on the server). '' when the instance sets no public address: the server then refuses an empty base, and the card
   * names no address, never the address of the browser tab (which the server never uses).
   */
  readonly defaultBase = computed(() => (this.publicUrl() && this.spaceId() ? defaultBaseOf(this.publicUrl(), this.spaceId()) : ''));
  readonly example = computed(() => { this.touched(); return recordAddressExample(this.state.rdfForm.base.trim() || this.defaultBase() || EXAMPLE_BASE); });
  readonly vocabPlaceholder = computed(() => { this.touched(); const base = this.state.rdfForm.base.trim() || this.defaultBase(); return base ? `${base}vocab/` : ''; });
  readonly changeReasonId = 'rdf-change-r';
  readonly changeReason = computed(() => this.voteOpen() ? 'rdf.card.oneAtATime' : this.networksFailed() ? 'rdf.card.changeWhatUnknown' : this.shared() ? 'rdf.card.proposeWhat' : 'rdf.card.changeWhat');

  constructor() {
    // The rights and the public address are read through the injector: a host without them (a test of the tab around the card) draws the acts
    // disabled and names no default address.
    let auth: AuthApi | null = null;
    try { auth = this.injector.get(AuthApi); } catch { auth = null; }
    auth?.verifyToken().subscribe({ next: me => this.rights.set(me.rights ?? null), error: () => this.rights.set(null) });
    let admin: AdminApi | null = null;
    try { admin = this.injector.get(AdminApi); } catch { admin = null; }
    if (typeof admin?.getAbout === 'function') admin.getAbout().subscribe({ next: about => this.publicUrl.set(about?.publicUrl ?? ''), error: () => this.publicUrl.set('') });
    // A space shown: read the networks again (the store holds them) ...
    effect(() => {
      const id = this.spaceId();
      untracked(() => { if (id) this.store.refreshNetworks(); });
    });
    // ... and, whenever they change, the open rounds of those that carry it.
    effect(() => {
      const id = this.spaceId();
      const nets = this.networks();
      untracked(() => this.loadRounds(id, nets));
    });
    // A link to the card (the Schema tab's, the Overview's) brings it into view in the container that scrolls and gives it focus, once: the
    // signal is set back, as the tab is built again on every visit and a raised signal would take the focus each time.
    effect(() => {
      if (this.state.rdfFocus() === 0) return;
      untracked(() => queueMicrotask(() => {
        const host = this.host.nativeElement as HTMLElement;
        showAndFocus(host, host.querySelector<HTMLElement>('#rdf-card-focus') ?? host);
        this.state.rdfFocus.set(0);
      }));
    });
  }

  /** The open rounds of the networks of `nets` that carry space `id`. */
  private loadRounds(id: string, nets: readonly NetworkWithRdf[]): void {
    // A host whose network service reads no votes (a stand-in in a test of the dialog) shows no round.
    const carrying = nets.filter(n => n.spaces.includes(id));
    if (!id || !carrying.length || typeof this.networksApi.listVotes !== 'function') { this.rounds.set([]); return; }
    forkJoin(carrying.map(n => this.networksApi.listVotes(n.id).pipe(map(r => r.rounds), catchError(() => of([] as VoteRound[])))))
      .subscribe(all => { if (id === this.spaceId()) this.rounds.set(all.flat()); });
  }

  offeredWho(row: OfferedRow): string {
    return row.members.length
      ? this.transloco.translate('rdf.card.row.offeredBy', { members: row.members.join(', '), network: row.networkLabel })
      : this.transloco.translate('rdf.card.row.offeredByNetwork', { network: row.networkLabel });
  }

  /** Take the offered base here at once, with no vote, after the reader confirmed it. */
  async accept(row: OfferedRow): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate('rdf.card.acceptTitle'),
      message: this.transloco.translate('rdf.card.acceptConfirm', { base: row.base }),
      confirmLabel: this.transloco.translate('rdf.card.acceptGo'),
      danger: true,
    });
    if (!ok) return;
    await this.rebase(row.base, row.vocab, 'rdf.card.accepted');
  }

  /** Change the base: at once on a space in no network, as a vote on a shared one. */
  async changeBase(): Promise<void> {
    const base = this.newBase.trim();
    if (!baseLooksValid(base)) return;
    // When the networks could not be read the card cannot say which it is, and the confirm says both, never "at once" for a vote.
    const unknown = this.networksFailed();
    const vote = !unknown && this.shared();
    const ok = await this.confirmDialog.confirm({
      title: this.transloco.translate(vote ? 'rdf.card.proposeTitle' : 'rdf.card.changeTitle'),
      message: this.transloco.translate(unknown ? 'rdf.card.changeConfirmUnknown' : vote ? 'rdf.card.proposeConfirm' : 'rdf.card.changeConfirm', { base }),
      confirmLabel: this.transloco.translate(vote ? 'rdf.card.proposeGo' : 'rdf.card.changeGo'),
      danger: true,
    });
    if (!ok) return;
    await this.rebase(base, undefined, 'rdf.card.changed');
  }

  /**
   * `meta.rdf` with `rebase: true`, sent alone, as the server asks of a base change. The notice is the server's answer: a `202 vote_pending`
   * is a vote that opened, whatever the card believed of the networks; `doneKey` says what a 200 did.
   */
  private async rebase(base: string, vocab: string | undefined, doneKey: string): Promise<void> {
    const id = this.spaceId();
    this.busy.set(true);
    this.notice.set('');
    this.refusal.set('');
    try {
      const answer = await firstValueFrom(this.spacesApi.updateSpace(id, { meta: { rdf: { enabled: true, base, ...(vocab ? { vocab } : {}), rebase: true } } }));
      const rdf = answer.space?.meta?.rdf;
      if (rdf) { this.state.rdfStored = { ...rdf }; this.state.rdfForm = { enabled: rdf.enabled, base: rdf.base ?? '', vocab: rdf.vocab ?? '' }; }
      this.storedTick.update(n => n + 1);
      this.changing.set(false);
      this.newBase = '';
      this.notice.set(this.transloco.translate(answer.status === 'vote_pending' ? 'rdf.card.voteOpened' : doneKey));
      this.store.refreshNetworks();
    } catch (err) {
      this.refusal.set(rdfRefusalText(this.transloco, err));
    } finally {
      this.busy.set(false);
    }
  }
}
