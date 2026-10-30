/**
 * A token's requests-per-minute limit, edited on the token (Q-473).
 *
 * ## What this is about
 *
 * The limit could be set only while minting, so lowering a bulk client's quota meant revoking its token and
 * minting a replacement. The server takes the field on PATCH (and `null` to clear it back to the instance
 * value); this is the client half. The decisions worth holding are the ones around the input, not that one exists:
 *
 *  1. **Prefilled with the token's OWN value.** `rateLimitEffective` is what the token is held to now, which for
 *     a token that inherits is the instance value. Prefilling that would turn "inherit" into a pinned number on
 *     the next save.
 *  2. **Only a change is sent.** A token that inherits and is saved for another reason keeps inheriting: the field
 *     is absent from the body, not `null`, and not the number it happens to inherit.
 *  3. **Emptying a set value sends `null`.** That is the only way to say "inherit again"; omitting the field would
 *     leave the old number in place.
 *  4. **A refusal shows the server's words.** 403 (above the instance ceiling) and 400 (not a whole number, outside
 *     1..1000000) both carry a sentence in `error`; the dialog stays open on it.
 *
 * Run: npx vitest run src/app/pages/settings/token-editor-rate-limit.spec.ts
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { TokenRightsDialogComponent } from './token-rights-dialog.component';

const RIGHTS = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} };

function make(token: Record<string, unknown>, update?: ReturnType<typeof vi.fn>) {
  const updateSpy = update ?? vi.fn().mockReturnValue(of({ token: { ...token, name: 'saved' } }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [TokenRightsDialogComponent, getTranslocoModule()],
    providers: [{ provide: AuthApi, useValue: { updateToken: updateSpy } as any }],
  });
  const fixture = TestBed.createComponent(TokenRightsDialogComponent);
  fixture.componentRef.setInput('token', { id: 't1', name: 'CI', rights: RIGHTS, ...token });
  fixture.componentRef.setInput('availableSpaces', []);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any, updateSpy };
}

/** Type into the real input, the way an operator does, so the binding is what is tested rather than a field name. */
async function typeInto(fixture: any, value: string): Promise<HTMLInputElement> {
  await fixture.whenStable();
  const input = fixture.nativeElement.querySelector('#tokenRateLimit') as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
  await fixture.whenStable();
  return input;
}

const sentBody = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls[0][1] as { rateLimitPerMinute?: number | null };

describe('the token editor: requests per minute', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is prefilled with the token\'s own limit', async () => {
    const { fixture } = make({ rateLimitPerMinute: 120, rateLimitEffective: 120 });
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('#tokenRateLimit') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('120');
  });

  it('is empty for a token that inherits, even though it is held to the instance value', async () => {
    const { fixture } = make({ rateLimitEffective: 600 });
    await fixture.whenStable();
    const input = fixture.nativeElement.querySelector('#tokenRateLimit') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe('');
  });

  it('a changed number is sent as that number', async () => {
    const { fixture, c, updateSpy } = make({ rateLimitPerMinute: 120 });
    await typeInto(fixture, '60');
    c.save();
    expect(sentBody(updateSpy).rateLimitPerMinute).toBe(60);
  });

  it('a number set on a token that inherited is sent', async () => {
    const { fixture, c, updateSpy } = make({});
    await typeInto(fixture, '30');
    c.save();
    expect(sentBody(updateSpy).rateLimitPerMinute).toBe(30);
  });

  it('a previously set value that is emptied sends null', async () => {
    const { fixture, c, updateSpy } = make({ rateLimitPerMinute: 120 });
    await typeInto(fixture, '');
    c.save();
    expect('rateLimitPerMinute' in sentBody(updateSpy)).toBe(true);
    expect(sentBody(updateSpy).rateLimitPerMinute).toBeNull();
  });

  it('an unchanged value is not sent', () => {
    const { c, updateSpy } = make({ rateLimitPerMinute: 120 });
    c.save();
    expect('rateLimitPerMinute' in sentBody(updateSpy)).toBe(false);
  });

  it('a token that inherits and is saved for another reason keeps inheriting', () => {
    const { c, updateSpy } = make({ rateLimitEffective: 600 });
    c.save();
    expect('rateLimitPerMinute' in sentBody(updateSpy)).toBe(false);
  });

  it('a 403 above the instance ceiling shows the server\'s text and keeps the dialog open', async () => {
    const text = 'rateLimitPerMinute 5000 is above this instance\'s ceiling of 1000';
    const refuse = vi.fn().mockReturnValue(throwError(() => ({ status: 403, error: { error: text } })));
    const { fixture, c } = make({ rateLimitPerMinute: 120 }, refuse);
    const closed: unknown[] = [];
    c.close.subscribe(() => closed.push(1));
    await typeInto(fixture, '5000');
    c.save();
    fixture.detectChanges();
    expect(c.error()).toBe(text);
    expect(fixture.nativeElement.querySelector('.form-error')?.textContent).toContain(text);
    expect(c.saving()).toBe(false);
    expect(closed).toHaveLength(0);
  });

  it('a 400 for a malformed value shows the server\'s text and keeps the dialog open', async () => {
    const text = 'rateLimitPerMinute must be a whole number from 1 to 1000000';
    const refuse = vi.fn().mockReturnValue(throwError(() => ({ status: 400, error: { error: text } })));
    const { fixture, c } = make({ rateLimitPerMinute: 120 }, refuse);
    const closed: unknown[] = [];
    c.close.subscribe(() => closed.push(1));
    await typeInto(fixture, '2.5');
    c.save();
    fixture.detectChanges();
    expect(c.error()).toBe(text);
    expect(fixture.nativeElement.querySelector('.form-error')?.textContent).toContain(text);
    expect(c.saving()).toBe(false);
    expect(closed).toHaveLength(0);
  });
});
