/**
 * The media-processing page's two click-only fallback controls count as an edit (Q-701).
 *
 * The page holds `s.isDirty()` (`media-processing-page.component.ts`), which is `touched` AND a changed section snapshot. `touched` is set by a
 * delegated `(input)`/`(change)` listener on the panel, and the assist fallback's "allow conversations" and "withdraw" buttons fire neither,
 * so granting or withdrawing that consent left the page clean: a sidebar click lost it with no question.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { MediaProcessingPageComponent } from './media-processing-page.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';
import { PipelineStatusService } from './pipeline-status.service';
import { UnsavedEdits } from '../../../core/unsaved-edits';

/** An assist model with an external fallback that has not been allowed to see conversations. */
const CFG = {
  visionProvider: 'local', sttProvider: 'local', lockedByInfra: [],
  documentProcessing: { mode: 'ocr', assistModel: { api: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', fallback: { api: 'openai', baseUrl: 'https://fb.example.com/v1' } } },
};
const STATUS = { checkedAt: '', models: [], sidecars: [], index: { spaces: [] }, faceRecognition: { state: 'off' } };

function mount(): { fixture: ComponentFixture<MediaProcessingPageComponent>; edits: UnsavedEdits } {
  TestBed.resetTestingModule();
  const http = {
    get: vi.fn().mockImplementation((url: string) => of(url.includes('pipeline-status') ? STATUS : url.includes('schema-library') ? { entries: [] } : CFG)),
    patch: vi.fn(), post: vi.fn().mockReturnValue(of({ reachable: true })),
  } as unknown as HttpClient;
  TestBed.configureTestingModule({
    imports: [MediaProcessingPageComponent, getTranslocoModule()],
    providers: [
      { provide: HttpClient, useValue: http },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
    ],
  });
  TestBed.overrideComponent(MediaProcessingPageComponent, { set: { providers: [MediaProcessingStateService, PipelineStatusService] } });
  const fixture = TestBed.createComponent(MediaProcessingPageComponent);
  fixture.componentInstance.tab.set('models');
  fixture.detectChanges();
  return { fixture, edits: TestBed.inject(UnsavedEdits) };
}

/** A button of one card part (`app-assist-extras`: the fallback's; `app-assist-egress-consent`: the primary endpoint's), by its label key. */
const buttonIn = (f: ComponentFixture<MediaProcessingPageComponent>, part: string, key: string) =>
  Array.from((f.nativeElement as HTMLElement).querySelectorAll(`${part} button`)).find(b => (b.textContent ?? '').includes(key)) as HTMLButtonElement | undefined;

describe('the media-processing page sees the assist consent buttons (Q-701)', () => {
  it('is clean when opened', () => {
    expect(mount().edits.any()).toBe(false);
  });

  it('allowing the fallback to see conversations is held, and withdrawing it again is clean', () => {
    const { fixture, edits } = mount();
    const allow = buttonIn(fixture, 'app-assist-extras', 'mediaProcessing.assist.conversationsAllow');
    expect(allow, 'the allow button is rendered for an external fallback').toBeTruthy();
    allow!.click();
    fixture.detectChanges();
    expect(edits.any()).toBe(true);
    buttonIn(fixture, 'app-assist-extras', 'mediaProcessing.assist.conversationsWithdraw')!.click();
    fixture.detectChanges();
    expect(edits.any()).toBe(false);
  });

  it('allowing the primary endpoint to see conversations is held', async () => {
    const { fixture, edits } = mount();
    const allow = buttonIn(fixture, 'app-assist-egress-consent', 'mediaProcessing.assist.conversationsAllow');
    expect(allow, 'the allow button is rendered for an external primary endpoint').toBeTruthy();
    allow!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(edits.any()).toBe(true);
  });
});
