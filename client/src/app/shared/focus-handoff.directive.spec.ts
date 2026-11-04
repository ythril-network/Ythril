/**
 * The focus handoff keeps the keyboard on the page when a control is replaced by a transient box, and gives it to the answer (Q-209, bundle-231).
 *
 * What the directive owes (`focus-handoff.directive.ts`):
 *
 *  - the box appears while the element that had the focus is removed by the same change: the box takes the focus;
 *  - the box goes while the focus is on <body>: the focus goes to the first element the selector finds in the box's parent, in document order
 *    (an error's Retry before the canvas, the canvas when there is no error);
 *  - the focus is never taken from an element that stays on the page, and never moved over a choice the user made while the box showed.
 *
 * The page's own use of it is asserted through the graph (`graph.component.retry.spec.ts`); this holds the directive's rules on a bare host.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FocusHandoffDirective } from './focus-handoff.directive';

@Component({
  standalone: true,
  imports: [FocusHandoffDirective],
  template: `
    <div id="zone">
      @if (showBox()) { <div id="box" tabindex="-1" appFocusHandoff=".answer, .fallback"></div> }
      @if (showControl()) { <button id="control" type="button">go</button> }
      @if (showAnswer()) { <button class="answer" type="button">answer</button> }
      <div class="fallback" tabindex="-1"></div>
      <button id="other" type="button">other</button>
    </div>`,
})
class HostComponent {
  readonly showBox = signal(false);
  readonly showControl = signal(true);
  readonly showAnswer = signal(false);
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function mount() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  const host = fixture.componentInstance;
  const q = <T extends HTMLElement>(sel: string) => (fixture.nativeElement as HTMLElement).querySelector<T>(sel);
  /** The control is pressed: it goes, and the box that replaces it comes, in one change. */
  const press = async () => { host.showControl.set(false); host.showBox.set(true); fixture.detectChanges(); await tick(); await tick(); };
  /** The box goes, as the load it stood for ends. */
  const finish = async (answer: boolean) => { host.showBox.set(false); host.showAnswer.set(answer); fixture.detectChanges(); await tick(); await tick(); };
  return { fixture, host, q, press, finish };
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => { (document.activeElement as HTMLElement | null)?.blur(); document.body.replaceChildren(); });

describe('the focus handoff', () => {
  it('a box that replaces the focused control takes the focus', async () => {
    const { q, press } = mount();
    q('#control')!.focus();
    expect(document.activeElement).toBe(q('#control'));
    await press();
    expect(document.activeElement, 'the box holds the focus the control left').toBe(q('#box'));
  });

  it('when the box goes the focus goes to the first match of the selector in its parent: the answer when there is one', async () => {
    const { q, press, finish } = mount();
    q('#control')!.focus();
    await press();
    await finish(true);
    expect(document.activeElement, 'the answer, which comes before the fallback in the parent').toBe(q('.answer'));
  });

  it('and to the next match when there is no answer: the fallback', async () => {
    const { q, press, finish } = mount();
    q('#control')!.focus();
    await press();
    await finish(false);
    expect(document.activeElement).toBe(q('.fallback'));
  });

  it('a box that appears while the focus stays on an element that stays does not take it, and hands nothing on when it goes', async () => {
    const { q, host, fixture, finish } = mount();
    q('#other')!.focus();
    host.showBox.set(true);
    fixture.detectChanges();
    await tick(); await tick();
    expect(document.activeElement, 'the element that stays keeps the focus').toBe(q('#other'));
    await finish(true);
    expect(document.activeElement, 'nothing was replaced, so nothing is handed on').toBe(q('#other'));
  });

  it('a choice the user made while the box showed is not overridden when it goes', async () => {
    const { q, press, finish } = mount();
    q('#control')!.focus();
    await press();
    q('#other')!.focus();
    await finish(true);
    expect(document.activeElement, 'the user moved on; the handoff leaves them there').toBe(q('#other'));
  });
});
