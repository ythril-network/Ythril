import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { SpaceStats } from '../../core/api.types';

/**
 * The Overview of a personal view: what it holds, and the panels that are not its to show (Q-531, plan rev 3.2 "Client").
 *
 * A space's Overview is made of settings and reports about ONE space: index status, completeness, schema, layers, activity, token access.
 * A view is not a space and the server answers those reads as a missing space, so the panels would load to an error nobody could act on.
 * They are said to be unavailable, in one sentence, with the way out (open a member), instead of loading silently to nothing.
 * The counts are the one thing that is a read through the view, so they stay.
 */
@Component({
  selector: 'app-view-overview',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe],
  template: `
    <section class="card" style="padding:16px;" aria-labelledby="view-overview-title">
      <h3 id="view-overview-title" style="margin:0 0 8px;font-size:15px;">{{ 'views.overview.title' | transloco }}</h3>
      <p style="margin:0 0 12px;color:var(--text-secondary);font-size:13px;">{{ 'views.overview.body' | transloco }}</p>
      @if (stats(); as s) {
        <dl style="display:flex;flex-wrap:wrap;gap:8px 24px;margin:0 0 14px;font-size:13px;">
          <div><dt style="display:inline;color:var(--text-muted);">{{ 'brain.tab.entities' | transloco }}:</dt> <dd style="display:inline;margin:0;">{{ s.entities }}</dd></div>
          <div><dt style="display:inline;color:var(--text-muted);">{{ 'brain.tab.edges' | transloco }}:</dt> <dd style="display:inline;margin:0;">{{ s.edges }}</dd></div>
          <div><dt style="display:inline;color:var(--text-muted);">{{ 'brain.tab.facts' | transloco }}:</dt> <dd style="display:inline;margin:0;">{{ s.facts }}</dd></div>
          <div><dt style="display:inline;color:var(--text-muted);">{{ 'brain.tab.chrono' | transloco }}:</dt> <dd style="display:inline;margin:0;">{{ s.chrono }}</dd></div>
          <div><dt style="display:inline;color:var(--text-muted);">{{ 'brain.tab.files' | transloco }}:</dt> <dd style="display:inline;margin:0;">{{ s.files }}</dd></div>
        </dl>
      }
      <p style="margin:0;font-size:13px;"><strong>{{ 'views.notAvailable' | transloco }}</strong></p>
      <p class="hint" style="margin:4px 0 0;">{{ 'views.notAvailablePanels' | transloco }}</p>
    </section>
  `,
})
export class ViewOverviewComponent {
  /** The view's counts, read through it; undefined until they arrive. */
  readonly stats = input<SpaceStats | undefined>(undefined);
}
