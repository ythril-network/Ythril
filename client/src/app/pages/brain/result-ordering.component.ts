import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { orderingOf } from './recall-grouping';

/**
 * Which score placed a result, what the other stages said, and — for a fused score — the two ranks it came from.
 *
 * The Query tab wrote this line out twice, once for a record and once for a file group, and the fused ranks
 * (`Q-159`) would have been a third thing to keep the same in both. The deciding score reads as the primary figure;
 * the stages that also ran sit behind it. Monospace, because they are values a reader compares between rows, and a
 * proportional font makes 0.750 and 0.705 the same width.
 *
 * `display: contents`, so the spans stay items of the row they sit in, exactly as when they were inline.
 */
@Component({
  selector: 'app-result-ordering',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  styles: [`
    :host { display: contents; }
    .score-by {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-subtle, rgba(127,127,127,0.10));
      border-radius: var(--radius-sm);
      padding: 1px 6px;
      white-space: nowrap;
    }
    .score-also {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }
  `],
  template: `
    @if (ordering(); as ord) {
      <span class="score-by" [attr.title]="(ord.by === 'fusedScore' ? 'brain.query.fusedExplained' : 'brain.query.orderedBy') | transloco: { by: ord.by }">
        {{ ord.by }}: {{ ord.value.toFixed(3) }}
      </span>
      @for (st of ord.stages; track st.name) {
        @if (st.name !== ord.by) {
          <span class="score-also" [attr.title]="st.name === 'fusedScore' ? ('brain.query.fusedExplained' | transloco) : null">{{ st.name }}: {{ st.value.toFixed(3) }}</span>
        }
      }
      @if (ord.ranks; as r) {
        <span class="score-also fused-ranks" [attr.title]="'brain.query.fusedExplained' | transloco">
          {{ (r.lexical !== undefined ? 'brain.query.fusedRanks' : 'brain.query.fusedRanksNoText') | transloco: { vector: r.vector, lexical: r.lexical } }}
        </span>
      }
    }
  `,
})
export class ResultOrderingComponent {
  /** A recall result, flat or enveloped — whatever `orderingOf` reads. */
  readonly hit = input.required<object>();
  protected readonly ordering = computed(() => orderingOf(this.hit() as Record<string, unknown>));
}
