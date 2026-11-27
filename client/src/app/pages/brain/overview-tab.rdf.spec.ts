/**
 * Q-942: the RDF screens' ways in from the Brain page sit where the nearest features sit: the "RDF export" panel in the Overview's panel
 * grid (where Reindex sits), the Overview's Networks panel says a base conflict in one line linking to the RDF names card, a view's Overview
 * carries the same panel under its card, and the Schema tab's "Export RDF" sits beside "Export JSON".
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrainApi } from '../../core/brain-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { OverviewTabComponent } from './overview-tab.component';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SpacesStore } from '../settings/spaces-store.service';
import { ViewOverviewComponent } from './view-overview.component';
import { ViewsStore } from '../../core/views.store';
import type { Space } from '../../core/api.types';

const en = JSON.parse(readFileSync(join(process.cwd(), 'public', 'assets', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
const NET = { id: 'acme', label: 'Acme partners', type: 'club' as const };

function setup(conflict: boolean) {
  TestBed.resetTestingModule();
  const networks = [{ ...NET, spaces: ['platform'], members: [{ instanceId: 'i-k', label: 'kiel-node' }],
    ...(conflict ? { rdfBaseConflicts: { platform: { held: { base: 'https://a/', epoch: 0 }, offered: [{ networkId: 'acme', memberId: 'i-k', base: 'https://b/', epoch: 0 }] } } } : {}) }];
  TestBed.configureTestingModule({
    imports: [OverviewTabComponent, getTranslocoModule({ translation: { en } })],
    // The Brain page provides one SpacesStore, which the conflict line reads the networks from (and asks to read them again).
    providers: [provideRouter([]), SpacesStore, { provide: SpacesApi, useValue: {} }, { provide: ConfirmDialogService, useValue: { confirm: async () => true } },
      { provide: NetworksApi, useValue: { listNetworks: () => of({ networks }) } },
      { provide: BrainApi, useValue: { getErModel: () => of({ spaceId: 's', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }) } }],
  });
  const fixture = TestBed.createComponent(OverviewTabComponent);
  fixture.componentRef.setInput('space', { id: 'platform', label: 'Platform', networks: [NET], meta: { rdf: { enabled: true, base: 'https://a/' } } } as Space);
  fixture.detectChanges();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, q: (t: string) => el.querySelector(`[data-testid="${t}"]`) as HTMLElement | null };
}

describe('the Overview carries the RDF ways in', () => {
  it('the RDF export panel is a panel of the Overview grid, beside Networks', () => {
    const { el } = setup(false);
    const panel = el.querySelector('app-rdf-export-panel');
    expect(panel).not.toBeNull();
    expect(panel?.classList.contains('panel')).toBe(true);
    expect(panel?.parentElement?.querySelector('section.panel')).not.toBeNull();
  });

  it('a base conflict is one line in the Networks panel whose button opens the RDF names card', () => {
    const { q, fixture } = setup(true);
    const line = q('overview-rdf-conflict');
    expect(line?.textContent).toContain(en['rdf.overview.conflict']);
    expect(line?.closest('section.panel')?.textContent).toContain(en['brain.overview.networksTitle']);
    let opened = 0;
    fixture.componentInstance.openRdfNames.subscribe(() => opened++);
    (q('overview-rdf-open') as HTMLButtonElement).click();
    expect(opened).toBe(1);
  });

  it('no conflict, no line', () => {
    const { q } = setup(false);
    expect(q('overview-rdf-conflict')).toBeNull();
  });

  it('reads the networks from the page\'s store, not by a request of its own (L1.1)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'app', 'pages', 'brain', 'rdf-conflict-line.component.ts'), 'utf8');
    expect(src).toMatch(/inject\(SpacesStore/);
    expect(src).not.toMatch(/listNetworks/);
  });
});

describe('a view\'s Overview carries the RDF export panel under its card', () => {
  it('over the member spaces the view reads', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ViewOverviewComponent, getTranslocoModule({ translation: { en } })],
      providers: [{ provide: ViewsStore, useValue: { byId: () => ({ id: '@drafts', name: 'drafts', members: ['a', 'b'], readable: ['a', 'b'] }) } }],
    });
    const fixture = TestBed.createComponent(ViewOverviewComponent);
    fixture.componentRef.setInput('viewId', '@drafts');
    fixture.componentRef.setInput('spaces', [{ space: { id: 'a', label: 'Field notes' } }, { space: { id: 'b', label: 'Scratch' } }, { space: { id: 'c', label: 'Other' } }]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-rdf-export-panel')).not.toBeNull();
    const names = [...el.querySelectorAll('[data-testid="rdf-export-panel"] .member-list li b')].map(b => b.textContent);
    expect(names).toEqual(['Field notes', 'Scratch']);
  });
});

describe('the Schema tab\'s Export RDF sits beside Export JSON', () => {
  it('directly after the Export JSON button in the toolbar', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'app', 'pages', 'settings', 'space-schema-tab.component.ts'), 'utf8');
    expect(src).toMatch(/'spaces\.schema\.exportJsonButton' \| transloco \}\}<\/button>\s*<app-schema-rdf-export \/>/);
  });
});
