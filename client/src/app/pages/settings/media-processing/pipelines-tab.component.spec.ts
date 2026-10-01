/**
 * PipelinesTabComponent — Audio and Video are separate pipelines (item 20).
 *
 * The combined "Audio & video" card was split: Audio (transcribe → embed) and Video (extract audio →
 * transcribe → [caption keyframes at full/auto] → embed) are now distinct cards, each with its own
 * single-class ceiling ladder. These tests pin `mediaPipelines()` so the split can't silently regress.
 */
import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { PipelinesTabComponent } from './pipelines-tab.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { AUDIO_LEVELS, VIDEO_LEVELS } from './media-processing.types';

function setup(status: Record<string, unknown> = {
  modelState: () => 'ok', modelDetail: () => null, sidecarState: () => 'ok', sidecarDetail: () => null, status: () => null,
}) {
  const state = {
    form: { stt: { model: 'base' }, vision: { model: 'moondream' } },
    embedding: { model: 'nomic-embed-text' },
    docMode: () => 'off',
    docCfg: () => ({}),
    isLocked: () => false,
    managed: false,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PipelinesTabComponent, getTranslocoModule()],
    providers: [
      { provide: MediaProcessingStateService, useValue: state },
      { provide: PipelineStatusService, useValue: status },
    ],
  });
  return TestBed.createComponent(PipelinesTabComponent).componentInstance;
}

describe('PipelinesTabComponent — a step that is not ok says why', () => {
  // Found driving Q-99: the embedding stage was `down` with the model's load error as its detail, and every Embed
  // dot on this tab said "Embed: not responding" and nothing more. The step carries the stage's detail to its dot.
  const REASON = "Embedding model 'x' is not in the model cache";
  const down = {
    status: () => null,
    modelState: (k: string) => (k === 'embedding' ? 'down' : 'ok'),
    modelDetail: (k: string) => (k === 'embedding' ? REASON : undefined),
    sidecarState: () => 'ok', sidecarDetail: () => undefined,
  };

  it('every Embed step, in every pipeline, carries the embedding stage\'s detail', () => {
    const c = setup(down);
    const embeds = [...c.documentSteps(), ...c.mediaPipelines().flatMap(p => p.steps)].filter(s => s.cardId === 'embedding');
    expect(embeds.length, 'found the Embed steps').toBeGreaterThanOrEqual(5);
    for (const st of embeds) expect(st.detail, st.key).toBe(REASON);
  });

  it('and the template hands it to the dot', () => {
    // Read from source: rendering the whole tab needs the full page state. Both dots in the template must pass it.
    const src = readFileSync('src/app/pages/settings/media-processing/pipelines-tab.component.ts', 'utf8');
    const dots = src.match(/<app-health-dot [^>]*>/g) ?? [];
    expect(dots.length).toBeGreaterThanOrEqual(2);
    for (const d of dots) expect(d).toMatch(/\[detail\]="st\.detail/);
  });
});

describe('PipelinesTabComponent — Audio / Video split', () => {
  it('exposes Audio and Video as separate single-class pipelines', () => {
    const pipes = setup().mediaPipelines();
    const ids = pipes.map(p => p.id);
    expect(ids).toEqual(['images', 'audio', 'video', 'text']);

    const audio = pipes.find(p => p.id === 'audio')!;
    const video = pipes.find(p => p.id === 'video')!;
    // Each carries exactly one ceiling ladder (no more side-by-side audio+video select).
    expect(audio.ceilings.map(c => c.cls)).toEqual(['audio']);
    expect(audio.ceilings[0].ladder).toBe(AUDIO_LEVELS);
    expect(video.ceilings.map(c => c.cls)).toEqual(['video']);
    expect(video.ceilings[0].ladder).toBe(VIDEO_LEVELS);
  });

  it('Audio goes straight to transcribe→embed (no ffmpeg split — that is video-only)', () => {
    const audio = setup().mediaPipelines().find(p => p.id === 'audio')!;
    expect(audio.steps.map(s => s.key)).toEqual(['transcribe', 'aud-embed']);
  });

  it('Video extracts audio, transcribes, conditionally captions keyframes, then embeds', () => {
    const video = setup().mediaPipelines().find(p => p.id === 'video')!;
    expect(video.steps.map(s => s.key)).toEqual(['vid-split', 'vid-transcribe', 'vid-keyframe', 'vid-embed']);
    const keyframe = video.steps.find(s => s.key === 'vid-keyframe')!;
    // The keyframe (vision-model) step is conditional — skipped at the `audio` level.
    expect(keyframe.conditional).toBe(true);
    expect(keyframe.cardId).toBe('vision');
    // The split (ffmpeg audio extraction) always runs for video.
    expect(video.steps.find(s => s.key === 'vid-split')!.conditional).toBe(false);
  });
});
