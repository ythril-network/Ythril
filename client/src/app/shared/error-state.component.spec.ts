import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component } from '@angular/core';
import { getTranslocoModule } from '../testing/transloco-testing';
import { ErrorStateComponent } from './error-state.component';

// Host to exercise inputs/outputs the way real call sites do.
@Component({
  standalone: true,
  imports: [ErrorStateComponent],
  template: `<app-error-state [message]="msg" [reason]="reason" (retry)="onRetry()" />`,
})
class HostComponent {
  msg = 'Couldn\'t load memories';
  reason = '';
  retried = 0;
  onRetry() { this.retried++; }
}

describe('ErrorStateComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function mount(over: Partial<HostComponent> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent, getTranslocoModule()] });
    const fixture = TestBed.createComponent(HostComponent);
    Object.assign(fixture.componentInstance, over);
    fixture.detectChanges();
    return fixture;
  }

  it('renders the message headline', () => {
    const el = mount().nativeElement as HTMLElement;
    expect(el.querySelector('.error-title')?.textContent).toContain("Couldn't load memories");
  });

  it('renders the reason when provided, and omits it when empty', () => {
    const withReason = mount({ reason: '500 Internal Server Error' }).nativeElement as HTMLElement;
    expect(withReason.querySelector('.error-reason')?.textContent).toContain('500 Internal Server Error');

    const withoutReason = mount({ reason: '' }).nativeElement as HTMLElement;
    expect(withoutReason.querySelector('.error-reason')).toBeNull();
  });

  it('always shows a Retry button and emits retry on click', () => {
    const fixture = mount();
    const el = fixture.nativeElement as HTMLElement;
    const btn = el.querySelector('.retry-btn') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.retried).toBe(1);
  });

  it('exposes role=alert so it is announced', () => {
    const el = mount().nativeElement as HTMLElement;
    expect(el.querySelector('[role="alert"]')).toBeTruthy();
  });
});
