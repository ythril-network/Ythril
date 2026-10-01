/**
 * One fetch of `GET /api/admin/pipeline-status` (#360), shared by the Pipelines and Tools tabs.
 *
 * Deliberately a service rather than a fetch per tab: the payload feeds a health dot on every step of
 * four pipelines plus the whole of the Tools tab, and the owner's spec is explicit that clicking
 * between tabs must not re-probe. The server caches for 20s and single-flights, so a second request
 * would be cheap — but it would still be a request per tab switch per admin, and the endpoints being
 * probed are the same processes doing the real work.
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PipelineStatus, HealthState, ModelStageStatus, SidecarStatus } from './media-processing.types';

@Injectable()
export class PipelineStatusService {
  private readonly http = inject(HttpClient);

  readonly status = signal<PipelineStatus | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Indexed by stage key, so a step can ask for its own dot without scanning the array each pass. */
  readonly byModelKey = computed(() => {
    const map = new Map<string, ModelStageStatus>();
    for (const m of this.status()?.models ?? []) map.set(m.key, m);
    return map;
  });

  readonly bySidecarKey = computed(() => {
    const map = new Map<string, SidecarStatus>();
    for (const s of this.status()?.sidecars ?? []) map.set(s.key, s);
    return map;
  });

  /** Spaces whose stored index status disagrees with the database — the reason this endpoint exists. */
  readonly driftedSpaces = computed(() => (this.status()?.index.spaces ?? []).filter(s => s.drifted));

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http.get<PipelineStatus>('/api/admin/pipeline-status').subscribe({
      next: s => { this.status.set(s); this.loading.set(false); },
      // A failed status fetch must not read as "everything is off". The dots fall back to `unknown`
      // and the tab says why — reporting a probe failure as a component failure would be the same
      // dishonesty this screen exists to end.
      error: err => { this.error.set(err?.error?.error ?? err?.message ?? 'Could not read pipeline status'); this.loading.set(false); },
    });
  }

  /** The state for a model-backed step, or null when the status is not loaded (drawn as unknown). */
  modelState(key: string): HealthState | null { return this.byModelKey().get(key)?.state ?? null; }
  sidecarState(key: string): HealthState | null { return this.bySidecarKey().get(key)?.state ?? null; }
  /** The stage's `detail` as the server sent it, ok or not; a surface shows it through `problemDetail`. */
  modelDetail(key: string): string | null { return this.byModelKey().get(key)?.detail ?? null; }
  sidecarDetail(key: string): string | null { return this.bySidecarKey().get(key)?.detail ?? null; }
}
