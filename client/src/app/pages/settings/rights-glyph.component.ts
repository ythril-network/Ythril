import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The areas, in the order the matrix shows them. Bars follow this order so a row reads left to right. Must equal
 * the server's `SPACE_AREAS` — `networks` joined it with F-34 — and `a-client-area-list-matches-the-server` holds
 * the two to one list.
 */
export const RIGHT_AREAS = ['knowledge', 'files', 'schema', 'dataQuality', 'networks'] as const;
export type RightArea = (typeof RIGHT_AREAS)[number];
export type Rung = 'none' | 'read' | 'write' | 'admin';
export type AreaRungs = Record<RightArea, Rung>;

/**
 * What arrives on the wire: a plain record, not a guaranteed four-key object.
 *
 * The component reads it defensively and treats a missing area as `none`. A server that grows a fifth area,
 * or an older instance that has not, must not make this throw — a glyph that crashes takes the whole token
 * list with it, and the list is where somebody is auditing access.
 */
export type WireRungs = Record<string, Rung>;

export interface TokenRights {
  instanceAdmin: boolean;
  createSpaces: boolean;
  floor: WireRungs | null;
  perSpace: Record<string, WireRungs>;
  /**
   * Spaces this token administers outright — a REAL grant since 5.0.
   *
   * The server resolves it to `admin` in every area of the named space, so a reader that ignores this
   * field under-reports what the token holds. Optional: a matrix minted before it existed has no key,
   * which grants nothing.
   */
  spaceAdmin?: { floor: boolean; spaces: string[] };
}

const RANK: Record<Rung, number> = { none: 0, read: 1, write: 2, admin: 3 };

/**
 * One bar per area: height is the CEILING, a red line marks the FLOOR.
 *
 * ## Why a glyph and not a label
 *
 * A token's rights are four areas across every space. "read-write" was what the old model could say and it
 * is exactly what this replaces — a single label cannot express "admin on Files here, nothing anywhere
 * else". A row of bars can be scanned down a column, which is what a list is for.
 *
 * ## Why the floor is a separate mark rather than a second bar
 *
 * Ceiling and floor answer different questions — *how high does this go* and *how much of that applies
 * everywhere, including spaces that do not exist yet*. Drawn as two bars they read as two unrelated numbers;
 * drawn as a bar with a line, the gap between them is visible and is exactly the part that is granted per
 * space and can be audited space by space.
 *
 * A line at the top of a bar therefore means ceiling equals floor: that level everywhere, forever, with
 * nothing space-specific to review. That is the state worth spotting from across a list, which is why the
 * mark is red rather than another shade of the bar.
 */
@Component({
  selector: 'app-rights-glyph',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host { display: inline-flex; align-items: flex-end; gap: 4px; height: 24px; padding-top: 2px; }
    .bar { position: relative; width: 10px; border-radius: 2px; display: block; background: var(--bg-elevated); }
    .bar.h0 { height: 4px; }
    .bar.h1 { height: 9px;  background: var(--info); }
    .bar.h2 { height: 15px; background: var(--accent); }
    .bar.h3 { height: 22px; background: var(--warning); }
    /* Instance administrator is not a rung — it is everything, everywhere, and reads as its own state. */
    .bar.hx { height: 22px; background: var(--error); }
    .floor { position: absolute; left: -2px; right: -2px; height: 2px; background: var(--error);
      border-radius: 1px; box-shadow: 0 0 0 1px var(--bg-surface); }
    .floor.f1 { bottom: 8px; } .floor.f2 { bottom: 14px; } .floor.f3 { bottom: 21px; }
  `],
  template: `
    @for (b of bars(); track b.area) {
      <span class="bar" [class]="'bar ' + b.h" [attr.title]="b.label">
        @if (b.f) { <span class="floor" [class]="'floor ' + b.f"></span> }
      </span>
    }
  `,
})
export class RightsGlyphComponent {
  rights = input.required<TokenRights>();

  /**
   * The ceiling for an area is the highest rung held in ANY space — floor or row, whichever is higher.
   *
   * Reading only `perSpace` under-reports a token whose reach comes from its floor; reading only the floor
   * under-reports one with a specific row. Both are wrong in the same direction — they make a token look
   * smaller than it is — which is the direction that matters least in a refusal and most in a list somebody
   * is auditing.
   */
  bars = computed(() => {
    const r = this.rights();
    return RIGHT_AREAS.map(area => {
      if (r.instanceAdmin) {
        return { area, h: 'hx', f: 'f3', label: `${area}: instance administrator` };
      }
      const floor: Rung = r.floor?.[area] ?? 'none';
      const ceiling = Object.values(r.perSpace).reduce<Rung>(
        (hi, row) => (RANK[row[area] ?? 'none'] > RANK[hi] ? (row[area] as Rung) : hi), floor,
      );
      return {
        area,
        h: `h${RANK[ceiling]}`,
        // No mark when the floor is `none`: a line at the baseline would read as a floor of zero rather
        // than as no floor at all, and those are different facts.
        f: floor === 'none' ? '' : `f${RANK[floor]}`,
        label: `${area}: up to ${ceiling}${floor === 'none' ? '' : `, ${floor} everywhere`}`,
      };
    });
  });
}
