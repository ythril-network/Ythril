/**
 * An unrecognised pin is shown where an operator will see it, and nothing is shown when there is none.
 *
 * ## What this protects
 *
 * `YTHRIL_PINNED_FIELDS` fixes a field at whatever it resolves to. Its one dangerous failure is a typo: the
 * operator believes a control is locked and it is not. The server reports those entries as `pinnedUnknown` rather
 * than only logging them, and this notice is the half that makes that reach a person — a warning in the server log
 * is the one place they are not reading.
 *
 * Two things are asserted that a screenshot cannot: that it renders **nothing** on a healthy instance, and that it
 * sits on the PAGE above the tab panel rather than inside one tab. The second matters because the variable names
 * fields across all three tabs, so putting the notice in one of them would hide it from an operator who opened
 * another.
 *
 * Run: npm run test:client
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const notice = readFileSync('src/app/pages/settings/media-processing/pinned-unknown-notice.component.ts', 'utf8');
const page = readFileSync('src/app/pages/settings/media-processing/media-processing-page.component.ts', 'utf8');
const modelsTab = readFileSync('src/app/pages/settings/media-processing/models-tab.component.ts', 'utf8');
const state = readFileSync('src/app/pages/settings/media-processing/media-processing-state.service.ts', 'utf8');
const en = JSON.parse(readFileSync('public/assets/i18n/en.json', 'utf8')) as Record<string, string>;

describe('the notice itself', () => {
  it('renders nothing when there is nothing to report', () => {
    /*
     * A container that is always present and usually empty is a container readers learn to skip — which is exactly
     * when it needs to be noticed. The guard is on the input, so a healthy instance emits no element at all.
     */
    expect(notice).toMatch(/@if \(paths\(\)\.length\) \{/);
  });

  it('shows the offending names verbatim, because the operator has to spot their own typo', () => {
    // Paraphrasing them would make the one useful fact — which character is wrong — unavailable.
    expect(notice).toContain('paths().join(', );
    expect(notice).toContain('data-mono');
  });

  it('says what to do, not only that something is wrong', () => {
    expect(en['mediaProcessing.pinnedUnknown.title.other']).toBeTruthy();
    expect(en['mediaProcessing.pinnedUnknown.body']).toBeTruthy();
    expect(en['mediaProcessing.pinnedUnknown.title.other']).toContain('{{count}}');
    // The body must tell them the rule, or "not recognised" is a dead end.
    expect(en['mediaProcessing.pinnedUnknown.body']).toMatch(/spelling/i);
  });

  it('uses the GLOBAL alert class, so it cannot render as unstyled text', () => {
    /*
     * `.alert-warning` lives in `styles.scss`. Angular's emulated encapsulation would scope a copy defined in
     * another component's styles, which is exactly how `.permission-help` shipped as unstyled text in the token
     * dialog while its test asserted only that the element existed.
     */
    expect(notice).toContain('class="alert alert-warning"');
    expect(notice).not.toMatch(/styles:\s*\[/);
  });
});

describe('where it is mounted', () => {
  it('on the PAGE, above the tab panel', () => {
    const mount = page.indexOf('<app-pinned-unknown-notice');
    const panel = page.indexOf('role="tabpanel"');
    expect(mount).toBeGreaterThan(-1);
    expect(panel).toBeGreaterThan(-1);
    expect(mount).toBeLessThan(panel);
  });

  it('and NOT inside a single tab, which would hide it from anyone on another tab', () => {
    // The variable names fields across all three tabs, so a typo in it is a page-level fact.
    expect(modelsTab).not.toContain('app-pinned-unknown-notice');
  });

  it('is registered, or the element renders as nothing at all', () => {
    // An unregistered component in a standalone template is a silent no-op in production builds.
    expect(page).toContain('PinnedUnknownNoticeComponent');
    expect(page).toMatch(/imports:\s*\[[\s\S]*?PinnedUnknownNoticeComponent/);
  });

  it('the state service reads the field off the config response', () => {
    expect(state).toMatch(/pinnedUnknown: string\[\] = \[\];/);
    expect(state).toMatch(/this\.pinnedUnknown = cfg\.pinnedUnknown \?\? \[\];/);
  });
});
