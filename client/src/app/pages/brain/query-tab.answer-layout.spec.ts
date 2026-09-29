/**
 * The Query tab after a search answers (`Q-158`).
 *
 * Owner, 2026-09-29: *"on results summary add a duration. when results are returned collapse the search to one
 * line. allow for an expand all on results."* The form is eleven fields tall, so the answer started below the fold;
 * how long the search took was nowhere; and Expand all existed only in the JSON view, where it was least needed.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { QueryTabComponent } from './query-tab.component';
import { JsonTreeComponent } from '../../shared/json-tree.component';

const hit = (id: string) => ({ type: 'entity', score: 0.9, spaceId: 'work', record: { _id: id, name: id, type: 'thing', properties: { a: 1 } } });

function create() {
  TestBed.configureTestingModule({
    imports: [QueryTabComponent, getTranslocoModule()],
    providers: [BrainStore, { provide: BrainApi, useValue: { recallBrain: () => of({ results: [hit('e1'), hit('e2')], count: 2 }) } }],
  });
  const fixture = TestBed.createComponent(QueryTabComponent);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges();
  const c = fixture.componentInstance;
  c.recallForm.query = 'vault';
  c.runRecall();
  fixture.detectChanges();
  return { fixture, c, el: fixture.nativeElement as HTMLElement };
}

describe('the Query tab after a search answers (Q-158)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('says how long the search took', () => {
    const { el, c } = create();
    expect(c.recallTookMs(), 'the duration is measured').not.toBeNull();
    expect(el.querySelector('.query-answer-duration'), 'the results summary shows it').toBeTruthy();
  });

  it('folds the search form to one line that still shows the question, and reopens it on request', () => {
    const { el, fixture } = create();
    expect(el.querySelector('app-recall-form'), 'the full form is folded away').toBeNull();
    const line = el.querySelector('.recall-form-collapsed') as HTMLElement;
    expect(line, 'a one-line search is shown instead').toBeTruthy();
    expect((line.querySelector('input') as HTMLInputElement).value).toBe('vault');
    (line.querySelector('.recall-form-expand') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('app-recall-form'), 'the full form comes back').toBeTruthy();
  });

  it('Expand all opens every record in the rendered view, not only the JSON tree', () => {
    const { el, fixture } = create();
    const expand = el.querySelector('.query-answer-expand') as HTMLButtonElement;
    expect(expand, 'the rendered view offers Expand all').toBeTruthy();
    const trees = fixture.debugElement.queryAll(d => d.componentInstance instanceof JsonTreeComponent)
      .map(d => d.componentInstance as JsonTreeComponent);
    expect(trees.length).toBeGreaterThan(1);
    let opened = 0;
    for (const t of trees) { const orig = t.expandAll.bind(t); t.expandAll = () => { opened++; orig(); }; }
    expand.click();
    expect(opened, 'every record tree on screen is expanded').toBe(trees.length);
  });
});
