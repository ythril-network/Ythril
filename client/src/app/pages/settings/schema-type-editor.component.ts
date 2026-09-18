/**
 * The per-type schema editor — one component, two hosts.
 *
 * ## Why it exists
 *
 * This body lived inside `space-schema-tab.component.ts`, bound to `SpaceSettingsState` through
 * `state.typeState(kt, name)` on roughly thirty template expressions. That made it unreachable from
 * anywhere else, and the Brain Overview's data-model panel needs exactly this editor in place — sending an
 * operator to Space Settings to change one field, and then back, is the flow this whole feature exists to
 * remove.
 *
 * `SpaceSettingsState` is `@Injectable()` with no `providedIn`, so it is provided by the settings page and
 * the Brain page cannot inject it. Root-providing it would turn per-space editing state into a cross-page
 * singleton, which is worse than the problem. So this component takes a DRAFT and edits it.
 *
 * ## What it deliberately does NOT do
 *
 * **It does not save.** The two hosts persist differently and must keep doing so: Space Settings is STAGED
 * (edit several types, then Save) while the Overview panel is IMMEDIATE (edit one type, write it now). A
 * save in here would force one host to adopt the other's model. The panel's write must additionally go
 * through `PATCH /api/spaces/:id` rather than `PUT /:id/schema`, which applies directly and would be a
 * silent consensus bypass on a networked space.
 *
 * **It does not own the library actions.** Export, save-to-library, unlink and remove stay with the settings
 * tab's header. Those are about the schema LIBRARY and about deleting a type, not about editing one, and the
 * Overview panel has no business offering them — a dialog that could delete a type would be answerable for
 * something no caller asked it to do. `unlink` is emitted rather than performed, because the read-only
 * notice that offers it lives in this body while the action belongs to the host.
 *
 * **It does not read the space config.** The inherited retention window arrives as an input; the component
 * has no opinion about where a space keeps its defaults.
 *
 * ## What it DOES own
 *
 * Which property rows are expanded. That is view state, not schema — the settings tab kept one set spanning
 * every type it had open, and a dialog editing a single type has no use for that. It is also why
 * `addProp` in `type-schema-edits.ts` returns the key it added rather than a boolean: the caller expands the
 * row it just created.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { HscrollTopDirective } from '../../shared/hscroll-top.directive';
import type { KnowledgeType, PropertySchema } from '../../core/api.types';
import type { TypeSchemaState } from './space-settings-state.service';
import {
  addProp, removeProp, addEnumVal, removeEnumVal,
  toggleEndpoint, endpointsFor, isAnyEnd, endpointPairs, endNamesFor, isStaleEndName, UNTYPED_END, type EndpointSide,
} from './type-schema-edits';
import { SCHEMA_MD_STYLES } from './schema-styles';
import { CHIP_STYLES } from '../../shared/chip.styles';
import { PROP_TABLE_STYLES } from '../../shared/prop-table.styles';
import { mergeFnsFor, mergeFnAfterTypeChange } from '../../shared/merge-fns';

@Component({
  selector: 'app-schema-type-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, TranslocoPipe, PhIconComponent, HscrollTopDirective],
  // Neither of these is decoration, and BOTH came loose when this editor was extracted out of the schema tab.
  // Angular scopes styles, so a class this template renders and this array does not define gets browser
  // defaults — with no error, in a component that still works perfectly.
  //
  // CHIP_STYLES: `.chip-wrap`/`.chip`/`.chip-rm`/`.chip-field`, the oversized enum remove button
  // the canary operator reported.
  //
  // PROP_TABLE_STYLES: `.prop-table`/`.prop-row`/`.prop-caret`/`.pdet`/`.pdet-fields`/`.req-toggle`. Missing
  // for longer and reported by the owner on 2026-08-15 with a screenshot — the Required pill rendered as a
  // raw checkbox with its label wrapped under it, and the detail card lost both its column grid and its
  // padding, so every field ran edge to edge with its label against the dialog border.
  styles: [SCHEMA_MD_STYLES, CHIP_STYLES, PROP_TABLE_STYLES],
  template: `
@if (libRef(); as libRef) {
  <!-- Linked library schema — editable only after unlinking; shown read-only meanwhile. -->
  <div style="display:flex;align-items:center;gap:10px;padding:4px 0;color:var(--text-secondary);font-size:13px;">
    <ph-icon name="bookmarks" [size]="16" style="color:var(--accent);flex-shrink:0;"/>
    <span>{{ 'spaces.schema.libRef.linkedHint' | transloco: {name: libRef} }}</span>
    <button class="btn btn-secondary btn-sm" type="button" style="margin-left:auto;flex-shrink:0;"
      (click)="unlink.emit()" [attr.title]="'spaces.schema.libRef.unlinkTitle' | transloco">{{ 'spaces.schema.libRef.unlinkButton' | transloco }}</button>
  </div>
  <!-- Read-only view of the linked entry's properties, so you can see what the type enforces
       without unlinking first. -->
  @if (linkedProps(); as props) {
    @if (props.length) {
      <div class="sch-section-label" style="margin-top:12px;">{{ 'spaces.schema.propertySchemas' | transloco }}</div>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th style="width:150px;">{{ 'spaces.schema.propTable.property' | transloco }}</th>
              <th style="width:80px;">{{ 'spaces.schema.propTable.type' | transloco }}</th>
              <th>{{ 'spaces.schema.propTable.constraints' | transloco }}</th>
            </tr>
          </thead>
          <tbody>
            @for (p of props; track p.key) {
              <tr>
                <td style="font-family:var(--font-mono);font-size:12.5px;">{{ p.key }}</td>
                <td>{{ p.s.type || '—' }}</td>
                <td style="color:var(--text-secondary);font-size:12.5px;">{{ propConstraintSummary(p.s) }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="sch-hint" style="margin-top:8px;">{{ 'spaces.schema.libRef.noProps' | transloco }}</div>
    }
  }
} @else {
  <!-- WHAT THIS TYPE IS FOR, in the operator's own words. F-24, and it is deliberately prose: the
       reader is a model, and everything a model needs from a semantic layer is satisfied by a
       sentence. What is NOT satisfied is anything the engine must act on, which is why this is not
       an ontology and does not pretend to be one.
       First in the pane because it is what somebody opening an unfamiliar type wants to read. -->
  <div class="field" style="margin:0 0 12px;">
    <label>{{ 'spaces.schema.typeDescription' | transloco }} <span class="sch-hint">{{ 'spaces.schema.typeDescriptionHint' | transloco }}</span></label>
    <textarea rows="2" [(ngModel)]="d().description" [placeholder]="'spaces.schema.typeDescriptionPlaceholder' | transloco"></textarea>
  </div>
  <!-- Naming pattern (entity only) -->
  @if (knowledgeType() === 'entity') {
    <div class="field" style="margin:0 0 12px;">
      <label>{{ 'spaces.schema.namingPattern' | transloco }} <span class="sch-hint">{{ 'spaces.schema.namingPatternHint' | transloco }}</span></label>
      <input type="text" [(ngModel)]="d().namingPattern" [placeholder]="'spaces.schema.namingPatternPlaceholder' | transloco" style="max-width:320px;" />
    </div>
  }
  <!-- Retention — the SCHEMA tier of record > schema > space, and the control the Danger Zone, the
       integration guide and the API have all been pointing at. It belongs here, beside the type's
       other rules, rather than in a second parallel map an operator has to know exists.

       The hint names what an empty field inherits, with the space default's actual number in it: the
       operator who asked for this said the old arrangement was a convention they had to know, and
       "inherit" without saying inherit-WHAT is the same failure one level down.

       NOTE: no backticks anywhere in this comment — one kills the whole template string and the
       error then points at @Component. -->
  <div class="sch-section-label">{{ 'spaces.schema.retention.label' | transloco }}
    <!-- The inherited number is THIS collection's bucket, not one space-wide figure: the space tier is
         five windows, and naming the wrong one would be worse than naming none. -->
    <span class="sch-hint">
      @if (spaceWindowDays(); as days) {
        {{ 'spaces.schema.retention.hintSpace' | transloco: { days } }}
      } @else {
        {{ 'spaces.schema.retention.hintNoSpace' | transloco }}
      }
    </span>
  </div>
  <div class="ret-row">
    <div class="field" style="margin:0;">
      <label>{{ 'spaces.schema.retention.days' | transloco }}</label>
      <input type="number" min="1" step="1" [(ngModel)]="d().retentionDays"
        [placeholder]="'spaces.schema.retention.inherit' | transloco" />
    </div>
    <!-- chrono only, because that is the only collection whose sweep implements it. Offering it on
         the others would store a number that never fires. -->
    @if (knowledgeType() === 'chrono') {
      <div class="field" style="margin:0;">
        <label>{{ 'spaces.schema.retention.contentDays' | transloco }}</label>
        <input type="number" min="1" step="1" [(ngModel)]="d().retentionContentDays"
          [placeholder]="'spaces.schema.retention.never' | transloco" />
        <div class="sch-hint" style="margin-top:3px;">{{ 'spaces.schema.retention.contentDaysHint' | transloco }}</div>
      </div>
    }
  </div>
  <!-- The server CLAMPS a content window that is not strictly inside the delete window (it would
       never fire), so without this the field would accept a number and silently do nothing. -->
  @if (contentWindowNeverFires(); as total) {
    <div class="sch-msg err">{{ 'spaces.schema.retention.contentTooLate' | transloco: { total } }}</div>
  }
  <!-- chrono only, and three states for the same reason the suppression control below has three: "inherit"
       is the space setting, and the other two are deliberate overrides in each direction. A type that says
       nothing must reach the space tier, which a two-state control could not express. -->
  @if (knowledgeType() === 'chrono') {
    <div class="field">
      <label>{{ 'spaces.schema.whenDuePasses.label' | transloco }}</label>
      <select [ngModel]="whenDueValue()" (ngModelChange)="setWhenDue($event)" style="max-width:320px;">
        <option value="inherit">{{ 'spaces.schema.whenDuePasses.inherit' | transloco }}</option>
        <option value="overdue">{{ 'spaces.schema.whenDuePasses.overdue' | transloco }}</option>
        <option value="nothing">{{ 'spaces.schema.whenDuePasses.nothing' | transloco }}</option>
      </select>
      <div class="sch-hint" style="margin-top:3px;">{{ 'spaces.schema.whenDuePasses.hint' | transloco }}</div>
    </div>
  }
  <!-- Three states, not a checkbox. "Inherit" is the space setting and is the DEFAULT; the other two are
       deliberate overrides in each direction. A two-state control could not express "embed this type even
       though the space suppresses", and it would write a value on every save for types nobody touched. -->
  <div class="field">
    <label>{{ 'spaces.schema.suppressEmbeddings.label' | transloco }}</label>
    <select [ngModel]="suppressValue()" (ngModelChange)="setSuppress($event)" style="max-width:320px;">
      <option value="inherit">{{ 'spaces.schema.suppressEmbeddings.inherit' | transloco }}</option>
      <option value="on">{{ 'spaces.schema.suppressEmbeddings.on' | transloco }}</option>
      <option value="off">{{ 'spaces.schema.suppressEmbeddings.off' | transloco }}</option>
    </select>
    <div class="sch-hint" style="margin-top:3px;">{{ 'spaces.schema.suppressEmbeddings.hint' | transloco }}</div>
    @if (d().suppressEmbeddings === true) {
      <div class="sch-msg warn">{{ 'spaces.schema.suppressEmbeddings.noBackfill' | transloco }}</div>
    }
  </div>
  <!-- An edge label's permitted ENDS and its cardinality.
       Two fields both API doors have accepted since S-1, both reported by the space validator, and both
       carried safely through a save — with no control to set either one until now. Filed as G-12 and named
       by that change's two NO_CONTROL entries, so the exemption could not become permanent by neglect.

       Edge only: the API refuses both on the other three collections.

       The pair preview is not decoration. Two lists mean the CROSS PRODUCT and not pairing by position
       (owner ruling, 2026-08-31), and two lists side by side imply pairs to almost everybody. Two names on
       the left and three on the right is SIX permitted edges, and a control that leaves the reader to work
       that out from the layout says something the API does not do.

       NOTE: no backticks in this comment — one ends the template string and the error points at
       @Component instead of at the line. -->
  @if (knowledgeType() === 'edge') {
    <div class="sch-section-label">{{ 'spaces.schema.ends.label' | transloco }}
      <span class="sch-hint">{{ 'spaces.schema.ends.hint' | transloco }}</span>
    </div>
    @if (!entityTypeNames().length) {
      <div class="sch-hint" style="margin-bottom:6px;">{{ 'spaces.schema.ends.noEntityTypes' | transloco }}</div>
    }
    <div class="ends-row">
      @for (side of SIDES; track side) {
        <div class="field" style="margin:0;">
          <label>{{ (side === 'from' ? 'spaces.schema.ends.from' : 'spaces.schema.ends.to') | transloco }}</label>
          <div class="ends-list">
            @for (name of endNames(); track name) {
              <label class="ends-opt">
                <input type="checkbox" [checked]="isPicked(side, name)" (change)="onToggleEnd(side, name)" />
                @if (name === UNTYPED_END) {
                  <span class="any">{{ 'spaces.schema.ends.untyped' | transloco }}</span>
                } @else if (isStaleEnd(name)) {
                  <!-- Declared on this edge and no longer a type the space has. Ticked, enforced, and
                       until B-16 there was no checkbox for it at all — so it could not be removed. -->
                  <span class="nm">{{ name }}</span>
                  <span class="sch-hint">{{ 'spaces.schema.ends.deletedType' | transloco }}</span>
                } @else {
                  <span class="nm">{{ name }}</span>
                }
              </label>
            }
          </div>
          <div class="sch-hint" style="margin-top:3px;">
            @if (isAnyEnd(side)) {
              {{ 'spaces.schema.ends.anyType' | transloco }}
            } @else {
              {{ 'spaces.schema.ends.restricted' | transloco: { count: picked(side).length } }}
            }
          </div>
        </div>
      }
    </div>
    @if (pairs().length) {
      <div class="sch-msg info">
        {{ 'spaces.schema.ends.pairs' | transloco: { count: pairs().length } }}
        <div class="ends-pairs">
          @for (p of shownPairs(); track p) { <span class="badge badge-gray">{{ p }}</span> }
          @if (pairs().length > shownPairs().length) {
            <span class="sch-hint">{{ 'spaces.schema.ends.morePairs' | transloco: { count: pairs().length - shownPairs().length } }}</span>
          }
        </div>
      </div>
    }
    <div class="field">
      <label class="ends-opt">
        <input type="checkbox" [checked]="d().functional === true" (change)="onToggleFunctional()" />
        <span>{{ 'spaces.schema.ends.functional' | transloco }}</span>
      </label>
      <div class="sch-hint" style="margin-top:3px;">{{ 'spaces.schema.ends.functionalHint' | transloco }}</div>
    </div>
  }
  <!-- Per-type tag suggestions were retired here. The editor reached nothing: not the Brain
       record forms (they suggest from tags already in use) and not the schema guidance sent to
       MCP clients. Offering a control that does nothing is the dishonesty the Models rebuild
       spent four PRs removing, and it is the same reasoning that retired the space-wide list
       in #365. Stored values are preserved — see the note on TypeSchema.tagSuggestions. -->
  <!-- Property schemas -->
  <!-- Every other section in this pane explains itself; this one did not, and it is the one
       doing the most work. The hint also points at the control that decides enforcement,
       which is a whole panel away at the top of the tab. -->
  <div class="sch-section-label">{{ 'spaces.schema.propertySchemas' | transloco }}
    <span class="sch-hint">{{ 'spaces.schema.propertySchemasHint' | transloco }}</span></div>
  <div class="table-wrapper" hscrollTop style="margin-bottom:0;">
    <table class="prop-table" style="margin-bottom:0;">
      <thead>
        <tr>
          <th style="width:30px;"></th>
          <th style="width:150px;">{{ 'spaces.schema.propTable.property' | transloco }}</th>
          <th style="width:80px;">{{ 'spaces.schema.propTable.type' | transloco }}</th>
          <th>{{ 'spaces.schema.propTable.constraints' | transloco }}</th>
          <th style="width:40px;"></th>
        </tr>
      </thead>
      <tbody>
        @for (p of d().propertySchemas; track p.key) {
          <tr class="prop-row" [class.prow-open]="isOpen(p.key)"
            (click)="toggleOpen(p.key)">
            <td><span class="prop-caret"><ph-icon [name]="isOpen(p.key) ? 'caret-up' : 'caret-down'" [size]="13"/></span></td>
            <td>
              <div class="prop-name">
                <span class="prop-name-key">{{ p.key }}</span>
                <label class="req-toggle" [class.is-req]="p.s.required" (click)="$event.stopPropagation()">
                  <input type="checkbox" [checked]="p.s.required" (change)="p.s.required = !p.s.required" />
                  {{ 'spaces.schema.propDetail.required' | transloco }}
                </label>
              </div>
            </td>
            <td><span class="badge badge-gray">{{ p.s.type ?? 'any' }}</span></td>
            <td style="font-size:11px;color:var(--text-muted);">
              @if (p.s.enum?.length) { <span class="badge badge-gray" style="margin-right:3px">enum {{ p.s.enum!.length }}</span> }
              @if (p.s.minimum!==undefined) { <span style="margin-right:4px;">min:{{ p.s.minimum }}</span> }
              @if (p.s.maximum!==undefined) { <span style="margin-right:4px;">max:{{ p.s.maximum }}</span> }
              @if (p.s.pattern) { <span style="margin-right:4px;">pattern</span> }
              @if (p.s.default!==undefined) { <span style="margin-right:4px;">default:{{ p.s.default }}</span> }
              @if (p.s.mergeFn) { <span class="badge badge-blue">{{ p.s.mergeFn }}</span> }
            </td>
            <td (click)="$event.stopPropagation()">
              <button class="icon-btn danger" type="button" (click)="onRemoveProp(p.key)" [attr.title]="'common.remove' | transloco"><ph-icon name="x" [size]="14"/></button>
            </td>
          </tr>
          @if (isOpen(p.key)) {
            <tr class="prop-expand-row" (click)="$event.stopPropagation()">
              <td colspan="5" style="padding:0;">
                <div class="pdet">
                  <!-- WHAT THE PROPERTY MEANS (F-24). The type says a value is a number; this says it
                       is the retry BUDGET rather than the retry count. Full width above the grid
                       because it is a sentence, not a field. -->
                  <div class="field" style="margin:0 0 8px;">
                    <label>{{ 'spaces.schema.propDetail.description' | transloco }}</label>
                    <input type="text" [(ngModel)]="p.s.description"
                      [placeholder]="'spaces.schema.propDetail.descriptionPlaceholder' | transloco" />
                  </div>
                  <div class="pdet-fields">
                    <div class="field" style="margin:0;">
                      <label>{{ 'spaces.schema.propDetail.type' | transloco }}</label>
                      <select [(ngModel)]="p.s.type" (ngModelChange)="onTypeChange(p)">
                        <option [ngValue]="undefined">any</option>
                        <option value="string">string</option>
                        <option value="number">number</option>
                        <option value="boolean">boolean</option>
                        <option value="date">date</option>
                      </select>
                    </div>
                    <div class="field" style="margin:0;">
                      <label>{{ 'spaces.schema.propDetail.default' | transloco }}</label>
                      <input type="text" [(ngModel)]="p.s.default" placeholder="—" />
                    </div>
                    <!-- Only the functions the API accepts for this type. Offering all seven is what let a
                         date + min be chosen and then refused at save with a wall of zod JSON. -->
                    <div class="field" style="margin:0;">
                      <label>{{ 'spaces.schema.propDetail.mergeFn' | transloco }}</label>
                      <select [(ngModel)]="p.s.mergeFn" [disabled]="!mergeFnsFor(p.s.type).length">
                        <option [ngValue]="undefined">—</option>
                        @for (fn of mergeFnsFor(p.s.type); track fn) { <option [value]="fn">{{ fn }}</option> }
                      </select>
                      @if (!mergeFnsFor(p.s.type).length) {
                        <span class="sch-hint">{{ 'spaces.schema.propDetail.mergeFnUnavailable' | transloco }}</span>
                      }
                    </div>
                    @if (p.s.type==='string'||p.s.type===undefined) {
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.pattern' | transloco }} <span class="sch-hint">{{ 'spaces.schema.propDetail.patternHint' | transloco }}</span></label>
                        <input type="text" [(ngModel)]="p.s.pattern" placeholder="^[A-Z].*" />
                      </div>
                    }
                    @if (p.s.type==='number'||p.s.type===undefined) {
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.min' | transloco }}</label>
                        <input type="number" [(ngModel)]="p.s.minimum" placeholder="—" />
                      </div>
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.max' | transloco }}</label>
                        <input type="number" [(ngModel)]="p.s.maximum" placeholder="—" />
                      </div>
                    }
                  </div>
                  @if (p.s.type !== 'boolean') {
                    <div class="pdet-full">
                      <div class="field" style="margin:0;">
                        <label>{{ 'spaces.schema.propDetail.enumValues' | transloco }} <span class="sch-hint">{{ 'spaces.schema.propDetail.enumHint' | transloco }}</span></label>
                        <div class="chip-wrap">
                          @for (ev of (p.s.enum??[]); track ev) {
                            <span class="chip">{{ ev }}<button type="button" class="chip-rm" (click)="onRemoveEnum(p.key,ev)"><ph-icon name="x" [size]="12"/></button></span>
                          }
                          <input type="text" class="chip-field" [(ngModel)]="p._enumInput"
                            [placeholder]="'spaces.schema.propDetail.enumPlaceholder' | transloco" (keydown)="onEnumKey($event,p.key)" />
                        </div>
                      </div>
                    </div>
                  }
                </div>
              </td>
            </tr>
          }
        } @empty {
          <tr>
            <td colspan="5" style="padding:24px 0;text-align:center;color:var(--text-muted);font-size:13px;font-style:italic;">
              {{ 'spaces.schema.noProps' | transloco }}
            </td>
          </tr>
        }
      </tbody>
    </table>
  </div>
  <!-- add property — the same inline [input][+] affordance as the add-type row, so the two
       "add something" controls on this tab read and behave identically. -->
  <div class="sch-add-row sch-add-prop">
    <input type="text" [(ngModel)]="d()._newPropInput" [placeholder]="'spaces.schema.newPropNamePlaceholder' | transloco"
      [attr.aria-label]="'spaces.schema.addPropertyButton' | transloco"
      (keydown.enter)="$event.preventDefault();onAddProp()" />
    <button class="sch-add-btn" type="button"
      (click)="onAddProp()" [disabled]="!d()._newPropInput.trim()"
      [attr.title]="'spaces.schema.addPropertyButton' | transloco" [attr.aria-label]="'spaces.schema.addPropertyButton' | transloco">
      <ph-icon name="plus-circle" [size]="18"/>
    </button>
  </div>
}
  `,
})
export class SchemaTypeEditorComponent {
  private readonly transloco = inject(TranslocoService);

  /** Which collection the type belongs to. Only `chrono` offers a content-retention window. */
  readonly knowledgeType = input.required<KnowledgeType>();
  /** The draft being edited, IN PLACE. The host owns it and decides when it is persisted. */
  readonly draft = input.required<TypeSchemaState>();
  /** The library entry this type is linked to, if any — a linked type is read-only until unlinked. */
  readonly libRef = input<string | null>(null);
  /** A linked entry's properties, resolved by the host, for the read-only view. */
  readonly linkedProps = input<{ key: string; s: PropertySchema }[]>([]);
  /** The retention window this collection inherits from the space, or null. Shown as the fallback hint. */
  readonly spaceWindowDays = input<number | null>(null);
  /**
   * The entity type names this space declares — the vocabulary for an edge label's permitted ends.
   *
   * An input rather than something read from a service, because this component has two hosts and neither
   * one's state service is injectable from the other. A host that forgets it gets an ends picker offering
   * UNTYPED and nothing else, which is why the gate checks the binding rather than only the serialiser.
   */
  readonly entityTypeNames = input<string[]>([]);

  /** Asked for, not done: the notice lives here, the action belongs to the host. */
  readonly unlink = output<void>();

  /** Short alias so the template reads as `d().field` rather than repeating `draft()`. */
  readonly d = this.draft;

  // ── An edge label's ends and cardinality (G-12) ───────────────────────────────────────────────────────
  /** Both ends, in the order they read. A template constant so the two columns cannot drift apart. */
  readonly SIDES: EndpointSide[] = ['from', 'to'];
  readonly UNTYPED_END = UNTYPED_END;

  /**
   * The pickable names: the space's entity types, sorted, with UNTYPED last.
   *
   * Last rather than first deliberately. It is a real choice — "an entity carrying no type at all" — but it
   * is the unusual one, and at the top of the list it reads as a header or as the default.
   */
  readonly endNames = computed<string[]>(() => {
    /*
     * THE UNION OF THE VOCABULARY AND WHAT IS ALREADY PICKED — see `endNamesFor`, which holds the rule
     * and the reason. `B-16`, owner-reported: a name stored on the edge but no longer declared by the
     * space had no checkbox, so the declaration could not be removed.
     *
     * `endsTick()` because the draft is mutated in place, so unticking a stale name drops it from the
     * list for good. That is the intent rather than a wrinkle: it is not a type this space declares,
     * so it was never available to add in the first place.
     */
    this.endsTick();
    return endNamesFor(this.entityTypeNames(), this.draft());
  });

  /** True for a picked end the space no longer declares. Shown as such — see `isStaleEndName`. */
  isStaleEnd(name: string): boolean { return isStaleEndName(this.entityTypeNames(), name); }

  picked(side: EndpointSide): string[] { return endpointsFor(this.draft(), side); }
  isPicked(side: EndpointSide, name: string): boolean { return this.picked(side).includes(name); }
  isAnyEnd(side: EndpointSide): boolean { return isAnyEnd(this.draft(), side); }

  onToggleEnd(side: EndpointSide, name: string): void {
    toggleEndpoint(this.draft(), side, name);
    this.endsTick.update(n => n + 1);
  }

  /**
   * Unticking says NOT functional rather than declining to say.
   *
   * Unlike `suppressEmbeddings` this field has no inherit tier — the API takes a boolean or nothing — so
   * there is no third state to round-trip and `false` is a statement an operator can make.
   */
  onToggleFunctional(): void {
    const d = this.draft();
    d.functional = d.functional === true ? false : true;
    this.endsTick.update(n => n + 1);
  }

  /**
   * The draft is mutated IN PLACE by the host, so a computed over it would never recompute.
   *
   * The same reason the tree store bumps a signal after mutating its nodes: this component is `OnPush` and
   * the draft is a plain object, so nothing marks the view dirty on its own. Every edit here bumps this, and
   * the pair preview reads it.
   */
  private readonly endsTick = signal(0);

  /** Every pair this label permits — the cross product, which is the thing the layout does not say. */
  readonly pairs = computed<string[]>(() => { this.endsTick(); return endpointPairs(this.draft()); });

  /**
   * The pairs actually rendered. Capped, because two full sides are 50 x 50.
   *
   * The COUNT above it is never capped: a preview that showed twelve chips and no total would understate
   * the rule by two orders of magnitude, which is worse than showing nothing.
   */
  readonly shownPairs = computed<string[]>(() => this.pairs().slice(0, 12));

  // ── Expanded rows. Local, because it is view state and each host wants its own.
  private readonly openRows = signal<ReadonlySet<string>>(new Set());
  isOpen(key: string): boolean { return this.openRows().has(key); }
  toggleOpen(key: string): void {
    const next = new Set(this.openRows());
    if (!next.delete(key)) next.add(key);
    this.openRows.set(next);
  }

  // ── Edits, delegated to the pure operations so the settings tab and this component cannot diverge.
  onAddProp(): void {
    const key = addProp(this.draft());
    if (key !== null) this.toggleOpen(key);   // expand what was just created
  }
  onRemoveProp(key: string): void {
    removeProp(this.draft(), key);
    const next = new Set(this.openRows());
    next.delete(key);
    this.openRows.set(next);
  }
  /**
   * The merge functions this type may declare — the API's own rule, so the control cannot offer a refusal.
   *
   * A method rather than a pipe because the answer depends on a field the row owns and changes in place.
   */
  mergeFnsFor = mergeFnsFor;

  /**
   * Changing the type clears a merge function the new type cannot hold.
   *
   * This component had NO type-change handler at all — the shared `prop-schema-table` had one and this copy
   * did not, which is the same one-rule-two-implementations split that lost its stylesheet. Without it,
   * switching `number` to `date` leaves `min` behind, invisible, until the save is refused for a field the
   * operator was not editing.
   */
  onTypeChange(p: { s: PropertySchema }): void {
    p.s.mergeFn = mergeFnAfterTypeChange(p.s.type, p.s.mergeFn);
  }

  onAddEnum(key: string): void { addEnumVal(this.draft(), key); }
  onRemoveEnum(key: string, val: string | number | boolean): void { removeEnumVal(this.draft(), key, val); }
  onEnumKey(e: KeyboardEvent, key: string): void {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); this.onAddEnum(key); }
  }

  /**
   * The effective delete window when a chrono type's content window sits at or beyond it — else null.
   *
   * Mirrors `contentDays()` on the server exactly, including its fall-through: a type with no `days` of its
   * own is still deleted at the SPACE default, so a 30-day content window under a 30-day space default never
   * fires either. Returning the number lets the message say which window it lost to, which is the part an
   * operator cannot work out from the two fields in front of them.
   */
  readonly contentWindowNeverFires = computed<number | null>(() => {
    if (this.knowledgeType() !== 'chrono') return null;
    const s = this.draft();
    const content = Number(s.retentionContentDays);
    if (!Number.isFinite(content) || content <= 0) return null;
    const total = Number(s.retentionDays) || this.spaceWindowDays() || 0;
    return total > 0 && content >= total ? total : null;
  });

  /**
   * The tri-state suppression control, as a select value.
   *
   * `null` is "inherit" and must round-trip as `null` — mapping it to `false` would write a decision on every
   * save for every type nobody edited, and pin each of them to embedding regardless of the space setting.
   */
  readonly suppressValue = computed<'inherit' | 'on' | 'off'>(() => {
    const v = this.draft().suppressEmbeddings;
    return v === null || v === undefined ? 'inherit' : v ? 'on' : 'off';
  });

  setSuppress(v: 'inherit' | 'on' | 'off'): void {
    this.draft().suppressEmbeddings = v === 'inherit' ? null : v === 'on';
  }
  /** `null` is NOT STATED and shows as inherit — the tier below answers. See `TypeSchema.whenDuePasses`. */
  whenDueValue(): 'inherit' | 'overdue' | 'nothing' { return this.draft().whenDuePasses ?? 'inherit'; }
  setWhenDue(v: 'inherit' | 'overdue' | 'nothing'): void {
    this.draft().whenDuePasses = v === 'inherit' ? null : v;
  }
  /**
   * One line summarising a property's constraints, for the collapsed row.
   *
   * Moved here with the body it serves. It reads nothing but the property it is given, so it had no reason
   * to stay behind on the tab once the rows did.
   */
  propConstraintSummary(s: PropertySchema): string {
    const parts: string[] = [];
    if (s.required) parts.push(this.transloco.translate('spaces.schema.propDetail.required'));
    if (s.enum?.length) parts.push(`${this.transloco.translate('spaces.schema.propDetail.enumValues')}: ${s.enum.join(', ')}`);
    if (s.minimum != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.min')} ${s.minimum}`);
    if (s.maximum != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.max')} ${s.maximum}`);
    if (s.pattern) parts.push(`/${s.pattern}/`);
    if (s.default != null) parts.push(`${this.transloco.translate('spaces.schema.propDetail.default')} ${s.default}`);
    return parts.join(' · ') || '—';
  }
}
