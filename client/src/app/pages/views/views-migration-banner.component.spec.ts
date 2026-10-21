/**
 * The notice an admin gets on the Brain page while pre-6.0 proxy ids are still reserved (Q-531, plan rev 3.2 "Client").
 *
 * ## The rules
 *
 * 1. Shown only while ids are reserved, and only to an admin (`retired` is `null` for anyone else: nothing is drawn).
 * 2. Dismissing it is remembered per SET of ids: the same set stays quiet, a different one (an id released, another left) brings it back.
 * 3. A browser whose storage throws still shows the notice and still dismisses it for the page's lifetime: a notice that cannot be remembered
 *    is shown, never lost, and never an error.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ViewsMigrationBannerComponent } from './views-migration-banner.component';

function mount(retired: string[] | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ViewsMigrationBannerComponent, getTranslocoModule()], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ViewsMigrationBannerComponent);
  fixture.componentRef.setInput('retired', retired);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('the views migration banner (Q-531)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
  afterEach(() => vi.restoreAllMocks());

  it('is absent for a caller who is not an admin and for an admin with no reserved id', () => {
    expect(mount(null).el.querySelector('[role="status"]')).toBeNull();
    expect(mount([]).el.querySelector('[role="status"]')).toBeNull();
  });

  it('names the reserved ids and points to Settings, Spaces', () => {
    const { el } = mount(['b', 'a']);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/settings/spaces');
  });

  it('stays dismissed for the same set, and comes back for a different one', () => {
    const first = mount(['a', 'b']);
    first.el.querySelector<HTMLButtonElement>('button')!.click();
    first.fixture.detectChanges();
    expect(first.el.querySelector('[role="status"]')).toBeNull();

    expect(mount(['b', 'a']).el.querySelector('[role="status"]'), 'the same set, in another order, came back').toBeNull();
    expect(mount(['a']).el.querySelector('[role="status"]'), 'a different set stayed quiet').not.toBeNull();
  });

  it('shows and dismisses even when the browser storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { fixture, el } = mount(['a']);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});
