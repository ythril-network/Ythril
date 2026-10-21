import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { pluralText } from '../../core/plural-text';
import { ViewsApi, type UnclaimedView, type ViewsMigrationReport } from '../../core/views-api.service';
import { PhIconComponent } from '../../shared/ph-icon.component';

const STORAGE_KEY = 'ythril.viewsMigrationBanner.dismissed';

/**
 * The notice an instance admin gets on the Brain page after the 6.0 upgrade (Q-531, plan rev 3.2 "Client"): which proxy spaces became
 * personal views, which of those still wait for an owner, and which proxy ids are still reserved, with where to deal with them.
 *
 * It appears only while something is OWED - an id still reserved or a view still unclaimed - and only to an admin: `retired` is
 * `GET /api/spaces`' `retiredSpaceIds`, which the server serves to an admin alone (`null` otherwise, and the banner is absent and asks
 * nothing). The migration report is read once for an admin; if it cannot be read the banner still says the reserved ids. Dismissing it is
 * remembered PER SET of what is owed in the browser, so releasing one id and leaving another brings it back, while a dismissed set stays
 * quiet. The browser's storage can be absent or throw (a private window, a blocked site), and then the banner simply shows every time:
 * a notice that cannot be remembered is shown, never lost.
 *
 * Every counted sentence goes through `pluralText` (the language's own plural forms), and the place it points to is built from the
 * sidebar's own labels (`nav.section.admin`, `nav.spaces`), so a renamed menu entry cannot leave this sentence naming a place that is gone.
 */
@Component({
  selector: 'app-views-migration-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TranslocoPipe, PhIconComponent],
  template: `
    @if (visible()) {
      <div class="alert alert-warning" role="status" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
        <ph-icon name="info" [size]="16"/>
        <div style="flex:1;min-width:200px;">
          @for (line of lines(); track $index) { <p style="margin:0 0 4px;">{{ line }}</p> }
        </div>
        <a routerLink="/settings/spaces" class="btn btn-sm btn-secondary">{{ 'nav.spaces' | transloco }}</a>
        <button class="btn btn-sm btn-ghost" type="button" (click)="dismiss()">{{ 'views.migration.dismiss' | transloco }}</button>
      </div>
    }
  `,
})
export class ViewsMigrationBannerComponent {
  /** The reserved ids as served to an admin; `null` when the caller is not one. */
  readonly retired = input<readonly string[] | null>(null);

  private readonly api = inject(ViewsApi);
  private readonly transloco = inject(TranslocoService);
  private readonly report = signal<ViewsMigrationReport | null>(null);

  protected readonly ids = computed(() => [...(this.retired() ?? [])].sort());
  private readonly unclaimed = computed<readonly UnclaimedView[]>(() => this.report()?.unclaimed ?? []);
  private readonly unclaimedNames = computed(() => this.unclaimed().map(u => u.name).sort());
  /** What is owed, as one string: the dismissal is remembered against it. */
  private readonly owedKey = computed(() => `${this.ids().join(',')}|${this.unclaimedNames().join(',')}`);
  private readonly dismissedKey = signal(this.readDismissed());
  protected readonly visible = computed(() => (this.ids().length > 0 || this.unclaimedNames().length > 0) && this.dismissedKey() !== this.owedKey());

  protected readonly lines = computed(() => {
    const lang = this.transloco.getActiveLang();
    const say = (base: string, names: readonly string[]) =>
      names.length > 0 ? [pluralText(this.transloco, lang, base, names.length, { names: names.join(', ') })] : [];
    const migrated = [...(this.report()?.migrated ?? [])].sort();
    const where = `${this.transloco.translate('nav.section.admin')} > ${this.transloco.translate('nav.spaces')}`;
    return [
      ...say('views.migration.migrated', migrated),
      ...say('views.migration.unclaimed', this.unclaimedNames()),
      ...say('views.migration.retired', this.ids()),
      this.transloco.translate('views.migration.review', { where }),
    ];
  });

  constructor() {
    // Read once, when the page learns it is talking to an admin. A failed read leaves the reserved ids, which are all the banner had before.
    effect(() => {
      if (this.retired() === null) return;
      untracked(() => this.api.migration().subscribe({ next: r => this.report.set(r), error: () => { /* the reserved ids still show */ } }));
    });
  }

  protected dismiss(): void {
    const key = this.owedKey();
    this.dismissedKey.set(key);
    try { localStorage.setItem(STORAGE_KEY, key); } catch { /* shown again next time: acceptable */ }
  }

  private readDismissed(): string {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  }
}
