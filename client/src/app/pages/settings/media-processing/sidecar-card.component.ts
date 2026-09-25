/**
 * A read-only card for one first-party sidecar: its endpoint, its health and its last probe.
 *
 * Every sidecar card is the same four facts from the same probe, so a new sidecar is one line on the Models
 * tab rather than a copied block. The copies are how the office renderer and then the NLP sidecar each shipped
 * without a card: the tab was a list somebody had to remember to extend.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ModelProviderCardComponent } from './model-provider-card.component';
import { PipelineStatusService } from './pipeline-status.service';

@Component({
  selector: 'app-sidecar-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, ModelProviderCardComponent],
  // The field styling the Models tab gives its inline cards: this template declares these elements, so the
  // tab's own rules do not reach them.
  styles: [`
    :host { display: flex; }
    app-model-provider-card { flex: 1; min-width: 0; }
    .field { margin-bottom: 13px; }
    .field:last-child { margin-bottom: 0; }
    .field > label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 5px; font-weight: 500; }
    .ro { font-family: var(--font-mono, monospace); font-size: 12.5px; color: var(--text-primary);
      background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
      overflow-wrap: anywhere; }
  `],
  template: `
    <app-model-provider-card [id]="id()" [icon]="icon()"
      [heading]="('mediaProcessing.' + copy() + '.title') | transloco"
      [purpose]="('mediaProcessing.' + copy() + '.purpose') | transloco"
      [health]="pipeline.sidecarState(id())"
      [infra]="true" [envVar]="envVar()">
      <div class="field">
        <label>{{ 'mediaProcessing.field.endpoint' | transloco }}</label>
        <div class="ro">{{ status()?.url ?? '—' }}</div>
      </div>
      @if (status()?.detail; as d) {
        <div class="field"><label>{{ 'mediaProcessing.field.lastProbe' | transloco }}</label><div class="ro">{{ d }}</div></div>
      }
    </app-model-provider-card>
  `,
})
export class SidecarCardComponent {
  protected readonly pipeline = inject(PipelineStatusService);
  /** The sidecar's key in the pipeline status, which is also the card id a Pipelines step links to. */
  id = input.required<string>();
  icon = input<string>('cube');
  /** The `mediaProcessing.<copy>` i18n block holding `title` and `purpose`. */
  copy = input.required<string>();
  envVar = input.required<string>();
  protected readonly status = computed(() => this.pipeline.bySidecarKey().get(this.id()));
}
