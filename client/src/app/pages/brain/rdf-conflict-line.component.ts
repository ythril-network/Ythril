/**
 * The one line the Overview's Networks panel says when a network contests the space's RDF base (Q-942, owner's decision on layout D), with
 * the way in: "Open RDF names". It asks `RdfConflicts` for the space shown, again for each space, and draws nothing when none contests it.
 * Its own component, so the Overview (over its size ceiling) carries one element for it.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, untracked } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { RdfConflicts } from '../../core/rdf-conflicts.service';

@Component({
  selector: 'app-rdf-conflict-line',
  standalone: true,
  imports: [TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .rdf-conflict { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 10px 0 0; font-size: 12.5px; color: var(--warning); }
    .go { font: inherit; font-size: 11.5px; background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; text-decoration: underline; }
    .go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  `],
  template: `
@if (contested()) {
  <p class="rdf-conflict" data-testid="overview-rdf-conflict"><ph-icon name="warning" [size]="13"/>{{ 'rdf.overview.conflict' | transloco }}
    <button type="button" class="go" data-testid="overview-rdf-open" (click)="openNames.emit()">{{ 'rdf.export.openNames' | transloco }}</button></p>
}
  `,
})
export class RdfConflictLineComponent {
  private readonly conflicts = inject(RdfConflicts);
  readonly spaceId = input.required<string>();
  /** "Open RDF names": the host opens the space's settings on the RDF names card. */
  readonly openNames = output<void>();
  readonly contested = computed(() => this.conflicts.has(this.spaceId()));

  constructor() {
    effect(() => { const id = this.spaceId(); untracked(() => this.conflicts.load(id)); });
  }
}
