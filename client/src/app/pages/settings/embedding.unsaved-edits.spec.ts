/**
 * The embedding page asks before leaving with an allowed-origins list the server has not been sent (Q-701).
 */
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { EmbeddingComponent } from './embedding.component';
import { UnsavedEdits } from '../../core/unsaved-edits';

function open() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [EmbeddingComponent, getTranslocoModule()],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(EmbeddingComponent);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/admin/embed-config').flush({ allowedOrigins: ['https://portal.example.com'], resolved: [], invalid: [] });
  return { c: fixture.componentInstance, http, edits: TestBed.inject(UnsavedEdits) };
}

describe('the embedding page holds its origins list (Q-701)', () => {
  it('is clean when untouched', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('an edited origin is held until it is saved', () => {
    const { c, http, edits } = open();
    c.setOrigin(0, 'https://other.example.com');
    expect(edits.any()).toBe(true);
    c.save();
    http.expectOne(r => r.method === 'PATCH').flush({ allowedOrigins: ['https://other.example.com'] });
    expect(edits.any()).toBe(false);
  });

  it('an added origin that has text is held, a blank added row is not', () => {
    const { c, edits } = open();
    c.addOrigin();
    expect(edits.any()).toBe(false);
    c.setOrigin(1, 'https://third.example.com');
    expect(edits.any()).toBe(true);
  });

  it('a removed origin is held', () => {
    const { c, edits } = open();
    c.removeOrigin(0);
    expect(edits.any()).toBe(true);
  });

  it('an edit the server refused is still held', () => {
    const { c, http, edits } = open();
    c.setOrigin(0, 'not an origin');
    c.save();
    http.expectOne(r => r.method === 'PATCH').flush({ invalid: ['not an origin'] }, { status: 400, statusText: 'Bad Request' });
    expect(edits.any()).toBe(true);
  });
});
