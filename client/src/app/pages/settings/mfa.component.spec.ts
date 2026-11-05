/**
 * MfaComponent — characterization test for the enrolment QR (A20).
 *
 * Pins the behaviour that must survive swapping the QR library (CommonJS `qrcode` → ESM `uqr`):
 * after `startEnroll()`, `qrUrl` holds a non-empty `data:image/…` URL that the template's `<img>`
 * can render, and the component moves to the `enrolling` state. The assertion deliberately checks
 * the `data:image/` prefix (true for both the old PNG data-URL and the new SVG data-URL) rather than
 * the exact MIME, so it characterizes the observable contract — "enrolment yields a renderable QR
 * image" — not the implementation. Proven green against the original `qrcode` impl before the swap.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { readFileSync } from 'node:fs';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { MfaComponent } from './mfa.component';

/** Minimal AuthApi stub: the component calls getMfaStatus (ngOnInit) and setupMfa (startEnroll). */
function makeAuthApi() {
  return {
    getMfaStatus: () => of({ enabled: false }),
    setupMfa: () => of({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauth: 'otpauth://totp/Ythril:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Ythril',
    }),
  } as any;
}

describe('MfaComponent — enrolment QR (characterization)', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MfaComponent, getTranslocoModule()],
      providers: [{ provide: AuthApi, useFactory: makeAuthApi }],
    });
  });

  it('startEnroll populates qrUrl with a renderable data:image URL and enters the enrolling state', async () => {
    const fixture = TestBed.createComponent(MfaComponent);
    const cmp = fixture.componentInstance;
    fixture.detectChanges(); // ngOnInit → refresh()

    cmp.startEnroll();

    expect(cmp.state()).toBe('enrolling');
    expect(cmp.secret()).toBe('JBSWY3DPEHPK3PXP');
    // QR generation may resolve on a microtask (qrcode) or synchronously (uqr).
    await vi.waitFor(() => expect(cmp.qrUrl()).not.toBe(''));
    const url = cmp.qrUrl();
    expect(url.startsWith('data:image/')).toBe(true);
    expect(url.length).toBeGreaterThan(100);
  });
});

/**
 * The success note retires itself.
 *
 * It used to persist until the next action, so "MFA enabled" was still on screen the next time the page
 * was opened — reading as a live status rather than the receipt for something done a while ago. A timer
 * that silently stops working leaves exactly the old behaviour and no error, so it is worth pinning.
 */
describe('MfaComponent — the success note auto-dismisses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [MfaComponent, getTranslocoModule()],
      providers: [{ provide: AuthApi, useValue: {
        getMfaStatus: () => of({ enabled: true }),
        setupMfa: () => of({ secret: 's', otpauth: 'otpauth://totp/x' }),
        disableMfa: () => of({ ok: true }),
      } as never }],
    });
  });
  afterEach(() => vi.useRealTimers());

  it('shows the note, then clears it on its own', () => {
    const cmp = TestBed.createComponent(MfaComponent).componentInstance;
    cmp.confirmDisable();
    expect(cmp.successMsg()).not.toBe('');
    vi.advanceTimersByTime(5_000);
    expect(cmp.successMsg()).not.toBe('');   // still readable a few seconds in
    vi.advanceTimersByTime(2_000);
    expect(cmp.successMsg()).toBe('');
  });

  it('a pending dismissal cannot fire into a destroyed component', () => {
    const fixture = TestBed.createComponent(MfaComponent);
    fixture.componentInstance.confirmDisable();
    fixture.destroy();
    // The assertion is that advancing past the deadline throws nothing — a timer left armed against a
    // torn-down component is the classic version of this bug.
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
  });
});

/**
 * A locked token says so where the code is typed (Q-694, bundle-233).
 *
 * ## The defect
 *
 * Five wrong codes lock the token for up to 15 minutes, a correct code included (`429 MFA_LOCKED`, `retryAfterSeconds`). The enrolment
 * confirm answered any HTTP error with "Could not verify code. Try again." and the disable button answered it with nothing at all
 * (`error: () => this.disabling.set(false)`): the person keeps retyping into a lock that cannot open, and the settings page cannot say
 * that confirming five mistyped enrolment codes locks the token, MFA-disable included, for that long.
 *
 * ## What is held
 *
 * With the REAL English words, a 429 on the confirm and a 429 on the disable each show the lock sentence with the wait (5 minutes for
 * 300 s) on the screen, the confirm in place of "invalid" and "verify failed", the disable in place of silence. The disable stays
 * undone: MFA is still on, no success note, the button usable again.
 */
describe('MfaComponent — a 429 MFA_LOCKED is shown, on the confirm and on the disable', () => {
  const english = JSON.parse(readFileSync('public/assets/i18n/en.json', 'utf8')) as Record<string, string>;
  const locked = () => new HttpErrorResponse({
    status: 429, statusText: 'Too Many Requests', headers: new HttpHeaders({ 'Retry-After': '300' }),
    error: { error: 'MFA_LOCKED', code: 'MFA_LOCKED', key: 'token', retryAfterSeconds: 300, retryable: false, message: 'Server sentence, English only.' },
  });
  /** The sentence the English file gives for a five-minute wait on the token key. */
  const lockText = () => {
    const template = english['refusal.mfaLocked.token.other'];
    expect(template, 'en.json has no refusal.mfaLocked.token.other').toBeTruthy();
    return template.replace('{{count}}', '5');
  };
  const setup = (api: Record<string, unknown>) => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [MfaComponent, getTranslocoModule({ translation: { en: english } })],
      providers: [{ provide: AuthApi, useValue: {
        getMfaStatus: () => of({ enabled: false }),
        setupMfa: () => of({ secret: 'JBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/Ythril:u@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Ythril' }),
        ...api,
      } as never }],
    });
    const fixture = TestBed.createComponent(MfaComponent);
    fixture.detectChanges();
    return fixture;
  };

  it('the enrolment confirm shows the lock with the wait, not "invalid" or "could not verify"', () => {
    const fixture = setup({ verifyMfaCode: () => throwError(() => locked()) });
    const cmp = fixture.componentInstance;
    cmp.startEnroll();
    cmp.confirmCode = '123456';
    cmp.confirmEnroll();
    fixture.detectChanges();
    expect(cmp.confirming()).toBe(false);
    expect(cmp.enrollError()).toBe(lockText());
    expect(cmp.enrollError()).not.toBe(english['mfa.error.verifyFailed']);
    expect(cmp.enrollError()).not.toBe(english['mfa.error.invalidCode']);
    expect(fixture.nativeElement.textContent).toContain(lockText());
    expect(cmp.state()).toBe('enrolling');
  });

  it('the disable shows the lock with the wait instead of staying silent, and disables nothing', () => {
    const fixture = setup({ getMfaStatus: () => of({ enabled: true }), disableMfa: () => throwError(() => locked()) });
    const cmp = fixture.componentInstance;
    cmp.startDisable();
    cmp.confirmDisable();
    fixture.detectChanges();
    expect(cmp.disabling()).toBe(false);
    expect(cmp.enabled()).toBe(true);
    expect(cmp.successMsg()).toBe('');
    expect(cmp.state()).toBe('disabling');
    expect(fixture.nativeElement.textContent).toContain(lockText());
  });

  it('a plain failure of the disable still shows no lock sentence', () => {
    const fixture = setup({ getMfaStatus: () => of({ enabled: true }), disableMfa: () => throwError(() => new HttpErrorResponse({ status: 500 })) });
    const cmp = fixture.componentInstance;
    cmp.startDisable();
    cmp.confirmDisable();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain(english['refusal.mfaLocked.token.other']?.replace('{{count}}', '5') ?? 'refusal.mfaLocked');
  });
});
