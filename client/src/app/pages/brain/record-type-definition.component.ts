import { ChangeDetectionStrategy, Component, DestroyRef, Injectable, OnChanges, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import { SchemaApi, typeHistoryFailure } from '../../core/schema-api.service';
import { DateFormatService } from '../../core/date-format.service';
import { typeReadReason } from '../../core/type-definition-words';
import type { TypedKind } from '../../core/type-field';
import { HelpToggleComponent } from '../../shared/help-toggle.component';
import { BRAIN_DRAWER_STYLES } from './brain-form.styles';

/**
 * Whether this session may read the standings at all. A 403 says the token cannot read the schema; every later row would be refused
 * the same, so the first one is remembered and the row is not shown again (r4 §7.7, "without the right to read the schema, the row is
 * not shown"). Root-provided: the session's, not one drawer's.
 */
@Injectable({ providedIn: 'root' })
export class TypeDefinitionAccess {
  readonly refused = signal(false);
}

type RowState =
  | { s: 'hidden' }
  | { s: 'none' }
  | { s: 'checking' }
  | { s: 'current' }
  | { s: 'older'; since: string; rep: string }
  | { s: 'cannotTell' }
  | { s: 'failed'; reason: string };

/**
 * The drawer's "Type definition" row (Q-744, design r4 §7.7): which definition of its type the record was last saved under, read for
 * its one stamp through the `fps` form (r4 §5.3).
 *
 * - No stamp: "No version", read from the record itself; nothing is asked.
 * - `current`: Current. `older`: "Older (from {since})" with Compare, which emits the definition's rep for the host to open the history on.
 * - `notHeld`, `unclassified` and any standing this client does not know: Cannot tell.
 * - Checking while the read is out; a failure says why, with Check again. A 403 hides the row for the session; an older server (no
 *   echo) hides it too, since it cannot answer.
 */
@Component({
  selector: 'app-record-type-definition',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, HelpToggleComponent],
  styles: [BRAIN_DRAWER_STYLES, `
    :host { display: block; }
    .tdrow { display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; }
    .tdrow .brk { flex-basis: 100%; height: 0; }
    .tdrow .drawer-label { margin-bottom: 0; }
    .lnk { border: 0; background: none; padding: 0 0 0 6px; color: var(--accent); cursor: pointer; font: inherit; }
    .err { color: var(--error); }
    .muted { color: var(--text-muted); }
  `],
  template: `
@if (row().s !== 'hidden') {
  <div class="drawer-field tdrow" data-testid="type-definition-row">
    <div class="drawer-label">{{ 'brain.drawer.typeDefinition.label' | transloco }}</div>
    <app-help-toggle label="brain.drawer.typeDefinition.helpAria">
      <p>{{ 'brain.drawer.typeDefinition.help.current' | transloco }}</p>
      <p>{{ 'brain.drawer.typeDefinition.help.older' | transloco }}</p>
      <p>{{ 'brain.drawer.typeDefinition.help.none' | transloco }}</p>
      <p>{{ 'brain.drawer.typeDefinition.help.cannotTell' | transloco }}</p>
    </app-help-toggle>
    <span class="brk"></span>
    <div class="drawer-readonly-value">
      @switch (row().s) {
        @case ('none') { {{ 'brain.drawer.typeDefinition.none' | transloco }} }
        @case ('checking') { <span class="muted">{{ 'brain.drawer.typeDefinition.checking' | transloco }}</span> }
        @case ('current') { {{ 'brain.drawer.typeDefinition.current' | transloco }} }
        @case ('cannotTell') { {{ 'brain.drawer.typeDefinition.cannotTell' | transloco }} }
        @case ('older') {
          {{ 'brain.drawer.typeDefinition.older' | transloco: { since: olderSince() } }}
          <button class="lnk" type="button" data-testid="type-definition-compare" (click)="compareOlder()">{{ 'brain.drawer.typeDefinition.compare' | transloco }}</button>
        }
        @case ('failed') {
          <span class="err">{{ 'brain.drawer.typeDefinition.failed' | transloco: { reason: failedReason() } }}</span>
          <button class="lnk" type="button" data-testid="type-definition-check-again" (click)="check()">{{ 'brain.drawer.typeDefinition.checkAgain' | transloco }}</button>
        }
      }
    </div>
  </div>
}
  `,
})
export class RecordTypeDefinitionComponent implements OnChanges {
  readonly spaceId = input.required<string>();
  readonly kind = input.required<TypedKind>();
  /** The record's type name; a record without one has no definition to stand on, and the row is not shown. */
  readonly type = input<string | undefined>(undefined);
  /** The record's `schemaFingerprint`; absent for a record with no stamp. */
  readonly fp = input<string | undefined>(undefined);
  /** Compare: the rep of the record's definition, for the host to open the history with it chosen. */
  readonly compare = output<string>();

  private readonly api = inject(SchemaApi);
  private readonly dates = inject(DateFormatService);
  private readonly transloco = inject(TranslocoService);
  private readonly access = inject(TypeDefinitionAccess);
  private readonly destroyRef = inject(DestroyRef);
  private reading?: Subscription;

  protected readonly row = signal<RowState>({ s: 'hidden' });

  ngOnChanges(): void { this.check(); }

  protected check(): void {
    this.reading?.unsubscribe();
    const fp = this.fp(), type = this.type();
    if (this.access.refused() || !type) { this.row.set({ s: 'hidden' }); return; }
    if (!fp) { this.row.set({ s: 'none' }); return; }
    this.row.set({ s: 'checking' });
    this.reading = this.api.typeStandings(this.spaceId(), this.kind(), type, [fp]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: r => {
        if (!r.supported) { this.row.set({ s: 'hidden' }); return; }
        const mine = r.answer.standings.find(s => s.fp === fp);
        if (mine?.standing === 'current') this.row.set({ s: 'current' });
        else if (mine?.standing === 'older' && mine.definition) this.row.set({ s: 'older', since: mine.definition.since ?? '', rep: mine.definition.rep });
        else this.row.set({ s: 'cannotTell' });
      },
      error: err => {
        const failure = typeHistoryFailure(err);
        if (failure.reason === 'forbidden') { this.access.refused.set(true); this.row.set({ s: 'hidden' }); return; }
        this.row.set({ s: 'failed', reason: typeReadReason(failure, this.transloco) });
      },
    });
  }

  protected olderSince(): string {
    const r = this.row();
    return r.s === 'older' && r.since ? this.dates.format(r.since, 'date') : '';
  }

  protected failedReason(): string {
    const r = this.row();
    return r.s === 'failed' ? r.reason : '';
  }

  protected compareOlder(): void {
    const r = this.row();
    if (r.s === 'older') this.compare.emit(r.rep);
  }
}
