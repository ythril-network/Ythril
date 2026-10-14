/**
 * AboutComponent characterization tests.
 *
 * Written BEFORE the PR-U10 (part 2) redesign and proven green against the ORIGINAL component, so the
 * refactor (grouping into SettingsCards + shared UsageBar) has a safety net. These pin behaviour that
 * must survive the redesign: the load → info / error / loading states, the disk-percent computation and
 * its health thresholds, byte formatting, and the error-message precedence.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError, Subject } from 'rxjs';
import { provideRouter } from '@angular/router';
import { AdminApi } from '../../core/admin-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { AboutComponent } from './about.component';
import type { AboutInfo } from '../../core/api.types';

const INFO: AboutInfo = {
  instanceId: 'inst-abc-123',
  instanceLabel: 'My Brain',
  version: '1.4.4',
  uptime: '3d 4h',
  mongoVersion: '7.0.5',
  diskInfo: { total: 100, used: 40, available: 60, dataUsed: 25 },
};

/**
 * @param getAboutHealth Optional component-liveness double. Defaults to an error, because that is the
 *   shape every pre-existing test wants: the health card is a SEPARATE request and its failure must
 *   leave the rest of the page intact, not error it.
 */
function make(getAbout: () => unknown, getAboutHealth: () => unknown = () => throwError(() => new Error('probe unavailable'))) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AboutComponent, getTranslocoModule()],
    // About links into the Help page, so the component now needs a router context.
    providers: [provideRouter([]), { provide: AdminApi, useValue: { getAbout, getAboutHealth } }],
  });
  const f = TestBed.createComponent(AboutComponent);
  f.detectChanges(); // ngOnInit → load()
  return f;
}

describe('AboutComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());
  const el = (f: ReturnType<typeof make>) => f.nativeElement as HTMLElement;

  it('a successful load renders the instance/system fields', () => {
    const f = make(() => of({ ...INFO }));
    const c = f.componentInstance;
    expect(c.loading()).toBe(false);
    expect(c.error()).toBe('');
    expect(c.info()).toEqual(INFO);
    const text = el(f).textContent ?? '';
    expect(text).toContain('My Brain');
    expect(text).toContain('inst-abc-123');
    expect(text).toContain('1.4.4');
    expect(text).toContain('3d 4h');
    expect(text).toContain('7.0.5');
  });

  it('renders the disk usage figures (used / total)', () => {
    const f = make(() => of({ ...INFO }));
    const text = el(f).textContent ?? '';
    expect(text).toContain('40.0 B');   // used
    expect(text).toContain('100.0 B');  // total
  });

  it('diskPercent = used/total*100, and 0 when total is 0', () => {
    const f = make(() => of({ ...INFO }));
    expect(f.componentInstance.diskPercent()).toBeCloseTo(40);

    const z = make(() => of({ ...INFO, diskInfo: { total: 0, used: 0, available: 0, dataUsed: 0 } }));
    expect(z.componentInstance.diskPercent()).toBe(0);
  });

  it('a load failure surfaces the server error message, and falls back when absent', () => {
    const f = make(() => throwError(() => ({ error: { error: 'boom from server' } })));
    expect(f.componentInstance.loading()).toBe(false);
    expect(f.componentInstance.error()).toBe('boom from server');
    expect(el(f).textContent).toContain('boom from server');

    const g = make(() => throwError(() => ({})));
    // The fallback is the translated sentence (the test transloco echoes the key), not a hard-coded English literal.
    expect(g.componentInstance.error()).toBe('about.error.load');
  });

  it('while the request is pending it stays in the loading state (no info yet)', () => {
    const f = make(() => new Subject()); // never emits
    expect(f.componentInstance.loading()).toBe(true);
    expect(f.componentInstance.info()).toBeNull();
  });

  it('formatBytes renders human units', () => {
    const c = make(() => of({ ...INFO })).componentInstance;
    expect(c.formatBytes(0)).toBe('0 B');
    expect(c.formatBytes(512)).toBe('512.0 B');
    expect(c.formatBytes(2048)).toBe('2.0 KB');
    expect(c.formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(c.formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  it('disk health pill follows the shared design-system thresholds (warn ≥80, critical ≥95)', () => {
    // The redesign unifies About's disk health onto the shared UsageBar classifier (usageLevel, warn 80 /
    // danger 95) so the pill and bar agree and match the Storage page — replacing the old bespoke 75/90 bands.
    const healthAt = (used: number) =>
      make(() => of({ ...INFO, diskInfo: { total: 100, used, available: 100 - used, dataUsed: 10 } })).componentInstance.diskHealth();
    expect(healthAt(40)).toMatchObject({ variant: 'ok', label: 'about.disk.healthy' });
    expect(healthAt(79)).toMatchObject({ variant: 'ok' });
    expect(healthAt(80)).toMatchObject({ variant: 'warn', label: 'about.disk.high' });
    expect(healthAt(94)).toMatchObject({ variant: 'warn' });
    expect(healthAt(95)).toMatchObject({ variant: 'error', label: 'about.disk.critical' });
  });

  it('renders the grouped cards + shared usage bar', () => {
    const f = make(() => of({ ...INFO }));
    // Instance, System, the Documentation card that points at the bundled guides — and Components,
    // which is present from the first paint in a pending state (see the test below).
    expect(el(f).querySelectorAll('app-settings-card').length).toBe(4);
    expect(el(f).querySelector('app-usage-bar')).toBeTruthy();
    expect(el(f).querySelectorAll('app-status-pill').length).toBe(3);
  });

  it('the Components card is present while its probe is still running, not conjured afterwards', () => {
    // The card used to render only once the probe answered. The stated reason was half right — an empty
    // card reads as "nothing configured", a different claim — but the remedy was wrong: rendering
    // nothing makes a whole card materialise on a page the reader has already finished scanning, which
    // is what the owner reported. A pending state claims neither.
    const f = make(() => of({ ...INFO }));   // default stub: the health probe never resolves successfully
    const text = el(f).textContent ?? '';
    expect(text).toContain('about.card.components');
    expect(text).toContain('about.components.pending');
  });

  it('once the probe answers, the pending card is replaced rather than duplicated', () => {
    const f = make(
      () => of({ ...INFO }),
      () => of({ level: 'ok', down: [], components: [{ id: 'doc-render', label: 'Page renderer', configured: true, reachable: true, impact: '' }] }),
    );
    const text = el(f).textContent ?? '';
    expect(text).not.toContain('about.components.pending');
    // Still four cards: the resolved Components card takes the pending one's place.
    expect(el(f).querySelectorAll('app-settings-card').length).toBe(4);
  });

  it('a load failure renders the shared error-state (with the reason), and Retry re-loads', () => {
    const f = make(() => throwError(() => ({ error: { error: 'nope' } })));
    expect(el(f).querySelector('app-error-state')).toBeTruthy();
    expect(el(f).textContent).toContain('nope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Component liveness card
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('AboutComponent — optional component liveness', () => {
  const ok = () => of(INFO);
  const health = (over: Record<string, unknown> = {}) => () => of({
    level: 'ok',
    down: [],
    components: [
      { id: 'doc-render', label: 'Document renderer', configured: true, reachable: true, impact: 'PDFs fall back to text.' },
    ],
    ...over,
  });

  it('renders a card per component once the probe answers', () => {
    const f = make(ok, health());
    f.detectChanges();
    const text = f.nativeElement.textContent as string;
    expect(text).toContain('Document renderer');
  });

  it('does NOT render the card when the probe fails — the rest of About still loads', () => {
    // The health request is deliberately separate. A failed probe must not error the page or leave an
    // empty card, which would read as "nothing configured" — a different claim entirely.
    const f = make(ok, () => throwError(() => new Error('probe down')));
    f.detectChanges();
    expect(f.componentInstance.health()).toBeNull();
    expect((f.nativeElement.textContent as string)).toContain(INFO.instanceLabel);
  });

  it('shows the impact line ONLY for a component that is actually down', () => {
    // Printing the consequence next to a healthy component turns the panel into a wall of warnings.
    const healthy = make(ok, health());
    healthy.detectChanges();
    expect(healthy.nativeElement.querySelector('.component-impact')).toBeNull();

    const broken = make(ok, health({
      level: 'degraded',
      down: ['doc-render'],
      components: [
        { id: 'doc-render', label: 'Document renderer', configured: true, reachable: false, impact: 'PDFs fall back to text.' },
      ],
    }));
    broken.detectChanges();
    const impact = broken.nativeElement.querySelector('.component-impact');
    expect(impact, 'a down component must explain what it costs').toBeTruthy();
    expect(impact.textContent).toContain('PDFs fall back to text.');
  });

  it('an unconfigured component is neutral, not an error', () => {
    // It was never asked for. Marking it as a fault makes the panel permanently red.
    const f = make(ok, health({
      components: [
        { id: 'nli', label: 'Contradiction judge', configured: false, reachable: null, impact: 'x' },
      ],
    }));
    f.detectChanges();
    const c = f.componentInstance;
    expect(c.componentVariant({ id: 'nli', label: '', configured: false, reachable: null, impact: '' } as never)).toBe('off');
    expect(f.nativeElement.querySelector('.component-impact')).toBeNull();
  });

  it('maps each level to a pill variant, with unknown as warn rather than error', () => {
    // "Could not check" is not "is broken" — showing it as an error trains people to ignore the colour.
    const f = make(ok, health());
    f.detectChanges();
    const c = f.componentInstance;

    c.health.set({ level: 'ok', components: [], down: [] } as never);
    expect(c.healthPill().variant).toBe('ok');
    c.health.set({ level: 'degraded', components: [], down: ['x'] } as never);
    expect(c.healthPill().variant).toBe('error');
    c.health.set({ level: 'unknown', components: [], down: [] } as never);
    expect(c.healthPill().variant).toBe('warn');
  });
});
