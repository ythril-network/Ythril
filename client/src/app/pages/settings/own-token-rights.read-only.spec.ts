/**
 * The "Your access" panel says it is read-only to assistive technology, not in a visible sentence (Q-124).
 *
 * The owner asked for the sentence "What the token you are signed in with may do. Read-only - changing it needs an administrator." to go. The sentence
 * is also the only place the panel SAID it could not be edited; without it a screen reader meets a grid of disabled controls with no word about why.
 * So the visible paragraph and its key `tokens.own.readOnly` are gone from the template and from en, de and pl, and the matrix group carries an
 * `aria-label` that says read-only, in the reader's language.
 *
 * Red until the paragraph and the key are removed and the group is labelled.
 */
import { readFileSync } from 'node:fs';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { OwnTokenRightsComponent } from './own-token-rights.component';
import { RightsCatalogService } from './rights-catalog.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import type { TokenRights } from './rights-glyph.component';

const rights: TokenRights = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { qa: { knowledge: 'write', files: 'read', schema: 'none', dataQuality: 'none' } } };

const catalogStub = () => ({
  catalog: signal({ areas: ['knowledge', 'files', 'schema', 'dataQuality'], rungs: ['none', 'read', 'write', 'admin'] as const, routes: [] }),
  failed: signal(false), load: () => {}, routesFor: () => [], countFor: () => 0, impliedFor: () => null,
});

function mount(language: 'en' | 'de' | 'pl') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [OwnTokenRightsComponent, getTranslocoModule({ translation: { en: dictionary(language) } })],
    providers: [
      { provide: RightsCatalogService, useValue: catalogStub() },
      { provide: AuthApi, useValue: { verifyToken: () => of({ id: 't1', name: 'n8n', rights }) } },
    ],
  });
  const f = TestBed.createComponent(OwnTokenRightsComponent);
  f.detectChanges();
  return f.nativeElement as HTMLElement;
}

const READ_ONLY = { en: /read.?only/i, de: /schreibgesch|nur lesend|nur-lesen|schreibschutz/i, pl: /tylko do odczytu|tylko odczyt|tylko-do-odczytu/i } as const;

describe('the own-rights panel without its visible sentence (Q-124)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the key tokens.own.readOnly is gone from en, de and pl', () => {
    for (const language of ['en', 'de', 'pl'] as const) {
      // `Object.keys`, not `toHaveProperty`: the matcher reads a dotted name as a path into nested objects.
      expect(Object.keys(dictionary(language)), language).not.toContain('tokens.own.readOnly');
    }
  });

  it('the template no longer reads the key, and renders no paragraph in its place', () => {
    const src = readFileSync('src/app/pages/settings/own-token-rights.component.ts', 'utf8');
    expect(src).not.toContain('tokens.own.readOnly');
    expect(mount('en').querySelector('p.why'), 'the visible sentence').toBeNull();
  });

  for (const language of ['en', 'de', 'pl'] as const) {
    it(`${language}: the matrix is a labelled group that says read-only`, () => {
      const el = mount(language);
      const labelled = [...el.querySelectorAll('app-rights-matrix [aria-label], app-rights-matrix[aria-label]')]
        .map(e => e.getAttribute('aria-label') ?? '');
      const hit = labelled.find(l => READ_ONLY[language].test(l));
      expect(hit, `aria-labels on the matrix: ${JSON.stringify(labelled)}`).toBeTruthy();
    });
  }

  it('the matrix is a group (role=group) so the label has something to name', () => {
    const group = mount('en').querySelector('app-rights-matrix [role="group"], app-rights-matrix[role="group"], [role="group"][aria-label]');
    expect(group, 'a role=group element carries the label').toBeTruthy();
    expect(group!.getAttribute('aria-label') ?? '').toMatch(READ_ONLY.en);
  });
});
