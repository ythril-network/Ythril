/**
 * HealthDotComponent — a stage that is not ok says WHY, without a click.
 *
 * Found driving Q-99: the bundled embedding model could not load, the server reported the stage `down` with the
 * load error as its `detail`, and the dot said "Text embedding: not responding" and nothing else. The one fact an
 * operator needed (which file is missing, which flag is set) was in the payload and on no surface they could read
 * short of pressing Verify. A green stage's `detail` (`in-process`) is configuration, not a reason, and stays out.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { HealthDotComponent } from './health-dot.component';
import { HealthState } from './media-processing.types';

function render(state: HealthState | null, detail: string | null) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [HealthDotComponent, getTranslocoModule()] });
  const fixture = TestBed.createComponent(HealthDotComponent);
  fixture.componentRef.setInput('state', state);
  fixture.componentRef.setInput('subject', 'Embed');
  fixture.componentRef.setInput('detail', detail);
  fixture.detectChanges();
  const dot = (fixture.nativeElement as HTMLElement).querySelector('.dot') as HTMLElement;
  return { title: dot.getAttribute('title') ?? '', label: dot.getAttribute('aria-label') ?? '' };
}

const REASON = "Embedding model 'nomic-ai/nomic-embed-text-v1.5' is not in the model cache";

describe('HealthDotComponent — the reason a stage is not ok', () => {
  for (const state of ['down', 'degraded', 'blocked'] as const) {
    it(`a ${state} stage carries its detail in the title AND the accessible name`, () => {
      const { title, label } = render(state, REASON);
      expect(title).toContain('mediaProcessing.health.' + state);
      expect(title).toContain(REASON);
      expect(label, 'a screen reader hears the reason too').toContain(REASON);
    });
  }

  it('an ok stage does not repeat its detail: "in-process" is a configuration, not a reason', () => {
    const { title, label } = render('ok', 'in-process');
    expect(title).not.toContain('in-process');
    expect(label).not.toContain('in-process');
  });

  it('a stage with no detail reads exactly as before', () => {
    const { title } = render('down', null);
    expect(title).toBe('Embed: mediaProcessing.health.down');
  });
});
