import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { pluralText } from '../../core/plural-text';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { EntitySearchComponent } from '../../shared/entity-search.component';
import { Entity } from '../../core/api.types';
import { GRAPH_TOOLBAR_STYLES } from './graph.styles';

/**
 * The graph page's toolbar: pick a root, choose the depth and direction, toggle labels, fit and reset.
 *
 * ## Why it is a component
 *
 * G-7: the page was 690 code lines against a 650 ceiling, and the ratchet's rule is that a raise is paid with
 * an extraction rather than argued down. This is the largest self-contained block left — every control in it
 * reads page state and reports a choice back, with no knowledge of cytoscape, the traversal cache, or the
 * side panels.
 *
 * ## Every control REPORTS; none of them sets
 *
 * The obvious shape is `model()` for depth, direction and labels, and it would have been wrong: each of those
 * choices does more than change a value. A new depth or direction re-runs the traversal from the current root,
 * and toggling labels adds a class to the cytoscape edges — work this component cannot see and must not own. A
 * two-way binding moves the value and drops the rest, which leaves a toolbar whose controls look like they
 * work and change nothing. So the page keeps its three handlers and this emits into them.
 *
 * Same reasoning for `fit` and `reset`, which are commands on a canvas this component has no handle to, and
 * for `rootSelected`: choosing a root starts a traversal, which is the page's job.
 *
 * `stats` is a plain input rather than two counts, so the page decides whether there is anything to show. The
 * old markup wrapped the counts in `@if (rootEntity())`, and moving that condition here would have required
 * this component to know what a root entity is.
 */
@Component({
  selector: 'app-graph-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, EntitySearchComponent],
  styles: [GRAPH_TOOLBAR_STYLES],
  host: { class: 'graph-toolbar' },
  template: `
    <div class="search-wrapper">
      <app-entity-search
        mode="bar"
        [spaceId]="spaceId()"
        placeholder="entitySearch.defaultPlaceholder"
        defaultMode="semantic"
        (selected)="rootSelected.emit($event)"
        (queryChange)="queryChange.emit($event)"
      />
    </div>

    <div class="toolbar-divider"></div>

    <div class="depth-control">
      <span class="toolbar-label">{{ 'graph.toolbar.depth' | transloco }}</span>
      <input type="range" min="1" max="10" [ngModel]="depth()" (ngModelChange)="depthChange.emit(+$event)" />
      <span class="depth-value">{{ depth() }}</span>
    </div>

    <div class="pill-group">
      @for (d of DIRECTIONS; track d.value) {
        <button type="button" [class.active]="direction() === d.value" [attr.aria-pressed]="direction() === d.value"
                (click)="directionChange.emit(d.value)">{{ d.key | transloco }}</button>
      }
    </div>

    <div class="pill-group">
      <button type="button" [class.active]="!hideLabels()" [attr.aria-pressed]="!hideLabels()"
              (click)="hideLabelsChange.emit(!hideLabels())"
              [attr.title]="'graph.toolbar.toggleLabels' | transloco">{{ 'graph.toolbar.labels' | transloco }}</button>
    </div>

    <div class="toolbar-spacer"></div>

    @if (stats(); as s) {
      <span class="graph-stats">{{ statsText(s) }}</span>
    }
    <button class="toolbar-btn" [attr.title]="'graph.toolbar.fitViewport' | transloco" (click)="fit.emit()">
      <ph-icon name="corners-out" [size]="16"/>
    </button>
    <button class="toolbar-btn" [attr.title]="'graph.toolbar.resetGraph' | transloco" (click)="reset.emit()">
      <ph-icon name="arrows-clockwise" [size]="16"/>
    </button>
  `,
})
export class GraphToolbarComponent {
  /**
   * The three direction pills, as data.
   *
   * They were three hand-written buttons differing in one word each, which is how the middle one ended up
   * with different whitespace from its neighbours. A list makes adding a fourth a data change.
   */
  protected readonly DIRECTIONS = [
    { value: 'outbound' as const, key: 'graph.toolbar.direction.out' },
    { value: 'inbound' as const, key: 'graph.toolbar.direction.in' },
    { value: 'both' as const, key: 'graph.toolbar.direction.both' },
  ];

  readonly spaceId = input<string>('');
  /** Node and edge counts, or null when there is nothing traversed to count. */
  readonly stats = input<{ nodes: number; edges: number } | null>(null);

  private transloco = inject(TranslocoService);

  /** "N nodes · M edges": each number takes the plural form its own count needs, so it is two sentences joined and not one. */
  protected statsText(s: { nodes: number; edges: number }): string {
    const lang = this.transloco.getActiveLang();
    return `${pluralText(this.transloco, lang, 'graph.stats.nodes', s.nodes)} · ${pluralText(this.transloco, lang, 'graph.stats.edges', s.edges)}`;
  }

  /*
   * Reported, never set here — and that distinction is load-bearing rather than stylistic. Each of these
   * choices does more than change a value on the page: a new depth or direction re-runs the traversal, and
   * toggling labels adds a class to the cytoscape edges. A two-way binding would have moved the value and
   * silently dropped all three of those, leaving a toolbar whose controls appear to work.
   */
  readonly depth = input<number>(2);
  readonly direction = input<'outbound' | 'inbound' | 'both'>('both');
  readonly hideLabels = input<boolean>(false);

  readonly depthChange = output<number>();
  readonly directionChange = output<'outbound' | 'inbound' | 'both'>();
  readonly hideLabelsChange = output<boolean>();

  readonly rootSelected = output<Entity>();
  readonly queryChange = output<string>();
  readonly fit = output<void>();
  readonly reset = output<void>();
}
