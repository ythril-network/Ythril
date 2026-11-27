/**
 * Q-942: "Export RDF" with its format beside "Export JSON" on the Schema tab. With RDF names off it is disabled and the line says why and
 * leads to the RDF names card; on, it saves the schema in the chosen format; a refusal is worded from the dictionary.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaRdfExportComponent } from './schema-rdf-export.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { RdfExportRuns } from '../../core/rdf-export-runs.service';
import type { Space } from '../../core/api.types';

const en = JSON.parse(readFileSync(join(process.cwd(), 'public', 'assets', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;

async function setup(space: Partial<Space>, saveSchema = vi.fn().mockResolvedValue(null)) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SchemaRdfExportComponent, getTranslocoModule({ translation: { en } })],
    providers: [SpaceSettingsState, { provide: SpacesApi, useValue: { getSpaceStats: () => of({}) } }, { provide: RdfExportRuns, useValue: { saveSchema } }],
  });
  const state = TestBed.inject(SpaceSettingsState);
  state.openSettings({ id: 'platform', label: 'Platform', ...space } as Space);
  state.settingsTab.set('schema');
  const fixture = TestBed.createComponent(SchemaRdfExportComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const q = (id: string) => el.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { fixture, state, q, saveSchema };
}

describe('Schema tab, Export RDF', () => {
  it('RDF names off: the button and its format are disabled, the line says why and opens the RDF names card', async () => {
    const { q, state } = await setup({});
    expect(q('schema-rdf-export')?.textContent).toContain(en['rdf.schema.export']);
    expect((q('schema-rdf-export') as HTMLButtonElement).disabled).toBe(true);
    expect((q('schema-rdf-format') as HTMLSelectElement).disabled).toBe(true);
    expect(q('schema-rdf-export')?.getAttribute('aria-describedby')).toBe('schema-rdf-off');
    expect(q('schema-rdf-off')?.textContent).toContain(en['rdf.schema.off']);
    const focus = state.rdfFocus();
    (q('schema-rdf-open-names') as HTMLButtonElement).click();
    expect(state.settingsTab()).toBe('settings');
    expect(state.rdfFocus()).toBe(focus + 1);
  });

  it('RDF names on: the format offers Turtle and JSON-LD, and the export saves the schema in the chosen one', async () => {
    const { fixture, q, saveSchema } = await setup({ meta: { rdf: { enabled: true, base: 'https://w3id.org/acme/platform/' } } });
    const select = q('schema-rdf-format') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(['turtle', 'jsonld']);
    expect([...select.options].map(o => o.textContent?.trim())).toEqual([en['rdf.format.turtle'], en['rdf.format.jsonld']]);
    select.value = 'jsonld';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (q('schema-rdf-export') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(saveSchema).toHaveBeenCalledWith('platform', 'jsonld');
  });

  it('a refused export is worded from the dictionary', async () => {
    const refused = vi.fn().mockResolvedValue({ status: 409, error: { error: 'Space has an RDF base that a network contests ...', code: 'rdf_base_conflict' } });
    const { fixture, q } = await setup({ meta: { rdf: { enabled: true, base: 'https://w3id.org/acme/platform/' } } }, refused);
    (q('schema-rdf-export') as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(q('schema-rdf-refusal')?.textContent).toContain(en['rdf.refusal.rdf_base_conflict']);
  });
});
