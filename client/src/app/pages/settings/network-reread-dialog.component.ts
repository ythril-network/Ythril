import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { ModalDirective } from '../../shared/modal.directive';
import { PluralPipe } from '../../core/plural.pipe';
import { PluralText } from '../../core/plural-text.service';
import { DIALOG_STYLES } from './dialog.styles';
import { rereadCycles } from './network-reread-estimate';

/**
 * "Re-read everything from peers": the danger dialog of a network-wide re-read, layout B "Estimate first" (bundle-81, design rev 8 section 7,
 * decisions 18, 19, 40-42; mockup `b81-mock-reread/layout-b.html`, green-lit by the owner 2026-10-24).
 *
 * It opens on the spaces and what the choice costs: a checklist with each space's record count, every space ticked, and a live estimate
 * (cycles, and a time when the schedule has an interval) that moves as spaces are ticked. Below it the cost in words (records peers deleted
 * and forgot can come back), the typed confirmation of the network's name, and the note that an MFA code is asked on confirm. The host owns
 * the request: this emits the spaces chosen and shows the refusal the host hands back.
 *
 * Keyboard and focus, on the model of the restore dialog: a modal dialog (`ModalDirective`: role, `aria-modal`, Escape, focus restored to the
 * opener), focus lands in the name field, Tab wraps at both ends, and Enter in the field confirms only when the name matches. The focus ring is
 * drawn here because the app has no global `:focus-visible` rule (decision 41).
 */
@Component({
  selector: 'app-network-reread-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PluralPipe, ModalDirective, PhIconComponent],
  styles: [DIALOG_STYLES, `
    .dialog p { font-size: 13.5px; color: var(--text-secondary); line-height: 1.55; margin: 0 0 12px; }
    fieldset { border: none; margin: 0 0 12px; padding: 0; min-width: 0; }
    legend { font-size: 13px; color: var(--text-muted); margin-bottom: 6px; padding: 0; }
    .pick { max-height: 216px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
    .pick label { display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--border-muted); font-size: 13px; cursor: pointer; min-height: 34px; }
    .pick label:last-child { border-bottom: none; }
    .pick label:hover { background: var(--bg-elevated); }
    .pick .sid { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .pick .n { color: var(--text-muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .estimate { margin: 12px 0; }
    .estimate .big { font-size: 18px; font-weight: 600; line-height: 1.3; }
    .estimate .sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
    .confirm-label { display: block; font-size: 13px; color: var(--text-secondary); margin: 0 0 6px; }
    .name-input { width: 100%; box-sizing: border-box; font-family: var(--font-mono, monospace); margin-bottom: 16px; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    .hint { font-size: 12px; color: var(--text-muted); margin-top: 10px; text-align: right; }
    .btn-danger-solid { background: var(--danger); color: #fff; border-color: var(--danger); }
    .btn-danger-solid:disabled { opacity: .5; cursor: not-allowed; }
    .btn-danger-solid:not(:disabled):hover { opacity: .9; }
    .alert { margin-bottom: 12px; }
    /* The app has no global focus ring, so the dialog draws its own on every control (decision 41). */
    .dialog :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `],
  template: `
    <div class="dialog-backdrop">
      <div class="dialog" [appModal]="'networks.reread.title' | transloco" (dismiss)="closed.emit()" (click)="$event.stopPropagation()"
           aria-labelledby="reread-title" (keydown)="onKeydown($event)" style="--dialog-max-width:520px">
        <div class="dialog-header">
          <h2 id="reread-title" class="card-title" style="margin:0;">{{ 'networks.reread.title' | transloco }}</h2>
          <button type="button" class="icon-btn" [attr.aria-label]="'common.close' | transloco" (click)="closed.emit()"><ph-icon name="x" [size]="14"/></button>
        </div>

        @if (spaces().length === 0) {
          <p>{{ 'networks.reread.noSpaces' | transloco }}</p>
        } @else {
          <fieldset>
            <legend>{{ 'networks.reread.scope.legend' | transloco }}</legend>
            <div class="pick" role="group">
              @for (s of spaces(); track s.id) {
                <label>
                  <input type="checkbox" [checked]="!unpicked().has(s.id)" (change)="toggle(s.id)">
                  <span class="sid">{{ s.id }}</span>
                  <span class="n">{{ s.records | plural:'networks.reread.spaceRecords' }}</span>
                </label>
              }
            </div>
          </fieldset>

          <div class="estimate" aria-live="polite">
            @if (pickedIds().length > 0) {
              <div class="big">{{ cycles() | plural:'networks.reread.cycles' }}@if (minutes() !== null) {<span>, {{ durationText() }}</span>}</div>
              <div class="sub">{{ records() | plural:'networks.reread.picked' }}. {{ (schedule() ? 'networks.reread.estimate' : 'networks.reread.estimateManual') | transloco: { schedule: schedule() } }}</div>
            } @else {
              <div class="big">{{ 'networks.reread.estimateNone' | transloco }}</div>
            }
          </div>
        }

        <div class="alert alert-warning">{{ 'networks.reread.cost' | transloco }}</div>
        @if (alreadyOwed()) {
          <div class="alert alert-info">{{ 'networks.reread.alreadyOwed' | transloco }}</div>
        }
        @if (error()) {
          <div class="alert alert-error" role="alert">{{ error() }}</div>
        }

        <label class="confirm-label" for="reread-typed">{{ 'networks.reread.typeNameToConfirm' | transloco: { name: networkName() } }}</label>
        <input #typed id="reread-typed" class="name-input" type="text" autocomplete="off" spellcheck="false" cdkFocusInitial
               [value]="typedName()" (input)="typedName.set($any($event.target).value)" (keydown.enter)="confirm()">

        <div class="actions">
          <button type="button" class="btn btn-secondary btn-sm" (click)="closed.emit()">{{ 'common.cancel' | transloco }}</button>
          <button type="button" class="btn btn-sm btn-danger-solid" data-confirm [disabled]="!canConfirm()" (click)="confirm()">
            @if (busy()) { <span class="spinner" style="width:12px;height:12px;border-width:2px;"></span> }
            {{ 'networks.reread.confirm' | transloco }}
          </button>
        </div>
        <div class="hint">{{ 'networks.reread.mfa' | transloco }}</div>
      </div>
    </div>
  `,
})
export class NetworkRereadDialogComponent implements AfterViewInit {
  private readonly plural = inject(PluralText);

  /** The name the operator types to confirm: the network's label, matched exactly. */
  readonly networkName = input.required<string>();
  /** The network's spaces and what each holds: the cycles are summed over the ones left ticked. */
  readonly spaces = input<readonly { id: string; records: number }[]>([]);
  /** Minutes between the schedule's runs, or null when the schedule has none to name (manual sync, or a cron this client does not read). */
  readonly cycleMinutes = input<number | null>(null);
  /** The schedule as the network states it, named in the estimate; empty is manual sync. */
  readonly schedule = input('');
  /** Some member still owes a re-read: starting again restarts it for them. */
  readonly alreadyOwed = input(false);
  /** The request is in flight: confirming again is not offered. */
  readonly busy = input(false);
  /** The refusal of the last request, already worded by the host; empty when there is none. */
  readonly error = input('');

  /** The operator confirmed: the spaces to re-read, in the network's order. */
  readonly confirmed = output<{ spaces: string[] }>();
  /** The operator dismissed the dialog (Cancel, the close button or Escape). */
  readonly closed = output<void>();

  protected readonly typedName = signal('');
  /** The spaces taken OUT of the choice: every space is in until unticked, so a space the network gains while this is open is ticked too. */
  protected readonly unpicked = signal<ReadonlySet<string>>(new Set());
  private readonly typedField = viewChild<ElementRef<HTMLInputElement>>('typed');

  protected readonly pickedIds = computed(() => this.spaces().filter(s => !this.unpicked().has(s.id)).map(s => s.id));
  private readonly pickedSpaces = computed(() => this.spaces().filter(s => !this.unpicked().has(s.id)));
  protected readonly cycles = computed(() => rereadCycles(this.pickedSpaces().map(s => s.records)));
  protected readonly records = computed(() => this.pickedSpaces().reduce((n, s) => n + s.records, 0));
  protected readonly minutes = computed(() => { const m = this.cycleMinutes(); return m === null ? null : this.cycles() * m; });
  protected readonly canConfirm = computed(() => !this.busy() && this.pickedIds().length > 0 && this.typedName() === this.networkName());

  ngAfterViewInit(): void {
    // Focus lands where the action needs input, as the restore dialog's type-the-id field does.
    this.typedField()?.nativeElement.focus();
  }

  /** The time the picked spaces take, in minutes below an hour and a half and in hours above it, in the page's language. */
  protected durationText(): string {
    const minutes = this.minutes() ?? 0;
    return minutes < 90
      ? this.plural.text('networks.reread.durationMinutes', minutes)
      : this.plural.text('networks.reread.durationHours', Math.round(minutes / 60));
  }

  protected toggle(id: string): void {
    this.unpicked.update(set => { const next = new Set(set); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  protected confirm(): void {
    if (this.canConfirm()) this.confirmed.emit({ spaces: this.pickedIds() });
  }

  /** Tab wraps inside the dialog at both ends: the backdrop's own trap catches a focus that left it, this keeps it from leaving. */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('input, button, select, textarea, [href], [tabindex]:not([tabindex="-1"])'))
      .filter(item => !(item as HTMLButtonElement).disabled);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    const outside = !dialog.contains(active);
    if (event.shiftKey ? active === first || outside : active === last || outside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }
}
