import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { TypedKind } from '../../core/type-field';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { SchemaTypeHistoryComponent } from '../settings/schema-type-history.component';
import type { DefinitionLanding } from './definition-landing';

/**
 * The chips of a record list landed on from a type's history (Q-744, design r4 §5.4): "Type: {type}" (an edge's says Relation),
 * "Type definition: not current" or its span, each removable, and "History of {type}", which opens that history right here. The note
 * an older server earns by refusing the definition filter is said in the same row.
 */
@Component({
  selector: 'app-definition-chips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, SchemaTypeHistoryComponent],
  styles: [`
    :host { display: block; }
    .chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 10px; font-size: 12.5px; }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 9px; border: 1px solid var(--border);
      border-radius: 999px; background: var(--bg-elevated); }
    .x { display: inline-flex; border: 0; background: none; padding: 2px; color: var(--text-muted); cursor: pointer; border-radius: 50%; }
    .x:hover { color: var(--text-primary); }
    .lnk { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
    .note { margin: 0; color: var(--text-muted); flex-basis: 100%; }
  `],
  template: `
@if (landing().active() || landing().refused() || (pinned() && type())) {
  <div class="chip-row">
    @if (type()) {
      <span class="chip">
        @if (kind() === 'edge') { {{ 'brain.filter.relationChip' | transloco: { name: type() } }}
          <button class="x" type="button" [attr.title]="'brain.filter.removeRelationAria' | transloco" [attr.aria-label]="'brain.filter.removeRelationAria' | transloco"
                  (click)="clearType.emit()"><ph-icon name="x" [size]="11"/></button>
        } @else { {{ 'brain.filter.typeChip' | transloco: { name: type() } }}
          <button class="x" type="button" [attr.title]="'brain.filter.removeTypeAria' | transloco" [attr.aria-label]="'brain.filter.removeTypeAria' | transloco"
                  (click)="clearType.emit()"><ph-icon name="x" [size]="11"/></button>
        }
      </span>
    }
    @if (landing().active()) {
      <span class="chip">{{ landing().chip().key | transloco: landing().chip().params }}
        <button class="x" type="button" [attr.title]="'brain.filter.removeDefinitionAria' | transloco" [attr.aria-label]="'brain.filter.removeDefinitionAria' | transloco"
                (click)="clearDefinition.emit()"><ph-icon name="x" [size]="11"/></button>
      </span>
    }
    @if (type()) {
      <button class="lnk" type="button" aria-haspopup="dialog" [attr.aria-expanded]="historyOpen()" (click)="historyOpen.set(true)">{{ 'brain.filter.historyOf' | transloco: { type: type() } }}</button>
    }
    @if (landing().refused()) { <p class="note" role="note">{{ 'brain.filter.cannotFilterByDefinition' | transloco }}</p> }
  </div>
}
@if (historyOpen()) {
  <app-schema-type-history [spaceId]="spaceId()" [kind]="kind()" [type]="type()" (closed)="historyOpen.set(false)" (left)="historyOpen.set(false)" />
}
  `,
})
export class DefinitionChipsComponent {
  readonly landing = input.required<DefinitionLanding>();
  readonly spaceId = input.required<string>();
  readonly kind = input.required<TypedKind>();
  /** The type the list is filtered by. */
  readonly type = input<string>('');
  /** The type chip is the only place this filter shows (the edges tab's linked label), so it stays while the type is set. */
  readonly pinned = input<boolean>(false);
  // "clear", not "remove": a chip narrows what the list shows and writes nothing, so it is no write control a view must hide.
  readonly clearType = output<void>();
  readonly clearDefinition = output<void>();
  protected readonly historyOpen = signal(false);
}
