/**
 * GraphLinkedRecordsComponent — the memory/chrono lists under a node or edge side panel.
 *
 * This block was rendered TWICE in `graph.component.ts`, byte-identical apart from its two
 * empty-state translation keys, and **nothing tested it**. The 45 graph characterization tests set
 * `nodeMemories`/`nodeChrono` and assert on the SIGNALS; not one asserts a row ever reached the DOM.
 * So the copies could have diverged — or the extraction could have dropped a list — with a fully
 * green suite. These tests close that hole.
 *
 * The empty-state key is deliberately an INPUT: a node with no facts and an edge whose endpoints
 * share none are different sentences. The test below asserts the INPUT is used rather than a
 * hard-coded key, because collapsing the two copies is exactly when that distinction gets lost.
 * (`getTranslocoModule()` ships an empty dictionary, so a key renders as itself — which is what makes
 * "which key did it use?" observable at all.)
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { Component, signal } from '@angular/core';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { GraphLinkedRecordsComponent } from './graph-linked-records.component';
import { DetailRef } from './graph-details';
import { isOnPush } from '../../testing/onpush';

@Component({
  standalone: true,
  imports: [GraphLinkedRecordsComponent],
  template: `
    <app-graph-linked-records
      [facts]="mems()"
      [chrono]="chrono()"
      [(typeFilter)]="typeFilter"
      [(descFilter)]="descFilter"
      [emptyMemoriesKey]="'graph.panel.noMemories'"
      [emptyChronoKey]="'graph.panel.noChronoEntries'"
      (open)="opened.push($event)" />
  `,
})
class Host {
  mems = signal<any[]>([]);
  chrono = signal<any[]>([]);
  typeFilter = signal<'all' | 'fact' | 'chrono'>('all');
  descFilter = signal('');
  opened: DetailRef[] = [];
}

describe('GraphLinkedRecordsComponent', () => {
  function create() {
    TestBed.configureTestingModule({ imports: [Host, getTranslocoModule()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(GraphLinkedRecordsComponent)).toBe(true);
  });

  it('renders one row per memory AND one per chrono entry', () => {
    const fixture = create();
    fixture.componentInstance.mems.set([
      { _id: 'm1', fact: 'first fact', createdAt: '2026-01-01' },
      { _id: 'm2', fact: 'second fact', createdAt: '2026-01-02' },
    ]);
    fixture.componentInstance.chrono.set([{ _id: 'c1', title: 'a milestone', startsAt: '2026-02-01' }]);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.list-row');
    // 3, not 2: a splice that dropped one of the two sections would still render rows.
    expect(rows.length, 'both sections must render').toBe(3);
    expect(fixture.nativeElement.textContent).toContain('first fact');
    expect(fixture.nativeElement.textContent).toContain('a milestone');
  });

  it('falls back to the description when a memory has no fact', () => {
    const fixture = create();
    fixture.componentInstance.mems.set([{ _id: 'm1', description: 'only a description', createdAt: '2026-01-01' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.list-row-text').textContent).toContain('only a description');
  });

  it('emits the clicked row as a DetailRef, tagged with the right kind', () => {
    const fixture = create();
    const host = fixture.componentInstance;
    host.mems.set([{ _id: 'm1', fact: 'f', createdAt: '2026-01-01' }]);
    host.chrono.set([{ _id: 'c1', title: 't', startsAt: '2026-01-01' }]);
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.list-row');
    rows[0].click();
    rows[1].click();

    // The kind decides which endpoint the parent fetches; swapping them would open the wrong record.
    expect(host.opened).toEqual([{ id: 'm1', kind: 'fact' }, { id: 'c1', kind: 'chrono' }]);
  });

  it('shows the empty state from its INPUT key, per list', () => {
    const fixture = create();
    const empties = [...fixture.nativeElement.querySelectorAll('.list-empty')].map((e: any) => e.textContent.trim());
    // Both lists empty → both keys, in order. A hard-coded key would show the same text twice.
    expect(empties).toEqual(['graph.panel.noMemories', 'graph.panel.noChronoEntries']);
  });

  it('actually RENDERS the filter controls', () => {
    // The bug being fixed was filter logic that existed, was tested, and was reachable by nobody —
    // no control was ever bound to it. Driving the signals in a test reproduces that blind spot
    // exactly, so this asserts the controls are in the DOM. Mutation-checked: hiding the bar fails here
    // and nowhere else.
    const fixture = create();
    const select = fixture.nativeElement.querySelector('.detail-filters select');
    const input = fixture.nativeElement.querySelector('.detail-filters input');
    expect(select, 'the type filter must be reachable').toBeTruthy();
    expect(input, 'the description filter must be reachable').toBeTruthy();
    expect([...select.options].map((o: any) => o.value)).toEqual(['all', 'fact', 'chrono']);
  });

  it('writes the user\'s typing back to the bound filter state', () => {
    // A control that renders but is bound to nothing looks identical to a working one.
    const fixture = create();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('.detail-filters input');
    input.value = 'alpha';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.componentInstance.descFilter()).toBe('alpha');
  });

  it('counts each list independently in its header chip', () => {
    const fixture = create();
    fixture.componentInstance.mems.set([{ _id: 'm1', fact: 'f', createdAt: '2026-01-01' }]);
    fixture.componentInstance.chrono.set([
      { _id: 'c1', title: 't', startsAt: '2026-01-01' },
      { _id: 'c2', title: 'u', startsAt: '2026-01-02' },
    ]);
    fixture.detectChanges();

    const chips = [...fixture.nativeElement.querySelectorAll('.count-chip')].map((e: any) => e.textContent.trim());
    // 1 then 2 — a chip reading the other list's length would still be a plausible-looking number.
    expect(chips).toEqual(['1', '2']);
  });
});
