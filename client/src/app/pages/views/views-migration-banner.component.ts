import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';

const STORAGE_KEY = 'ythril.viewsMigrationBanner.dismissed';

/**
 * The notice an instance admin gets on the Brain page after the 6.0 upgrade: proxy spaces became personal views, and their old ids are
 * still reserved until released under Settings, Spaces (Q-531, plan rev 3.2 "Client").
 *
 * It appears only while ids are reserved, and only to an admin: `retired` is `GET /api/spaces`' `retiredSpaceIds`, which the server serves to
 * an admin alone (`null` otherwise, and the banner is absent). Dismissing it is remembered PER SET of ids in the browser, so releasing one id
 * and leaving another brings it back, while a dismissed set stays quiet. The browser's storage can be absent or throw (a private window, a
 * blocked site), and then the banner simply shows every time: a notice that cannot be remembered is shown, never lost.
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
        <span>{{ 'views.migration.banner' | transloco: { count: ids().length, ids: ids().join(', ') } }}</span>
        <a routerLink="/settings/spaces" class="btn btn-sm btn-secondary">{{ 'nav.spaces' | transloco }}</a>
        <button class="btn btn-sm btn-ghost" type="button" (click)="dismiss()">{{ 'views.migration.dismiss' | transloco }}</button>
      </div>
    }
  `,
})
export class ViewsMigrationBannerComponent {
  /** The reserved ids as served to an admin; `null` when the caller is not one. */
  readonly retired = input<readonly string[] | null>(null);

  protected readonly ids = computed(() => [...(this.retired() ?? [])].sort());
  private readonly dismissedKey = signal(this.readDismissed());
  protected readonly visible = computed(() => this.ids().length > 0 && this.dismissedKey() !== this.ids().join(','));

  protected dismiss(): void {
    const key = this.ids().join(',');
    this.dismissedKey.set(key);
    try { localStorage.setItem(STORAGE_KEY, key); } catch { /* shown again next time: acceptable */ }
  }

  private readDismissed(): string {
    try { return localStorage.getItem(STORAGE_KEY) ?? ''; } catch { return ''; }
  }
}
