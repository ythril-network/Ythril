import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { getTranslocoModule } from '../testing/transloco-testing';
import { SupersededBadgeComponent } from './superseded-badge.component';

/**
 * The badge appears for `true` and for nothing else.
 *
 * Both directions matter and only one of them is loud. A missing badge leaves a retired record looking
 * current in a list, which is the defect `Q-36` is about; a badge on a CURRENT record retires a real fact
 * in the reader's mind and nothing ever contradicts it.
 *
 * `undefined` is the common case by a wide margin — almost no record is superseded — so it is asserted as
 * its own case rather than assumed to behave like `false`.
 */
@Component({
  standalone: true,
  imports: [SupersededBadgeComponent],
  template: `<app-superseded-badge [superseded]="value" />`,
})
class Host { value: boolean | undefined = undefined; }

describe('SupersededBadgeComponent', () => {
  const render = (value: boolean | undefined) => {
    TestBed.configureTestingModule({ imports: [Host, getTranslocoModule()] });
    const f = TestBed.createComponent(Host);
    f.componentInstance.value = value;
    f.detectChanges();
    return f.nativeElement.textContent?.trim() ?? '';
  };

  it('shows the badge when the record is superseded', () => {
    expect(render(true)).toContain('brain.superseded.badge');
  });

  it('shows nothing when the record carries no mark', () => {
    expect(render(undefined)).toBe('');
  });

  it('shows nothing for an explicit false', () => {
    // `false` and absent both mean current. A component that badged on "not undefined" would mark every
    // record any code path had ever written the field to.
    expect(render(false)).toBe('');
  });
});
