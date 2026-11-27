/**
 * Q-942: the "RDF export" panel of a space's and a view's Overview as layout D draws it: the format (four for a space, three for a view),
 * edge details locked to the classic form for JSON-LD, the running state (fields locked, Stop, a status), the finished export with the
 * values it left out and their reasons in words, a refused "Export again" beside the result it keeps, and a view with no RDF member listing
 * each space with "Open RDF names".
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { RdfExportPanelComponent } from './rdf-export-panel.component';
import { RdfExportRuns, type RdfExportRun } from '../../core/rdf-export-runs.service';
import type { Space } from '../../core/api.types';

const en = JSON.parse(readFileSync(join(process.cwd(), 'public', 'assets', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
const ON = (id: string, label = id): Space => ({ id, label, meta: { rdf: { enabled: true, base: `https://w3id.org/acme/${id}/` } } } as Space);
const OFF = (id: string, label = id): Space => ({ id, label } as Space);

const DONE: RdfExportRun = {
  running: false, format: 'turtle', file: 'platform.ttl', bytes: 61_760_000,
  result: { file: 'platform.ttl', bytes: 61_760_000, complete: true, records: 131442, leftOutCount: 3, withoutRdf: [], inConflict: [], leftOut: [
    { record: 'svc-billing', key: 'owners', reason: 'notPlain', reasonText: 'not a plain value' },
    { record: 'f-2291', key: 'observedAt', reason: 'notFit', reasonText: 'does not fit its declared type' },
    { record: 'c-118', key: 'budget', reason: 'other', reasonText: 'something new' },
  ] },
};

function setup(o: { id?: string; isView?: boolean; members?: Space[]; run?: RdfExportRun }) {
  const id = o.id ?? 'platform';
  const runs = signal<Record<string, RdfExportRun>>(o.run ? { [id]: o.run } : {});
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RdfExportPanelComponent, getTranslocoModule({ translation: { en } })],
    providers: [{ provide: RdfExportRuns, useValue: { runs, start, stop } }],
  });
  const fixture = TestBed.createComponent(RdfExportPanelComponent);
  fixture.componentRef.setInput('subjectId', id);
  fixture.componentRef.setInput('label', id);
  fixture.componentRef.setInput('isView', o.isView ?? false);
  fixture.componentRef.setInput('members', o.members ?? [ON('platform', 'Platform Knowledge')]);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (t: string) => el.querySelector(`[data-testid="${t}"]`) as HTMLElement | null;
  return { fixture, el, q, runs, start, stop };
}

describe('RDF export panel', () => {
  it('a space is offered Turtle, TriG, N-Quads and JSON-LD, and Export RDF starts it with the chosen format and edge details', () => {
    const { q, start, fixture } = setup({});
    const format = q('rdf-export-format') as HTMLSelectElement;
    expect([...format.options].map(o => o.value)).toEqual(['turtle', 'trig', 'nquads', 'jsonld']);
    expect(q('rdf-export-go')?.textContent).toContain(en['rdf.export.go']);
    format.value = 'nquads';
    format.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (q('rdf-export-go') as HTMLButtonElement).click();
    expect(start).toHaveBeenCalledWith('platform', 'nquads', 'rdf12');
  });

  it('JSON-LD carries edge details only as classic reification: the choice is locked to it', () => {
    const { q, start, fixture } = setup({});
    const format = q('rdf-export-format') as HTMLSelectElement;
    format.value = 'jsonld';
    format.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect((q('rdf-export-edges') as HTMLSelectElement).disabled).toBe(true);
    (q('rdf-export-go') as HTMLButtonElement).click();
    expect(start).toHaveBeenCalledWith('platform', 'jsonld', 'reification');
  });

  it('a view is offered TriG, N-Quads and JSON-LD only (Turtle holds one graph)', () => {
    const { q } = setup({ id: '@research', isView: true, members: [ON('a'), ON('b')] });
    expect([...(q('rdf-export-format') as HTMLSelectElement).options].map(o => o.value)).toEqual(['trig', 'nquads', 'jsonld']);
  });

  it('running: the fields are locked, the run is a status with its file and size, and Stop stops it', () => {
    const { q, stop } = setup({ run: { running: true, format: 'turtle', file: 'platform.ttl', bytes: 22_439_526 } });
    expect((q('rdf-export-format') as HTMLSelectElement).disabled).toBe(true);
    expect((q('rdf-export-edges') as HTMLSelectElement).disabled).toBe(true);
    expect(q('rdf-export-running')?.getAttribute('role')).toBe('status');
    expect(q('rdf-export-running')?.textContent).toContain('platform.ttl');
    expect(q('rdf-export-running')?.textContent).toContain('21.4 MB');
    expect(q('rdf-export-pill')?.textContent).toContain(en['rdf.export.pill.running']);
    (q('rdf-export-stop') as HTMLButtonElement).click();
    expect(stop).toHaveBeenCalledWith('platform');
  });

  it('done: the result names the file, records and size, and the values left out with each reason in words', () => {
    const { q, el } = setup({ run: DONE });
    expect(q('rdf-export-result')?.textContent).toContain('platform.ttl');
    expect(q('rdf-export-result')?.textContent).toContain('131442');
    expect(q('rdf-export-left-count')?.textContent).toContain('3');
    const rows = [...el.querySelectorAll('[data-testid="rdf-export-left-table"] tbody tr')].map(r => r.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(en['rdf.export.reason.notPlain']);
    expect(rows[1]).toContain(en['rdf.export.reason.notFit']);
    expect(rows[2]).toContain('something new');
    expect(q('rdf-export-go')?.textContent).toContain(en['rdf.export.again']);
    expect(el.classList.contains('span-all')).toBe(true);
  });

  it('a refused "Export again" is worded from the dictionary beside the result it keeps', () => {
    const { q } = setup({ run: { ...DONE, failure: { status: 429, error: { error: 'Two exports already run', code: 'rdf_export_busy' } } } });
    expect(q('rdf-export-refusal')?.textContent).toContain(en['rdf.refusal.rdf_export_busy']);
    expect(q('rdf-export-result')).not.toBeNull();
  });

  it('a view whose member spaces it left out names them, with why', () => {
    const run: RdfExportRun = { ...DONE, result: { ...DONE.result!, withoutRdf: ['scratch'], inConflict: ['lab'] } };
    const { q } = setup({ id: '@research-all', isView: true, members: [ON('platform'), OFF('scratch', 'Scratch'), ON('lab', 'Lab notebook')], run });
    const left = q('rdf-export-members-left')?.textContent ?? '';
    expect(left).toContain('Scratch');
    expect(left).toContain(en['rdf.export.whyOff']);
    expect(left).toContain('Lab notebook');
    expect(left).toContain(en['rdf.export.whyConflict']);
  });

  it('a view with no member that has RDF names lists each space with "Open RDF names"', () => {
    const { q, el, fixture } = setup({ id: '@drafts', isView: true, members: [OFF('field-notes', 'Field notes'), OFF('scratch', 'Scratch')] });
    expect(q('rdf-export-go')).toBeNull();
    expect(q('rdf-export-empty')?.textContent).toContain('@drafts');
    const opens = [...el.querySelectorAll('[data-testid="rdf-export-open-names"]')] as HTMLButtonElement[];
    expect(opens).toHaveLength(2);
    let opened: Space | undefined;
    fixture.componentInstance.openNames.subscribe(s => (opened = s));
    opens[1]!.click();
    expect(opened?.id).toBe('scratch');
  });
});
