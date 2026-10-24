/**
 * The order line of the Brain list tabs (bundle-81, decision 20): "Ordered by: most recently landed here" while no column sort chooses the order,
 * and nothing once a sort is chosen or a ranked search answers.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { RecordOrderLineComponent } from './record-order-line.component';

function line(inputs: { sortField?: string; ranked?: boolean }): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [RecordOrderLineComponent, getTranslocoModule()] });
  const f = TestBed.createComponent(RecordOrderLineComponent);
  for (const [name, value] of Object.entries(inputs)) f.componentRef.setInput(name, value);
  f.detectChanges();
  return (f.nativeElement as HTMLElement).textContent?.trim() ?? '';
}

describe('RecordOrderLineComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('names the landing order when no column sort is chosen', () => {
    expect(line({ sortField: '' })).toBe('brain.list.order.landing');
  });

  it('says nothing once a column sort is chosen, or while a ranked search answers', () => {
    expect(line({ sortField: 'createdAt' })).toBe('');
    expect(line({ sortField: '', ranked: true })).toBe('');
  });

  it('is on every Brain list tab: facts, chrono, entities and edges each carry it', () => {
    for (const tab of ['facts', 'chrono', 'entities', 'edges']) {
      const source = readFileSync(resolve(__dirname, `${tab}-tab.component.ts`), 'utf8');
      expect(source, `${tab}-tab.component.ts does not show the order line`).toContain('<app-record-order-line');
    }
  });
});
