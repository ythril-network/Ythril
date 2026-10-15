import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import type { Rung } from './rights-glyph.component';
import { translatedOrEmpty } from '../../core/translated-text';

export const RUNGS: readonly Rung[] = ['none', 'read', 'write', 'admin'];
const RANK: Record<Rung, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** What each rung is called in the grid. Short, because a matrix cell has no room for a sentence. */
const LABEL: Record<Rung, string> = { none: '—', read: 'R', write: 'W', admin: 'A' };

/**
 * One cell of the rights matrix: an escalation, not four checkboxes.
 *
 * ## Why an escalation
 *
 * Each rung CONTAINS the one below it, so "write but not read" is not a thing that can be expressed. Four
 * checkboxes would let somebody save it, and the server would then have to decide what it meant — which is
 * a decision nobody should be making at read time.
 *
 * ## Two behaviours that are easy to get wrong
 *
 *  - **Clicking the current rung steps DOWN one.** Without it, a cell can only ever go up by clicking and
 *    down by clicking a specific lower segment, which reads as "the control resists being narrowed".
 *  - **Rungs below the floor are clamped, not hidden.** The floor is set on another row entirely, so a cell
 *    that silently refuses to go lower with no visible reason looks broken. Dimmed-and-titled says why.
 *
 * ## Two sources of a minimum, one clamp
 *
 * A cell also cannot go below what another AREA entails: `knowledge: write` needs `schema: read` to be
 * exercisable at all, so the server grants it (`RUNG_IMPLICATIONS`, resolved in `effectiveRung`). Both the
 * floor and an implication are the same thing to this control — a minimum with a reason — so they share one
 * clamp rather than getting one mechanism each. The title names whichever is BINDING, because a reader who
 * cannot lower a cell wants the one fact that would let them.
 *
 * The implication is not hard-coded here. It arrives from `GET /api/tokens/rights-catalog`, which publishes
 * what the server enforces; a copy typed into the client would be a second description of a security rule.
 *
 * ## The tooltip says what the rung GRANTS, then what the click does
 *
 * Owner, 2026-08-15: *"the tooltip on hovering a rung is still missing."* It was not absent — it was
 * answering the wrong question. It read `Set write` and `Set write — click again to step down`, which
 * describes the CLICK. Somebody hovering a cell in a permissions grid is asking what the rung grants; the
 * click is confirmation of a choice they have already made.
 *
 * The answer was already written and already translated — sixteen `tokens.rights.plain.<area>.<rung>` strings
 * in all three locales, which the column-header glyph has been using all along. This control could not reach
 * them for one reason: it did not know its own area. Both call sites have it in scope, so it is now an input.
 *
 * Capability first, action second, and when a cell is clamped the clamp explanation is APPENDED rather than
 * substituted — "why can I not go lower" is still a live question in that state, but so is "what would it
 * give me if I could".
 */
@Component({
  selector: 'app-rung-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: inline-flex; border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
    button { font-family: var(--font-mono, monospace); font-size: 10.5px; font-weight: 600; padding: 5px 8px;
      color: var(--text-muted); background: var(--bg-surface); border: 0;
      border-right: 1px solid var(--border-muted); cursor: pointer; }
    button:last-child { border-right: 0; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    button.on.r0 { background: var(--text-muted); color: var(--bg-primary); }
    button.on.r1 { background: var(--info);    color: var(--bg-primary); }
    button.on.r2 { background: var(--accent);  color: var(--text-on-accent); }
    button.on.r3 { background: var(--warning); color: var(--bg-primary); }
    button.clamped { opacity: .35; cursor: not-allowed; }
  `],
  template: `
    @for (s of segments(); track s.rung) {
      <button type="button"
              [class]="s.classes"
              [disabled]="s.clamped || readonlyView()"
              [attr.aria-pressed]="s.filled"
              [attr.title]="s.title"
              (click)="pick(s.rung)">{{ s.label }}</button>
    }
  `,
})
export class RungPickerComponent {
  private t = inject(TranslocoService);

  value = input.required<Rung>();
  /**
   * Which area this cell is for, so the tooltip can say what the rung GRANTS.
   *
   * Both call sites already have it in scope. Without it the control could only describe its own click, which
   * is the defect — see the class comment.
   */
  area = input<string>('');
  /** The floor for this area. A cell may never sit below it — see the class comment. */
  floor = input<Rung>('none');
  /** A minimum entailed by another area in the same space, or `none`. See the class comment. */
  implied = input<Rung>('none');
  /** Which area entails `implied`, and at what rung — for the title. Ignored when `implied` is `none`. */
  impliedBy = input<{ area: string; rung: Rung } | null>(null);
  /**
   * Display only: every segment is disabled and no click emits.
   *
   * Added for the read-only view of a token`s OWN rights, so that view reuses this renderer instead of a
   * second one. Two renderers of a permission grid is two places the colours and the clamping can disagree,
   * and the one people trust would be whichever they happened to open.
   */
  readonlyView = input(false);
  changed = output<Rung>();

  /** The binding minimum: the higher of the floor and whatever another area entails. */
  private minRung = computed<Rung>(() =>
    RANK[this.implied()] > RANK[this.floor()] ? this.implied() : this.floor());

  /**
   * Why the cell will not go lower — naming the SOURCE that is actually binding.
   *
   * When both apply, the higher one wins and is the one worth explaining: telling somebody about the floor
   * while an implication holds the cell two rungs above it sends them to change the wrong control.
   */
  private clampTitle = computed(() => {
    const by = this.impliedBy();
    return RANK[this.implied()] > RANK[this.floor()] && by
      ? this.t.translate('tokens.rights.clamp.implied',
        { rung: this.implied(), area: this.t.translate('tokens.rights.area.' + by.area), cause: by.rung })
      : this.t.translate('tokens.rights.clamp.floor', { rung: this.floor() });
  });

  segments = computed(() => {
    const held = RANK[this.value()];
    const min = RANK[this.minRung()];
    const clampTitle = this.clampTitle();
    return RUNGS.map((rung, i) => {
      const clamped = i < min;
      const filled = i <= held;
      return {
        rung, label: LABEL[rung], clamped, filled,
        // The colour comes from the SELECTED rung, not from each segment's own level, so a filled bar reads
        // as one block at one level rather than a gradient nobody asked for.
        classes: `${filled ? `on r${held}` : ''}${clamped ? ' clamped' : ''}`,
        // Capability FIRST, action second. Somebody hovering a rung is asking what it grants, not what the
        // click does — the click is confirmation, and it was all this control used to say.
        //
        // Joined through a filter rather than by interpolation: with no `[area]` wired the capability half is
        // empty, and interpolating it would leave a leading space on every tooltip in the grid.
        title: [this.grants(rung), clamped ? clampTitle : this.action(rung)].filter(Boolean).join(' '),
      };
    });
  });

  /**
   * What this rung GRANTS in this area, in the words the glyph tooltip already uses.
   *
   * Sixteen `tokens.rights.plain.<area>.<rung>` strings exist in all three locales and this control was not
   * reading any of them — it described the CLICK instead ("Set write", "Set write — click again to step
   * down"), which answers a question nobody hovering has. Owner, 2026-08-15: *"the tooltip on hovering a rung
   * is still missing."* It was not absent; it was answering the wrong question.
   *
   * Falls back to the empty string when the area is not wired or the key is missing, so a caller that forgot
   * `[area]` degrades to the old action-only tooltip rather than printing a raw translation key at a user.
   */
  private grants(rung: Rung): string {
    const a = this.area();
    if (!a) return '';
    return translatedOrEmpty(this.t, `tokens.rights.plain.${a}.${rung}`);
  }

  /** What the click will do. Kept, because a reader still needs to know a second click steps down. */
  private action(rung: Rung): string {
    return `Set ${rung}${rung === this.value() ? ' — click again to step down' : ''}`;
  }

  pick(rung: Rung): void {
    // Belt and braces: a disabled button cannot be clicked, but a caller could still call this.
    if (this.readonlyView()) return;
    const min = this.minRung();
    if (RANK[rung] < RANK[min]) return;
    // Clicking the rung you are already on steps down one, never below the minimum. A control that can only
    // climb reads as resisting being narrowed, which is the direction anyone auditing wants to move.
    const next: Rung = rung === this.value()
      ? (RUNGS[Math.max(RANK[min], RANK[rung] - 1)] as Rung)
      : rung;
    if (next !== this.value()) this.changed.emit(next);
  }
}
