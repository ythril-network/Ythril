/**
 * The Brain landing of a type's history (design r4 §5.4, test C4), one set of cases run by each of the four record tabs' specs.
 *
 * Each tab is mounted over the REAL `BrainApi` and `SchemaApi` on a fake HTTP backend, with the route's query parameters set the
 * way the history dialog's Open links set them (`type=T&definition=older` or `definition=sameAs:<fp>`). What is fixed is the wire
 * (the list's `/api/filter` body, the ONE `fps` read per page) and what the operator sees (the chips, the column, the note).
 *
 * The cases are one module because the four tabs answer one rule; each spec calls `definitionFilterCases` with its tab, so a tab
 * that drops the rule fails in its own spec.
 *
 * ## The contract this fixes for the build (chosen here and listed in the hand-off)
 *
 * - The list body carries `schemaVersion: 'older', schemaChanged: 'any'` for `definition=older`, and `schemaVersion: 'sameAs:<fp>'`
 *   for `definition=sameAs:<fp>`, beside the deep-linked `type`.
 * - The chips say `brain.filter.typeDefinitionOlder` (or the span) and offer `brain.filter.historyOf`.
 * - The column headed `brain.list.typeDefinitionColumn` shows only while a definition filter is set, and is filled by one
 *   `GET /api/spaces/:id/schema-versions?fps=<the page's distinct stamps>&kind=&type=` per page; an unstamped row reads
 *   `brain.drawer.typeDefinition.none` and asks nothing; `notHeld` reads `brain.drawer.typeDefinition.cannotTell`.
 * - A server that refuses `sameAs:` with 400 shows `brain.filter.cannotFilterByDefinition`.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import type { Type } from '@angular/core';
import { describe, it, expect, afterEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from './transloco-testing';
import { BrainStore } from '../pages/brain/brain-store.service';
import { EntityRefPicker } from '../pages/brain/entity-ref-picker.service';
import { RecordDrawerState } from '../pages/brain/record-drawer-state.service';
import { RecordListState } from '../pages/brain/record-list-state.service';
import { ConfirmDialogService } from '../core/confirm-dialog.service';

export interface DefinitionFilterTab {
  /** The tab component. */
  component: Type<unknown>;
  /** Its knowledge kind as the versions door names it. */
  kind: 'entity' | 'fact' | 'edge' | 'chrono';
  /** Its `filter` collection. */
  collection: 'entities' | 'facts' | 'edges' | 'chrono';
  /** One record of the tab, with its type and, when given, its stamp. */
  record: (i: number, type: string, fp?: string) => object;
}

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

export function definitionFilterCases(tab: DefinitionFilterTab): void {
  const mount = (params: Record<string, string>) => {
    TestBed.resetTestingModule();
    const map = convertToParamMap(params);
    TestBed.configureTestingModule({
      imports: [tab.component, getTranslocoModule()],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: map, queryParams: params }, queryParamMap: of(map), queryParams: of(params) } },
        RecordListState, BrainStore, EntityRefPicker, RecordDrawerState,
        { provide: ConfirmDialogService, useValue: { confirm: async () => true } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(tab.component);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();
    const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
    return { fixture, http, el: fixture.nativeElement as HTMLElement, settle };
  };
  type Mounted = ReturnType<typeof mount>;

  /** The pending list reads of this tab's collection. */
  const listReads = (m: Mounted): TestRequest[] =>
    m.http.match(r => r.method === 'POST' && r.url === '/api/filter' && (r.body as Record<string, unknown>)?.['collection'] === tab.collection);
  /** Answers every other `/api/filter` read (links, lookups) empty, so the tab's own page can render. */
  const answerOthers = (m: Mounted) => {
    for (const r of m.http.match(q => q.method === 'POST' && q.url === '/api/filter' && (q.body as Record<string, unknown>)?.['collection'] !== tab.collection)) {
      r.flush({ ok: true, data: { results: [], total: 0, limit: 20, skip: 0, truncated: false } });
    }
  };
  /** The list read, answered with `rows`; returns its body. */
  const answerList = async (m: Mounted, rows: object[]): Promise<Record<string, unknown>> => {
    await m.settle();
    const reads = listReads(m);
    expect(reads.length, `the tab made no ${tab.collection} list read`).toBeGreaterThan(0);
    const body = reads.at(-1)!.request.body as Record<string, unknown>;
    for (const r of reads) r.flush({ ok: true, data: { results: rows, total: rows.length, limit: 20, skip: 0, truncated: false } });
    answerOthers(m);
    await m.settle();
    answerOthers(m);
    await m.settle();
    return body;
  };
  const versionReads = (m: Mounted) => m.http.match(r => r.method === 'GET' && r.url.split('?')[0] === '/api/spaces/work/schema-versions').map(req => {
    const p: Record<string, string> = {};
    for (const k of req.request.params.keys()) p[k] = req.request.params.get(k)!;
    const q = req.request.urlWithParams.split('?')[1];
    if (q) for (const [k, v] of new URLSearchParams(q)) p[k] = v;
    return { req, p };
  });
  /** The column's cells, by the header's position, one per body row. */
  const column = (el: HTMLElement): string[] | null => {
    const heads = Array.from(el.querySelectorAll<HTMLElement>('thead th'));
    const at = heads.findIndex(h => h.textContent?.includes('brain.list.typeDefinitionColumn'));
    if (at < 0) return null;
    return Array.from(el.querySelectorAll<HTMLElement>('tbody tr')).map(tr => tr.querySelectorAll('td')[at]?.textContent?.trim() ?? '');
  };

  describe(`the ${tab.collection} tab lands on a type's definition (b268, C4, design r4 §5.4)`, () => {
    afterEach(() => { document.body.innerHTML = ''; });

    it('type=T&definition=older asks the list for T\'s records not on the current definition', async () => {
      const m = mount({ type: 'person', definition: 'older' });
      const body = await answerList(m, []);
      expect(body).toMatchObject({ type: 'person', schemaVersion: 'older', schemaChanged: 'any' });
    });

    it('definition=sameAs:<fp> asks the list for the records saved under that definition', async () => {
      const m = mount({ type: 'person', definition: `sameAs:${FP_A}` });
      const body = await answerList(m, []);
      expect(body).toMatchObject({ type: 'person', schemaVersion: `sameAs:${FP_A}` });
    });

    it('the chips name the type and "not current", and offer the way back to the history', async () => {
      const m = mount({ type: 'person', definition: 'older' });
      await answerList(m, []);
      expect(m.el.textContent).toContain('brain.filter.typeDefinitionOlder');
      const back = Array.from(m.el.querySelectorAll<HTMLElement>('a, button')).find(b => b.textContent?.includes('brain.filter.historyOf'));
      expect(back, 'no "History of {type}" link').toBeDefined();
      const remove = m.el.querySelector<HTMLElement>('[aria-label="brain.filter.removeDefinitionAria"]');
      expect(remove?.tagName, 'the definition chip cannot be removed').toBe('BUTTON');
    });

    it('under a definition filter the column is shown and filled by ONE fps read for the page\'s distinct stamps', async () => {
      const m = mount({ type: 'person', definition: 'older' });
      await answerList(m, [tab.record(1, 'person', FP_A), tab.record(2, 'person', FP_B), tab.record(3, 'person', FP_A), tab.record(4, 'person')]);
      const reads = versionReads(m);
      expect(reads.length, 'not one fps read for the page').toBe(1);
      const { req, p } = reads[0]!;
      expect(p['kind']).toBe(tab.kind);
      expect(p['type']).toBe('person');
      expect((p['fps'] ?? '').split(',').sort()).toEqual([FP_A, FP_B]);
      req.flush({ kind: tab.kind, type: 'person', current: FP_A, standings: [
        { fp: FP_A, standing: 'current', definition: { rep: FP_A, since: '2026-11-03T08:00:00.000Z' } },
        { fp: FP_B, standing: 'notHeld' },
      ] });
      await m.settle();
      const cells = column(m.el);
      expect(cells, 'no Type definition column under a definition filter').not.toBeNull();
      expect(cells!.length).toBe(4);
      expect(cells![0]).toContain('spaces.schema.history.current');
      expect(cells![1]).toContain('brain.drawer.typeDefinition.cannotTell');
      expect(cells![2]).toContain('spaces.schema.history.current');
      expect(cells![3]).toContain('brain.drawer.typeDefinition.none');
      expect(versionReads(m), 'a second read for the same page').toEqual([]);
    });

    it('without a definition filter there is no column and no fps read; ?type= alone still narrows by type only', async () => {
      const m = mount({ type: 'person' });
      const body = await answerList(m, [tab.record(1, 'person', FP_A)]);
      expect(body['schemaVersion']).toBeUndefined();
      expect(column(m.el)).toBeNull();
      expect(versionReads(m)).toEqual([]);
    });

    it('a server that refuses sameAs: says this instance cannot filter by definition yet', async () => {
      const m = mount({ type: 'person', definition: `sameAs:${FP_A}` });
      await m.settle();
      const reads = listReads(m);
      expect(reads.length).toBeGreaterThan(0);
      for (const r of reads) r.flush({ ok: false, error: 'schemaVersion must be current, older, unversioned or a schema fingerprint (64 lowercase hex characters).' }, { status: 400, statusText: 'Bad Request' });
      answerOthers(m);
      await m.settle();
      expect(m.el.textContent).toContain('brain.filter.cannotFilterByDefinition');
    });
  });
}
