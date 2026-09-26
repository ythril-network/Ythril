import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RungPickerComponent } from './rung-picker.component';
import { SpaceAdminToggleComponent } from './space-admin-toggle.component';
import { RIGHT_AREAS, type Rung, type TokenRights, type WireRungs } from './rights-glyph.component';
import { RightsCatalogService } from './rights-catalog.service';

const EMPTY = (): WireRungs => Object.fromEntries(RIGHT_AREAS.map(a => [a, 'none'])) as WireRungs;

/**
 * The rights matrix: an all-spaces FLOOR on top, then one row per space.
 *
 * ## The floor is a minimum, not a bulk button
 *
 * Whatever it says, every space below is at least that — and so is every space created after this token was
 * minted. That is the whole reason the separate `spaces` allowlist could be dropped: a token reaches a
 * future space only if somebody said so here, deliberately, in advance.
 *
 * Rungs under the floor are therefore clamped in each cell rather than removed, so the reason a cell will
 * not go lower is visible where the click happens rather than inferred from a row above.
 *
 * ## Emits a whole matrix, never a patch
 *
 * The parent holds a draft and saves it as one thing. Emitting per-cell deltas would mean the parent
 * reassembles the object, which is a second place the shape is known — and the shape is what the server
 * caps and audits.
 */
@Component({
  selector: 'app-rights-matrix',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RungPickerComponent, SpaceAdminToggleComponent, TranslocoPipe],
  styles: [`
    :host { display: block; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--border-muted); padding: 8px 10px; text-align: center; }
    th.l, td.l { text-align: left; white-space: nowrap; font-weight: 600; }
    thead th { background: var(--bg-elevated); font-size: 11.5px; color: var(--text-secondary); font-weight: 620; }
    tr.floor td { background: color-mix(in srgb, var(--accent) 6%, transparent); }
    tr.floor { border-bottom: 2px solid var(--accent); }
    tr.floor td.l { color: var(--accent); }
    td.l small { display: block; font-weight: 400; font-size: 11px; color: var(--text-muted); }
    .area-info {
      /* Flex-centred, not left to text metrics. A bare ? has left side bearing, so in a 15px circle at
         10px it sits visibly left of centre - reported as the help question-marks being off. A button's
         default text centring works on the ADVANCE width, which is not where the ink is. */
      display: inline-flex; align-items: center; justify-content: center;
      margin-left: 5px; width: 15px; height: 15px; padding: 0; line-height: 1;
      border: 1px solid var(--border); border-radius: 50%;
      background: var(--bg-surface); color: var(--text-muted);
      font-size: 10px; font-weight: 700; cursor: pointer; vertical-align: middle;
    }
    .area-info:hover { border-color: var(--accent); color: var(--accent); }
    .area-info[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
    .explain {
      margin: 10px 0 2px; padding: 10px 12px; text-align: left;
      border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated);
    }
    .explain h4 { margin: 0 0 4px; font-size: 12.5px; }
    .explain p { margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); }
    .explain .rungs { margin: 0 0 8px; padding: 0; list-style: none; font-size: 12px; }
    .explain .rungs li { margin: 2px 0; color: var(--text-secondary); }
    .explain .rungs code { font-weight: 650; color: var(--text-primary); }
    .explain table { font-size: 11.5px; font-family: var(--font-mono, monospace); }
    .explain table th, .explain table td { padding: 3px 8px; text-align: left; border-bottom: none; }
    .explain .meth { color: var(--accent); font-weight: 650; }
    .explain .needs { color: var(--text-muted); }
    .explain .scroll { max-height: 240px; overflow-y: auto; }
    .explain .miss { font-size: 12px; color: var(--text-muted); }
  `],
  template: `
    <table>
      <thead>
        <tr>
          <th class="l">{{ 'tokens.rights.space' | transloco }}</th>
          @for (a of areas; track a) {
            <th>
              {{ 'tokens.rights.area.' + a | transloco }}
              <!-- The non-technical half rides on the header as a title, so it needs no click. The technical
                   half is a click, because a 37-route list is not a tooltip. -->
              <button class="area-info" type="button"
                      [attr.title]="'tokens.rights.area.' + a + '.desc' | transloco"
                      [attr.aria-label]="'tokens.rights.explain' | transloco"
                      [attr.aria-expanded]="explaining() === a"
                      (click)="toggleExplain(a)">?</button>
            </th>
          }
          <!-- SPACE ADMIN. A REAL grant since 5.0, not four cells read together: the toggle writes
               spaceAdmin and the server resolves it to admin in every area of that space. Before, what got
               stored was the four rungs, so the INTENT was lost on save and changing one cell afterwards
               withdrew the rung with nothing saying so. The column still reads the old spelling, so a token
               granted before this keeps showing as administered. -->
          <th class="admincol">
            {{ 'tokens.rights.spaceAdmin' | transloco }}
            <button class="area-info" type="button"
                    [attr.title]="'tokens.rights.spaceAdmin.desc' | transloco"
                    [attr.aria-label]="'tokens.rights.explain' | transloco"
                    [attr.aria-expanded]="explaining() === 'spaceAdmin'"
                    (click)="toggleExplain('spaceAdmin')">?</button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr class="floor">
          <td class="l">{{ 'tokens.rights.allSpaces' | transloco }}<small>{{ 'tokens.rights.allSpacesHint' | transloco }}</small></td>
          @for (a of areas; track a) {
            <td>
              <app-rung-picker [value]="floorShown(a)" [area]="a"
                               [implied]="floorImplied(a)?.rung ?? 'none'" [impliedBy]="floorImplied(a)?.by ?? null"
                               [readonlyView]="readonlyView()" (changed)="setFloor(a, $event)"/>
            </td>
          }
          <td class="admincol">
            <app-space-admin-toggle [on]="floorIsAdmin()" [readonlyView]="readonlyView() || !!rights().instanceAdmin"
                                    (changed)="setFloorAdmin($event)"/>
          </td>
        </tr>
        @for (s of spaces(); track s) {
          <tr>
            <td class="l">{{ s }}</td>
            @for (a of areas; track a) {
              <td>
                <app-rung-picker [value]="cellShown(s, a)" [area]="a" [floor]="floorOf(a)"
                                 [implied]="cellImplied(s, a)?.rung ?? 'none'" [impliedBy]="cellImplied(s, a)?.by ?? null"
                                 [readonlyView]="readonlyView()" (changed)="setCell(s, a, $event)"/>
              </td>
            }
            <td class="admincol">
              <app-space-admin-toggle [on]="isSpaceAdmin(s)" [readonlyView]="readonlyView()"
                                      (changed)="setSpaceAdmin(s, $event)"/>
            </td>
          </tr>
        }
      </tbody>
    </table>

    <!-- One panel, under the table, rather than a popover per column: the endpoint list for knowledge is 37
         rows, and a floating layer that long is unreadable inside a dialog that already scrolls.
         NOTE no backticks anywhere in this template, comments included — one ends the template string and the
         error points at @Component, never at the line that caused it. -->
    @if (explaining(); as a) {
      <div class="explain">
        <!-- SPACE ADMIN IS NOT AN AREA, so it gets the server's own words rather than an area key that does not
             exist. grants and excludes come from the rights-shape endpoint, where requires is computed from
             SPACE_AREAS — so this is the description that cannot drift. A sentence written here would be a second
             copy of a containment rule that has already been red-teamed. -->
        @if (a === 'spaceAdmin') {
          <h4>{{ 'tokens.rights.spaceAdmin' | transloco }}</h4>
          <p>{{ 'tokens.rights.spaceAdmin.desc' | transloco }}</p>
          @if (catalog.derived('spaceAdmin'); as d) {
            <ul class="rungs">
              <li>{{ 'tokens.rights.spaceAdmin.grants' | transloco }} {{ d.grants }}</li>
              <li>{{ 'tokens.rights.spaceAdmin.excludes' | transloco }} {{ d.excludes }}</li>
            </ul>
          }
          <!-- The routes NO area governs, from the server's own exemption list. This belongs in the Space
               Admin panel because it answers the question the panel raises: if the four areas do not cover
               renaming a space, what does. Before this the answer existed only in server source, so a grid
               of four areas read as complete while three space-scoped routes sat outside all of them. -->
          @if (catalog.notAreaScoped().length) {
            <p class="muted">{{ 'tokens.rights.notAreaScoped' | transloco }}</p>
            <ul class="rungs">
              @for (n of catalog.notAreaScoped(); track n.route) {
                <li><code>{{ n.route }}</code> — {{ n.why }}</li>
              }
            </ul>
          }
        } @else {
        <h4>{{ 'tokens.rights.area.' + a | transloco }}</h4>
        <p>{{ 'tokens.rights.area.' + a + '.desc' | transloco }}</p>

        <!-- The rung meanings are stated once, not once per area: a rung means the same thing everywhere,
             because each contains the one below. Four sentences instead of sixteen that can disagree. -->
        <ul class="rungs">
          @for (r of rungs; track r) {
            <li><code>{{ r }}</code> — {{ 'tokens.rights.rung.' + r + '.desc' | transloco }}</li>
          }
        </ul>

        @if (catalog.catalog()) {
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th>{{ 'tokens.rights.endpoint' | transloco }}</th>
                  <th>{{ 'tokens.rights.fromRung' | transloco }}</th>
                </tr>
              </thead>
              <tbody>
                @for (r of catalog.routesFor(a, 'admin'); track r.method + r.route) {
                  <tr>
                    <td><span class="meth">{{ r.method }}</span> {{ r.route }}</td>
                    <td class="needs">{{ r.needs }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else if (catalog.failed()) {
          <!-- The grid must not depend on its own explanation loading. -->
          <p class="miss">{{ 'tokens.rights.endpointsUnavailable' | transloco }}</p>
        }
        }
      </div>
    }
  `,
})
export class RightsMatrixComponent implements OnInit {
  rights = input.required<TokenRights>();
  spaces = input.required<string[]>();
  changed = output<TokenRights>();
  /** Display only — passed through to every cell. Used by the read-only view of your own rights. */
  readonlyView = input(false);

  readonly areas = RIGHT_AREAS;
  /** Every rung EXCEPT `none`, which needs no explanation beyond the word. */
  readonly rungs: Rung[] = ['read', 'write', 'admin'];

  readonly catalog = inject(RightsCatalogService);

  /** Which area's explanation is open, or null. One at a time — two open panels stack the table off-screen. */
  readonly explaining = signal<string | null>(null);

  ngOnInit(): void {
    // Asked for here rather than in the parent: any grid that renders is a grid someone may want explained,
    // and the service call is idempotent, so a second grid on the page costs nothing.
    this.catalog.load();
  }

  toggleExplain(area: string): void {
    this.explaining.update(cur => (cur === area ? null : area));
  }

  floorOf = (area: string): Rung => this.rights().floor?.[area] ?? 'none';

  /**
   * What another area entails for this one — read from the catalog, never described here.
   *
   * Two scopes, one rule. The floor is compared against the floor's own other areas, a cell against that
   * space's other areas, which is exactly the split the server makes between `floorRung` and `effectiveRung`.
   * Passing the WRITTEN rung rather than `cellOf` matters: an implication must be entailed by what somebody
   * set, or two rules could compose into a grant nobody wrote down.
   */
  floorImplied = (area: string) => this.catalog.impliedFor(area, a => this.floorOf(a));

  cellImplied = (space: string, area: string) =>
    this.catalog.impliedFor(area, a => {
      const row = this.rights().perSpace[space]?.[a] ?? 'none';
      const floor = this.floorOf(a);
      return rank(row) > rank(floor) ? row : floor;
    });

  /**
   * A cell shows the higher of its own row and the floor.
   *
   * Showing the stored row alone would display `none` for a space the token can in fact reach through the
   * floor — the cell would say one thing and the enforcement do another, in the direction that under-states
   * access. That is the direction that matters most on a screen somebody is auditing.
   */
  cellOf = (space: string, area: string): Rung => {
    const row = this.rights().perSpace[space]?.[area] ?? 'none';
    const floor = this.floorOf(area);
    return rank(row) > rank(floor) ? row : floor;
  };

  /**
   * What the cell DISPLAYS: the written rung raised by anything another area entails.
   *
   * Same argument as the floor one rung up. A cell showing `none` for schema while the token holds
   * `knowledge: write` would say one thing and the server do another, in the direction that under-states
   * access — which is the direction that matters on a screen somebody is auditing.
   *
   * Nothing is written down for it. The stored matrix keeps saying what the operator set, and the implication
   * is resolved at enforcement, so dropping knowledge back to `read` returns schema to whatever it was rather
   * than leaving a grant nobody chose. Storing the inferred rung is how a temporary implication becomes
   * permanent access.
   */
  cellShown = (space: string, area: string): Rung => {
    const held = this.cellOf(space, area);
    const implied = this.cellImplied(space, area);
    return implied && rank(implied.rung) > rank(held) ? implied.rung : held;
  };

  /** The floor cell's display value, raised the same way and for the same reason. */
  floorShown = (area: string): Rung => {
    const held = this.floorOf(area);
    const implied = this.floorImplied(area);
    return implied && rank(implied.rung) > rank(held) ? implied.rung : held;
  };

  setFloor(area: string, rung: Rung): void {
    const r = this.rights();
    this.changed.emit({ ...r, floor: { ...(r.floor ?? EMPTY()), [area]: rung } });
  }

  setCell(space: string, area: string, rung: Rung): void {
    const r = this.rights();
    const row = { ...(r.perSpace[space] ?? EMPTY()), [area]: rung };
    this.changed.emit({ ...r, perSpace: { ...r.perSpace, [space]: row } });
  }

  /**
   * Is this space administered — every area at its top rung?
   *
   * Reads the SHOWN value, not the stored one, so a row whose areas are all at admin because the floor put them
   * there reads as administered. That is what the server enforces, and a column that disagreed with the four
   * cells beside it would be worse than no column.
   */
  isSpaceAdmin = (space: string): boolean => {
    const sa = this.rights().spaceAdmin;
    return (sa?.floor ?? false) || (sa?.spaces ?? []).includes(space);
  };
  /** The floor row's toggle: administers EVERY space, including ones created later. */
  floorIsAdmin = (): boolean => this.rights().spaceAdmin?.floor ?? false;

  /**
   * Grant or withdraw space admin, writing the GRANT rather than four cells.
   *
   * ## What changed at 5.0, and why the old behaviour was not enough
   *
   * This column used to set the four rungs to `admin` and call that administering the space. It looked
   * identical from the operator's side and it was not the same thing: what got stored was four rungs, so
   * the intent was gone the moment it was saved. Changing one cell afterwards silently withdrew the rung
   * with nothing saying so, and nothing in the matrix could answer *"was this token MEANT to administer
   * this space"*.
   *
   * It now writes `spaceAdmin`, which the server resolves to `admin` through `grantedRung` in every area administering
   * a space covers — all but Networks, which stays its own column (F-34, `SPACE_ADMIN_AREAS`).
   * One emit, whole object — a loop would let a listener observe three inconsistent intermediate states,
   * and the parent form persists on change.
   *
   * The four rungs stay written as they were: a token granted the old way keeps working, and the column
   * reads either spelling, so nothing has to be migrated.
   */
  setSpaceAdmin(space: string, on: boolean): void {
    const r = this.rights();
    const held = new Set(r.spaceAdmin?.spaces ?? []);
    if (on) held.add(space); else held.delete(space);
    this.changed.emit({ ...r, spaceAdmin: { floor: r.spaceAdmin?.floor ?? false, spaces: [...held] } });
  }

  /** Same, for the floor. One emit, whole object. */
  setFloorAdmin(on: boolean): void {
    /*
     * The FLOOR form of the grant — every space, including ones created later.
     *
     * It used to set the four area floors to admin, which is a different statement: that grants maximal
     * rights over every space's DATA and, since 5.0, administration of none. The canary operator's token
     * is exactly this shape and runs their token inventory, so writing rungs here would have stopped it
     * working with nothing failing.
     */
    const r = this.rights();
    this.changed.emit({ ...r, spaceAdmin: { floor: on, spaces: r.spaceAdmin?.spaces ?? [] } });
  }
}

const ORDER: Rung[] = ['none', 'read', 'write', 'admin'];
const rank = (r: Rung): number => ORDER.indexOf(r);
