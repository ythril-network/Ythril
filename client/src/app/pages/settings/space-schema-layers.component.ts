import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { SchemaApi, type SchemaLayersView } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';

type Clash = SchemaLayersView['clashes'][number];
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * The meta patch that gives `target` the definition that applies now — the clash's first value (F-39.5).
 *
 * A named type is replaced WHOLE by a schema merge, so the patch carries the target layer's own definition of the
 * type with the one clashing part swapped in. Sending the part alone would drop the rest of that network's type.
 */
export function proposalFor(c: Clash, targetLayer: Record<string, unknown>): Record<string, unknown> {
  const winning = c.values[0]?.value;
  if (c.field) return { [c.field]: winning };
  const own = obj(obj(obj(targetLayer['typeSchemas'])[c.kind!])[c.type!]);
  const def = c.property
    ? { ...own, propertySchemas: { ...obj(own['propertySchemas']), [c.property]: winning } }
    : { ...own, [c.typeField!]: winning };
  return { typeSchemas: { [c.kind!]: { [c.type!]: def } } };
}

/**
 * Where a space's schema comes from once networks send it (`F-39.3`): each network's layer in the order it applies,
 * the clashes between them, and up/down to change which network wins.
 *
 * Shown only when the space HAS a network layer — a space in no schema-sending network has nothing to show, and an
 * empty panel would suggest something is missing. Its own component because the schema tab is on the god-file
 * ratchet. The rule it presents is F-39.2's: the network first in the list wins a clash, and a clash never stops
 * either network's records. A clash can be settled by proposing the winning definition to a network that holds
 * another (F-39.5) — a vote on that network, never a direct write.
 */
@Component({
  selector: 'app-space-schema-layers',
  standalone: true,
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as v) {
      @if (v.layers.length) {
        <div style="margin:12px 0; padding:10px 12px; border:1px solid var(--border-muted); border-radius:6px;">
          <div class="section-title">{{ 'spaces.schema.layers.title' | transloco }}</div>
          <p style="font-size:12px; color:var(--text-muted); margin:4px 0 8px;">{{ 'spaces.schema.layers.hint' | transloco }}</p>
          @for (l of order(); track l; let i = $index) {
            <div style="display:flex; align-items:center; gap:8px; padding:3px 0;">
              <span class="num" style="width:18px; color:var(--text-muted);">{{ i + 1 }}</span>
              <span style="flex:1;">{{ labelOf(l) }}</span>
              <button class="btn-ghost btn btn-sm" [disabled]="i === 0" (click)="move(i, -1)" [attr.aria-label]="'spaces.schema.layers.up' | transloco">↑</button>
              <button class="btn-ghost btn btn-sm" [disabled]="i === order().length - 1" (click)="move(i, 1)" [attr.aria-label]="'spaces.schema.layers.down' | transloco">↓</button>
            </div>
          }
          @if (dirty()) {
            <button class="btn-secondary btn btn-sm" style="margin-top:6px;" [disabled]="saving()" (click)="save()">{{ 'spaces.schema.layers.save' | transloco }}</button>
          }
          @if (v.clashes.length) {
            <div class="section-title" style="margin-top:10px;">{{ 'spaces.schema.layers.clashes' | transloco: { count: v.clashes.length } }}</div>
            @for (c of v.clashes; track $index) {
              <div style="font-size:12px; padding:3px 0;">
                <code>{{ where(c) }}</code>
                @for (val of c.values; track val.networkId; let first = $first) {
                  <span style="margin-left:8px;" [style.color]="first ? 'var(--text)' : 'var(--text-muted)'">
                    {{ labelOf(val.networkId) }}@if (first) { <strong> · {{ 'spaces.schema.layers.applies' | transloco }}</strong> }
                  </span>
                  @if (!first) {
                    <button class="btn-ghost btn btn-sm" style="margin-left:4px;" [disabled]="proposing()"
                      [title]="'spaces.schema.layers.proposeHint' | transloco: { network: labelOf(val.networkId) }"
                      (click)="propose(c, val.networkId)">{{ 'spaces.schema.layers.propose' | transloco }}</button>
                  }
                }
              </div>
            }
          }
        </div>
      }
    }
  `,
})
export class SpaceSchemaLayersComponent {
  private api = inject(SchemaApi);
  private toast = inject(ToastService);
  private transloco = inject(TranslocoService);

  spaceId = input.required<string>();
  view = signal<SchemaLayersView | null>(null);
  order = signal<string[]>([]);
  dirty = signal(false);
  saving = signal(false);
  proposing = signal(false);

  constructor() {
    effect(() => {
      const id = this.spaceId();
      this.api.getSchemaLayers(id).subscribe({ next: v => this.show(v), error: () => this.view.set(null) });
    });
  }

  private show(v: SchemaLayersView): void {
    this.view.set(v); this.order.set([...v.precedence]); this.dirty.set(false);
  }

  labelOf(networkId: string): string {
    return this.view()?.layers.find(l => l.networkId === networkId)?.networkLabel ?? networkId;
  }

  /** `entity person.tier`, `entity person (namingPattern)`, or a top-level field such as `purpose`. */
  where(c: SchemaLayersView['clashes'][number]): string {
    if (c.field) return c.field;
    return `${c.kind} ${c.type}${c.property ? '.' + c.property : c.typeField ? ` (${c.typeField})` : ''}`;
  }

  move(i: number, by: number): void {
    const next = [...this.order()];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    this.order.set(next); this.dirty.set(true);
  }

  /** Offer the definition that applies here to a network that holds another, as a vote on that network (F-39.5). */
  propose(c: Clash, networkId: string): void {
    const layer = this.view()?.layers.find(l => l.networkId === networkId)?.meta ?? {};
    this.proposing.set(true);
    this.api.proposeToNetwork(this.spaceId(), networkId, proposalFor(c, layer)).subscribe({
      next: () => {
        this.proposing.set(false);
        this.toast.success(this.transloco.translate('spaces.schema.layers.proposed', { network: this.labelOf(networkId) }));
        this.api.getSchemaLayers(this.spaceId()).subscribe({ next: v => this.show(v) });
      },
      error: err => { this.proposing.set(false); this.toast.error(err.error?.error ?? this.transloco.translate('spaces.schema.layers.proposeFailed')); },
    });
  }

  save(): void {
    this.saving.set(true);
    this.api.setNetworkPrecedence(this.spaceId(), this.order()).subscribe({
      next: v => { this.saving.set(false); this.show(v); this.toast.success(this.transloco.translate('spaces.schema.layers.saved')); },
      error: err => { this.saving.set(false); this.toast.error(err.error?.error ?? this.transloco.translate('spaces.schema.layers.saveFailed')); },
    });
  }
}
