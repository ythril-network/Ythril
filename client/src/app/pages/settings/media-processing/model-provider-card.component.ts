/**
 * The ONE provider-card shape, used seven times on the Models tab.
 *
 * The owner's complaint about this page — "very wild, no logic structure or consistent layout" — was
 * mostly this component not existing. Four provider cards written inline in one 656-line file each
 * invented their own field order, their own way of showing "env-locked", and their own footer. Seven
 * call sites of one component is what stops that happening again.
 *
 * The approved layout, and the reason for each rule:
 *
 *   - **Uniform height and width.** The grid stretches, the body flexes, the footer is pinned — so
 *     every "Test connection" sits on one baseline instead of wherever its card's last row happened
 *     to end. Ragged heights were never the goal; consistent shape was.
 *   - **Rows that do not apply are omitted, not dashed** (owner's option B). A dash row is noise
 *     claiming to be information.
 *   - **Pills sit on their own row under the title**, including "Egress acknowledged" — which used to
 *     hide in the footer, the one place nobody reads.
 *   - **Infra-set cards are dashed and dimmed and name the env var that owns them.** No "change this
 *     in the environment" footer sentence: the pill already says it, and saying it twice is how the
 *     old card ran out of vertical room.
 *   - **A stable `id`** (`embedding`, `vision`, `stt`, `assist`, `doc-render`, `unstructured`,
 *     `face`) so a pipeline step can deep-link to it.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../../shared/ph-icon.component';
import { HealthDotComponent } from './health-dot.component';
import { SlotTuningComponent } from './slot-tuning.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { HealthState, CARD_SLOT, SLOT_DEFAULT_MS } from './media-processing.types';
import { problemDetail } from './stage-health';

@Component({
  selector: 'app-model-provider-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoPipe, PhIconComponent, HealthDotComponent, SlotTuningComponent],
  styles: [`
    /* Stretch to the grid row's height so the pinned footer actually lands on a shared baseline. */
    :host { display: flex; }
    .card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px;
      display: flex; flex-direction: column; width: 100%; overflow: hidden; }
    /* Infra-owned: dashed and dimmed, so "you cannot change this here" is legible before reading. */
    .card.infra { border-style: dashed; background: transparent; }
    .card.infra .card-b { opacity: .62; }
    /* Except the slot control, which is NOT infra-owned even on an infra card.
       The three document cards carry the infra flag because their model and endpoint come from environment
       variables -- and their call budget and reasoning effort do not: there is deliberately no environment
       variable for those, so this card is the only place they can be set. Dimming them alongside the
       read-only fields says the opposite, and a control that looks disabled is one nobody tries. When infra
       DOES pin a slot, isLocked disables the inputs themselves, which is the honest signal.
       (No backticks in here -- one would terminate the styles template literal, and the error then points
       at the decorator rather than at the comment.) */
    .card.infra .card-b app-slot-tuning { opacity: 1; }

    .card-h { display: flex; align-items: flex-start; gap: 12px; padding: 15px 18px 0; }
    .ic { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; flex: none;
      background: var(--bg-elevated); border: 1px solid var(--border); color: var(--accent); }
    .card.infra .ic { color: var(--text-muted); }
    .t { flex: 1; min-width: 0; }
    .t h3 { margin: 0; font-size: 15px; font-weight: 620; display: flex; align-items: center; gap: 8px; }
    .t p { margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary); }
    .t p.health-detail { color: var(--error); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    /* Pills on their own row under the title, at the size the owner specified. */
    .pills { display: flex; flex-wrap: wrap; gap: 6px; padding: 9px 18px 0; }
    .pills ::ng-deep .pill, .pills ::ng-deep app-status-pill { font-size: 9.5px; }

    .card-b { flex: 1; padding: 14px 18px 4px; }
    .card-f { padding: 12px 18px 16px; margin-top: auto; }
    .card-f:empty { display: none; }

    /* Brief highlight when the operator arrives here by clicking the model in the Pipelines viz, so the
       card they landed on is obvious after the scroll. */
    .card.flash { animation: cardFlash 1.4s ease-out; }
    @keyframes cardFlash {
      0%   { box-shadow: 0 0 0 2px var(--accent); }
      70%  { box-shadow: 0 0 0 2px var(--accent); }
      100% { box-shadow: 0 0 0 2px transparent; }
    }
    @media (prefers-reduced-motion: reduce) { .card.flash { animation: none; } }
  `],
  template: `
    <section class="card" [class.infra]="infra()" [attr.id]="'model-card-' + id()">
      <header class="card-h">
        <span class="ic"><ph-icon [name]="icon()" [size]="18"/></span>
        <div class="t">
          <h3>
            {{ heading() }}
            @if (health() !== undefined) {
              <!-- The nullish fallback only satisfies the compiler; the guard above rules out undefined. -->
              <app-health-dot [state]="health() ?? null" [detail]="healthDetail()" [subject]="heading()"/>
            }
          </h3>
          @if (purpose()) { <p>{{ purpose() }}</p> }
          @if (problem(); as why) {
            <!-- Why the dot is not green, readable without a click. One line, so a long load error cannot push
                 the card's fields down; the full text is on hover and in the dot's accessible name. -->
            <p class="health-detail" [attr.title]="why">{{ why }}</p>
          }
        </div>
      </header>

      <div class="pills">
        <ng-content select="[pill]"/>
        @if (infra()) {
          <!-- Names the variable that owns the value. Without it "managed by infra" tells an operator
               they cannot change it here but not where they can. -->
          <span class="pill env" [attr.title]="'mediaProcessing.card.infraTitle' | transloco">
            {{ 'mediaProcessing.card.infraPill' | transloco: { envVar: envVar() } }}
          </span>
        }
      </div>

      <div class="card-b">
        <ng-content/>
        @if (state && tuning(); as t) {
          <!--
            Rendered by the CARD rather than written into each card's markup on the tab.

            Seven cards need this and two of them need the effort as well. Pasted onto the tab that is thirty
            near-identical lines in a file the god-file gate had already frozen at 687 code lines - and the
            gate's point is not the size on any given day, it is that every change lands in the same place
            because that is where the code already is. The card knows its own id, CARD_SLOT knows what that
            id tunes, so the tab gains nothing at all.
          -->
          <app-slot-tuning [slot]="t.slot" [showEffort]="t.effort" [defaultMs]="t.defaultMs"
            [disabled]="state.isLocked('modelSlots.' + t.slot)"
            [value]="state.modelSlots[t.slot]"
            (valueChange)="state.modelSlots[t.slot] = $event" />
        }
      </div>
      <div class="card-f"><ng-content select="[footer]"/></div>
    </section>
  `,
})
export class ModelProviderCardComponent {
  /**
   * Read directly rather than passed down: the tab would otherwise thread four attributes through seven
   * cards, and that tab is a frozen file the god-file gate does not let grow.
   *
   * OPTIONAL, and that is not a shortcut around a wiring mistake. This card is presentational and is rendered
   * in specs that provide the page's services as fakes; a hard dependency turned three of those into
   * NullInjector failures for a control they are not testing. Inside the page the service is always there —
   * `media-processing-page.component.ts` provides it — so the only thing `null` changes is that a card
   * rendered outside its page shows no tuning, which is the honest answer for a card with no page to save to.
   */
  readonly state = inject(MediaProcessingStateService, { optional: true });

  /** Stable, and part of the DOM id — a pipeline step deep-links to `#model-card-<id>`. */
  id = input.required<string>();
  icon = input<string>('cube');
  heading = input.required<string>();
  purpose = input<string>('');
  /** undefined = this card has no health to report (as opposed to `null`, meaning "not known yet"). */
  health = input<HealthState | null | undefined>(undefined);
  /** The stage's `detail` from the status payload; shown (dot and reason line) only while `health` is not ok. */
  healthDetail = input<string | null | undefined>(null);
  readonly problem = computed(() => problemDetail(this.health(), this.healthDetail()));
  /** True when the value is owned by infrastructure and cannot be set here. */
  infra = input<boolean>(false);
  /** The env var that owns it, named on the pill. Only meaningful when `infra` is true. */
  envVar = input<string>('');

  /**
   * What this card tunes, or nothing at all.
   *
   * A card whose id is not in `CARD_SLOT` shows no tuning — the document and renderer cards are read-only
   * displays of infra-owned settings and have no per-card Save to carry a change back.
   */
  readonly tuning = computed(() => {
    const entry = CARD_SLOT[this.id()];
    return entry ? { ...entry, defaultMs: SLOT_DEFAULT_MS[entry.slot] ?? null } : null;
  });
}
