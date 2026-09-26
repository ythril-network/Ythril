/**
 * The two per-slot controls every model card shows: how long one call may take, and how hard the model should
 * think.
 *
 * ## Why a component rather than the fields repeated on each card
 *
 * Seven cards need the budget and two of them need the effort. Written into each card that is seven copies of
 * a range, a placeholder, a disabled rule and a hint — and this repository's most-produced defect is one rule
 * with several implementations, where the weaker copy wins silently. `models-tab.component.ts` says the same
 * thing about its own history: four cards each chose their own field order until they went through one card
 * component.
 *
 * ## Effort is offered only where the request carries it
 *
 * The server sends `reasoning_effort` on the OpenAI-shaped bodies — external vision, the assist model, and the
 * two document slots that have no card of their own. Embedding, rerank, NLI, speech-to-text and the face
 * detector are not chat calls and have no such field, so `showEffort` is false for them: a control wired to
 * nothing is worse than no control, because it reads as configuration that took effect.
 *
 * ## Absent is not zero, and it is not `medium`
 *
 * An empty budget means the built-in default; an empty effort means the field is not sent at all. Both are
 * bound with `null` rather than `''` so a cleared box reaches the server as an explicit clear — the admin
 * PATCH distinguishes "absent, leave alone" from "null, clear this field", and an empty string would be
 * neither.
 */
import { ChangeDetectionStrategy, Component, Input, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { REASONING_EFFORTS, type SlotTuningCfg, type ReasoningEffort } from './media-processing.types';

@Component({
  selector: 'app-slot-tuning',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe],
  styles: [`
    :host { display: block; }
    .field { margin-bottom: 13px; }
    .field:last-child { margin-bottom: 0; }
    .field > label { display: block; font-size: 12px; color: var(--text-secondary);
      margin-bottom: 5px; font-weight: 500; }
    .hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  `],
  template: `
    <div [class.grid2]="showEffort">
      <div class="field">
        <label [attr.for]="slot + '-timeout'">{{ 'mediaProcessing.field.callBudget' | transloco }}</label>
        <input [id]="slot + '-timeout'" type="number" min="1000" max="1800000" step="1000"
          [ngModel]="value?.timeoutMs ?? null"
          (ngModelChange)="emit('timeoutMs', $event)"
          [disabled]="disabled"
          [placeholder]="defaultMs ? (defaultMs + '') : ''" />
        <div class="hint">{{ 'mediaProcessing.field.callBudgetHint' | transloco }}</div>
      </div>

      @if (showEffort) {
        <div class="field">
          <label [attr.for]="slot + '-effort'">{{ 'mediaProcessing.field.reasoningEffort' | transloco }}</label>
          <select [id]="slot + '-effort'"
            [ngModel]="value?.reasoningEffort ?? null"
            (ngModelChange)="emit('reasoningEffort', $event)"
            [disabled]="disabled">
            <!-- Blank FIRST and selected by default: sending nothing is the shipped behaviour, and a model
                 that was never trained for this rejects the request rather than ignoring it. -->
            <option [ngValue]="null">{{ 'mediaProcessing.field.reasoningEffortNone' | transloco }}</option>
            @for (level of levels; track level) {
              <option [ngValue]="level">{{ level }}</option>
            }
          </select>
          <div class="hint">{{ 'mediaProcessing.field.reasoningEffortHint' | transloco }}</div>
        </div>
      }
    </div>
  `,
})
export class SlotTuningComponent {
  /** The slot this tunes, used for the field ids so two cards on one screen cannot collide. */
  @Input({ required: true }) slot!: string;

  /** Whether this slot's requests carry `reasoning_effort` at all — see the docblock. */
  @Input() showEffort = false;

  /** Infra pins the whole slot, so both controls lock together. There is no per-field pin. */
  @Input() disabled = false;

  /** The slot's built-in budget, shown as the placeholder so an empty box reads as "the default" not "none". */
  @Input() defaultMs: number | null = null;

  @Input() value: SlotTuningCfg | undefined;

  @Output() valueChange = new EventEmitter<SlotTuningCfg>();

  readonly levels = REASONING_EFFORTS;

  /**
   * Emit the WHOLE tuning with one field changed.
   *
   * Not a patch of the single field: the parent stores one object per slot, and emitting a partial would make
   * every consumer merge it themselves — which is where one of the two fields eventually gets dropped. The
   * server has the same shape of trap in its own merge and it cost a silent loss of the operator's timeout.
   */
  emit(field: 'timeoutMs' | 'reasoningEffort', raw: unknown): void {
    const next: SlotTuningCfg = { ...(this.value ?? {}) };
    if (field === 'timeoutMs') {
      // An empty box is `null` — an explicit clear, which the admin PATCH distinguishes from absent.
      const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
      next.timeoutMs = n;
    } else {
      next.reasoningEffort = (raw ?? null) as ReasoningEffort | null;
    }
    this.valueChange.emit(next);
  }
}
