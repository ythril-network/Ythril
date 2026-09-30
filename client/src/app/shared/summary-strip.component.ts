/**
 * SummaryStrip — the operator-first "what's the state" row that sits atop a settings/list page
 * (design system, PR-U1). No page had one before; it's the highest-leverage shared add from the audit.
 *
 * Give it the headline stats (counts / rollups) and colour the ones that need attention; project extra
 * content (e.g. a usage bar) after them.
 *
 * Usage:
 *   <app-summary-strip heading="Tokens"
 *     [items]="[{label:'Active', value:4}, {label:'Expiring', value:1, variant:'warn'}]"/>
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { StatusVariant } from './status-pill.component';

export interface SummaryItem {
  label: string;
  value: string | number;
  /** Optional emphasis — colours the value when it's a state worth noticing (e.g. warn/error). */
  variant?: StatusVariant;
  /** Optional sentence saying what the number means. Rendered as text and as the item's aria-label, never as a
   *  tooltip alone: a `title` reaches a mouse and nobody else. */
  hint?: string;
}

@Component({
  selector: 'app-summary-strip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    .summary { border: 1px solid var(--border); border-radius: 10px;
               background: linear-gradient(180deg, var(--bg-surface), var(--bg-primary)); overflow: hidden; }
    .summary-h { display: flex; align-items: center; gap: 8px; padding: 10px 16px 8px;
                 color: var(--text-muted); font-size: 11px; font-weight: 600;
                 text-transform: uppercase; letter-spacing: .07em; }
    .items { display: flex; flex-wrap: wrap; gap: 8px 28px; padding: 12px 16px;
             border-top: 1px solid var(--border-muted); align-items: center; }
    .item { display: flex; flex-direction: column; gap: 1px; }
    .v { font-size: 20px; font-weight: 650; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--text-primary); }
    /* --state-active, not --accent. Both of these report a FACT about the system, and its siblings below already
       read semantic tokens — so a themed brand colour moved two of the five and left three alone. Found by
       auditing every state colour rather than only the pill a red theme happened to surface.
       The value is the default accent, so nothing changes on the default theme. */
    .v.active, .v.ok { color: var(--state-active); }
    .v.warn  { color: var(--warning); }
    .v.error { color: var(--error); }
    .v.pending { color: var(--info); }
    .l { font-size: 11.5px; color: var(--text-secondary); }
    .h { font-size: 11px; color: var(--text-muted); max-width: 26ch; line-height: 1.3; }
    .extra { margin-left: auto; display: flex; align-items: center; gap: 12px; flex: 1; min-width: 180px; justify-content: flex-end; }
    @media (max-width: 560px) { .items { gap: 12px 20px; } .extra { margin-left: 0; justify-content: flex-start; } }
  `],
  template: `
    <div class="summary">
      @if (heading()) { <div class="summary-h">{{ heading() }}</div> }
      <div class="items">
        @for (it of items(); track it.label) {
          <div class="item" [attr.aria-label]="it.hint ? it.label + ': ' + it.hint : null" [attr.role]="it.hint ? 'group' : null">
            <span class="v" [class]="it.variant ?? ''">{{ it.value }}</span>
            <span class="l">{{ it.label }}</span>
            @if (it.hint) { <span class="h">{{ it.hint }}</span> }
          </div>
        }
        <div class="extra"><ng-content/></div>
      </div>
    </div>
  `,
})
export class SummaryStripComponent {
  heading = input<string>('');
  items = input<SummaryItem[]>([]);
}
