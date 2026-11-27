/**
 * Q-942 (verify findings L1.1, L1.4, L4.4): the Brain page's links into the RDF names card and its count of a running export.
 *
 * - "Open RDF names" opens the space's settings on the Settings tab and raises the one focus signal (`showRdfNames`), the same call the
 *   Schema tab's link makes.
 * - The Overview tab's count of an export that runs while another tab is open says its size through the shared size formatter, only
 *   for the open space, and has an accessible name (a bare number in a tab says nothing to a screen reader).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import type { Space } from '../../core/api.types';
import { RdfExportRuns } from '../../core/rdf-export-runs.service';
import { SpaceSettingsState } from '../settings/space-settings-state.service';
import { BrainSchemaLinks } from './brain-schema-links';
import { formatSize } from '../files/file-format';
import { getTranslocoModule } from '../../testing/transloco-testing';

function links(spaceId = 'platform') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [getTranslocoModule()], providers: [SpaceSettingsState] });
  const state = TestBed.inject(SpaceSettingsState);
  const id = signal(spaceId);
  const l = runInInjectionContext(TestBed.inject(Injector), () => new BrainSchemaLinks(state, id, signal(false), TestBed.inject(Injector)));
  return { l, state, id, runs: TestBed.inject(RdfExportRuns) };
}

describe('BrainSchemaLinks.openRdfNames', () => {
  it('opens the space\'s settings on the Settings tab and raises the focus signal once', () => {
    const { l, state } = links();
    state.settingsTab.set('schema');
    l.openRdfNames({ id: 'platform', label: 'Platform' } as Space);
    expect(state.settingsSpace()?.id).toBe('platform');
    expect(state.settingsTab()).toBe('settings');
    expect(state.rdfFocus()).toBe(1);
  });

  it('does nothing for no space', () => {
    const { l, state } = links();
    l.openRdfNames(undefined);
    expect(state.settingsSpace()).toBeNull();
    expect(state.rdfFocus()).toBe(0);
  });
});

describe('BrainSchemaLinks.rdfRunning', () => {
  it('is the size so far of the open space\'s running export, as the shared size formatter says it', () => {
    const { l, runs } = links();
    expect(l.rdfRunning()).toBe('');
    runs.runs.set({ platform: { running: true, file: 'platform.ttl', bytes: 22_439_526, inMemory: false } });
    expect(l.rdfRunning()).toBe(formatSize(22_439_526));
    expect(l.rdfRunning()).toBe('21.4 MB');
  });

  it('is empty for another space\'s run, and once the run has ended', () => {
    const { l, runs, id } = links();
    runs.runs.set({ other: { running: true, file: 'o.ttl', bytes: 5, inMemory: false } });
    expect(l.rdfRunning()).toBe('');
    runs.runs.set({ other: { running: true, file: 'o.ttl', bytes: 5, inMemory: false }, platform: { running: false, file: 'p.ttl', bytes: 5, inMemory: false } });
    expect(l.rdfRunning()).toBe('');
    id.set('other');
    expect(l.rdfRunning()).toBe(formatSize(5));
  });
});

describe('the Overview tab\'s away count', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'app', 'pages', 'brain', 'brain.component.ts'), 'utf8');
  const count = /<span class="tab-count" data-testid="overview-rdf-running"[^>]*>/.exec(src)?.[0] ?? '';

  it('has an accessible name that says what it counts and its size, not only a title', () => {
    expect(count).toMatch(/role="img"/);
    expect(count).toMatch(/\[attr\.aria-label\]="'rdf\.export\.tabRunningSize' \| transloco: \{ size: mb \}"/);
  });
});
