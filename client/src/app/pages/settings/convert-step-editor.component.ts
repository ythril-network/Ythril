import { NgTemplateOutlet } from '@angular/common';
import { AfterViewChecked, ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { pageTranslator } from '../../core/page-translator';
import type { TypedKind } from '../../core/type-field';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { CONVERSION_LIMITS } from '../../shared/conversion-limits';
import { enumValuesOf, sortEdits, typesOf, type AddedType, type ConvertSchemas, type EditStep } from './convert-steps';

/**
 * The step editor behind "Edit steps": one row per conversion step, as the green-lit drawing has them (bundle-285 slice S5, Q-747; plan
 * sections 3.1 item 5 and 5 rows E1 to E8; moments 1c, 2a, 2b and 6).
 *
 * The editor is CONTROLLED: it holds no steps of its own. The host (the Save dialog) gives it the rows and takes the whole new list on every
 * change, so the host alone decides what is sent, counted and refused. A row is text throughout (`EditStep`), so a row that is half typed
 * is a row; the host sends only the rows that are complete.
 *
 * ## What it prevents
 *
 * - **A split target that is the type being split.** The picker lists the kind's other staged types, then "Add a new type...", never the
 *   source: a record cannot move to the type it is already. Choosing the add option asks for a name in place; a confirmed name is REPORTED
 *   (`typeAdded`, with the type it is a copy of) and becomes the case's target, but the schema belongs to the host: the editor adds nothing
 *   to it. An empty name or a name the kind already has is refused in words and nothing is reported.
 * - **A number that was not counted.** No door counts a condition over the records, so a case says "counted as it runs" at every size,
 *   never "matches N" (owner, 2026-11-19).
 * - **A second type step.** The server refuses two type steps on one type, so once the block has a rename of the type or a split, neither
 *   is offered again; nothing is offered at all while the conversion holds as many steps as it may.
 * - **A bound the server would refuse.** The longest name and condition are the inputs' own `maxlength`; "+ Add a condition" and "+ Add a
 *   value" stop at the most a split or a map may hold (`CONVERSION_LIMITS`, pinned against the server's by the limits spec).
 * - **A refusal with no row.** The sentence of the server for a step (`errors`, by this editor's row) is under its own row as an alert, and
 *   `focusError` moves focus to it.
 * - **Escape closing too much.** Escape in the new-type name closes THAT field and stops there; every other Escape is left to the dialog
 *   around the editor, which closes the editor before itself.
 * - **A name taken for markup.** Every name is bound as text (interpolation and the value property), never as HTML.
 *
 * The source type of a split is a read-only field: the block names it, so an edit could only make the step belong to another block.
 */

type Row<Op extends EditStep['op']> = Extract<EditStep, { op: Op }>;
/** Which target of a split a picker sets: a case by its place, or the `otherwise`. */
type Slot = number | 'otherwise';

/** The width of a name field in characters, as the drawing sizes them: the name and some room, never narrower than 11 or wider than 42. */
const widthOf = (value: string): number => Math.min(Math.max(value.length + 6, 11), 42);

let seq = 0;

@Component({
  selector: 'app-convert-step-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TranslocoPipe, PhIconComponent],
  styles: [`
    :host { display: block; }
    .cv-steps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-primary); }
    .cv-step { display: grid; grid-template-columns: 150px minmax(0, 1fr) auto; gap: 6px 12px; align-items: start; padding: 10px 12px; border-bottom: 1px solid var(--border-muted); }
    .cv-step:last-child { border-bottom: 0; }
    .cv-verb { font-size: 12.5px; color: var(--text-secondary); padding-top: 6px; }
    .cv-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
    .cv-fields input, .cv-fields select { width: auto; max-width: 100%; min-width: 0; font-family: var(--font-mono); font-size: 12px; }
    .cv-fields .w { color: var(--text-muted); font-size: 12.5px; }
    .cv-fields input.mono { font-family: var(--font-mono); }
    .cv-tn { font-family: var(--font-mono); font-size: 12px; color: var(--accent); overflow-wrap: anywhere; }
    .cv-map, .cv-cases { flex: 1 1 100%; display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }
    .cv-map { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; gap: 6px 8px; align-items: center; justify-content: start; }
    .cv-case { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
    .cv-match { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
    .cv-help { margin: 2px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; max-width: 70ch; }
    .cv-newtype { flex: 1 1 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
    .cv-row-err { grid-column: 2 / -1; margin: 0; font-size: 12px; color: var(--error); overflow-wrap: anywhere; }
    .cv-row-err:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .cv-add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
    .sch-hint { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-muted); }
    @media (max-width: 760px) {
      .cv-step { grid-template-columns: minmax(0, 1fr) auto; }
      .cv-verb { grid-column: 1 / -1; padding-top: 0; }
      .cv-row-err { grid-column: 1 / -1; }
      .cv-match { white-space: normal; }
    }
  `],
  template: `
    @if (steps().length > 0) {
      <ul class="cv-steps">
        @for (s of steps(); track $index; let i = $index) {
          <li class="cv-step" [attr.data-op]="s.op">
            @if (renameProp(s); as r) {
              <div class="cv-verb">{{ 'conversion.editor.renameProperty' | transloco }}</div>
              <div class="cv-fields">
                <span class="w">{{ 'conversion.editor.on' | transloco }}</span><span class="cv-tn">{{ r.type }}</span>
                <input type="text" [attr.aria-label]="'conversion.editor.oldName' | transloco" [value]="r.from" [maxLength]="nameMax" [style.width.ch]="widthOf(r.from)" (change)="setText(i, 'from', $event)">
                <span class="w">{{ 'conversion.editor.to' | transloco }}</span>
                <input type="text" [attr.aria-label]="'conversion.editor.newName' | transloco" [value]="r.to" [maxLength]="nameMax" [style.width.ch]="widthOf(r.to)" (change)="setText(i, 'to', $event)">
              </div>
            } @else if (renameType(s); as t) {
              <div class="cv-verb">{{ 'conversion.editor.renameType' | transloco }}</div>
              <div class="cv-fields">
                <input type="text" [attr.aria-label]="'conversion.editor.oldTypeName' | transloco" [value]="t.from" [maxLength]="nameMax" [style.width.ch]="widthOf(t.from)" (change)="setText(i, 'from', $event)">
                <span class="w">{{ 'conversion.editor.to' | transloco }}</span>
                <input type="text" [attr.aria-label]="'conversion.editor.newTypeNameField' | transloco" [value]="t.to" [maxLength]="nameMax" [style.width.ch]="widthOf(t.to)" (change)="setText(i, 'to', $event)">
              </div>
            } @else if (mapEnum(s); as m) {
              <div class="cv-verb">{{ 'conversion.editor.mapEnum' | transloco }}</div>
              <div class="cv-fields">
                <span class="w">{{ 'conversion.editor.in' | transloco }}</span>
                <input type="text" [attr.aria-label]="'conversion.editor.property' | transloco" [value]="m.property" [maxLength]="nameMax" [style.width.ch]="widthOf(m.property)" (change)="setText(i, 'property', $event)">
                <span class="w">{{ 'conversion.editor.on' | transloco }}</span><span class="cv-tn">{{ m.type }}</span>
                <div class="cv-map">
                  @for (p of m.pairs; track $index; let k = $index) {
                    <input type="text" [attr.aria-label]="'conversion.editor.oldValue' | transloco" [value]="p.from" [style.width.ch]="widthOf(p.from)" (change)="setPair(i, k, 'from', $event)">
                    <span class="w">{{ 'conversion.editor.becomes' | transloco }}</span>
                    <select [attr.aria-label]="'conversion.editor.newValue' | transloco" (change)="setPair(i, k, 'to', $event)">
                      @if (p.to === '') { <option value="" selected></option> }
                      @for (v of valueOptions(m, p.to); track v) { <option [value]="v" [selected]="v === p.to">{{ v }}</option> }
                    </select>
                    <button class="icon-btn" type="button" [attr.aria-label]="'conversion.editor.removeValue' | transloco" [title]="'conversion.editor.removeValue' | transloco" (click)="removeValue(i, k)"><ph-icon name="x" [size]="12"/></button>
                  }
                </div>
                <button class="btn btn-ghost btn-sm" type="button" [attr.aria-label]="'conversion.editor.addValue' | transloco" [disabled]="m.pairs.length >= valuesMax" (click)="addValue(i)">{{ 'conversion.editor.addValue' | transloco }}</button>
              </div>
            } @else if (splitType(s); as sp) {
              <div class="cv-verb">{{ 'conversion.editor.splitType' | transloco }}</div>
              <div class="cv-fields">
                <span class="w">{{ 'conversion.editor.recordsOf' | transloco }}</span>
                <input type="text" readonly [attr.aria-label]="'conversion.editor.typeToSplit' | transloco" [value]="sp.from" [style.width.ch]="widthOf(sp.from)">
                <div class="cv-cases">
                  @for (c of sp.cases; track $index; let k = $index) {
                    <div class="cv-case">
                      <span class="w">{{ 'conversion.editor.if' | transloco }}</span>
                      <input class="mono" type="text" [attr.aria-label]="'conversion.editor.condition' | transloco" [value]="c.when" [maxLength]="conditionMax" style="flex: 1 1 220px; min-width: 0;" (change)="setWhen(i, k, $event)">
                      <span class="w">{{ 'conversion.editor.becomes' | transloco }}</span>
                      <select [attr.aria-label]="'conversion.editor.becomesType' | transloco" (change)="setTarget(i, k, $event)">
                        @if (c.to === '') { <option value="" selected></option> }
                        @for (t of targetOptions(sp, c.to); track t) { <option [value]="t" [selected]="t === c.to">{{ t }}</option> }
                        <option data-add value="">{{ 'conversion.editor.addNewType' | transloco }}</option>
                      </select>
                      <span class="cv-match">{{ 'conversion.editor.countedAsItRuns' | transloco }}</span>
                    </div>
                    @if (adding()?.row === i && adding()?.slot === k) { <ng-container *ngTemplateOutlet="newTypeField" /> }
                  }
                  <div class="cv-case">
                    <span class="w">{{ 'conversion.editor.otherwise' | transloco }}</span>
                    <select [attr.aria-label]="'conversion.editor.becomesType' | transloco" (change)="setTarget(i, 'otherwise', $event)">
                      @if (sp.otherwise === '') { <option value="" selected></option> }
                      @for (t of targetOptions(sp, sp.otherwise); track t) { <option [value]="t" [selected]="t === sp.otherwise">{{ t }}</option> }
                      <option data-add value="">{{ 'conversion.editor.addNewType' | transloco }}</option>
                    </select>
                    <span class="cv-match">{{ 'conversion.editor.countedAsItRuns' | transloco }}</span>
                    <button class="btn btn-ghost btn-sm" type="button" [disabled]="sp.cases.length >= casesMax" (click)="addCase(i)">{{ 'conversion.editor.addCondition' | transloco }}</button>
                  </div>
                  @if (adding()?.row === i && adding()?.slot === 'otherwise') { <ng-container *ngTemplateOutlet="newTypeField" /> }
                  <p class="cv-help">{{ 'conversion.editor.help' | transloco }}</p>
                </div>
              </div>
            }
            <button class="icon-btn danger" type="button" [title]="'conversion.editor.remove' | transloco" [attr.aria-label]="removeAria(s)" (click)="remove(i)"><ph-icon name="x" [size]="14"/></button>
            @if (errors()[i]; as error) {
              <p class="cv-row-err" role="alert" tabindex="-1" [attr.data-row]="i">{{ error }}</p>
            }
          </li>
        }
      </ul>
    }
    <div class="cv-add" role="group" [attr.aria-label]="'conversion.editor.addStep' | transloco">
      <span class="sch-hint">{{ 'conversion.editor.addStep' | transloco }}</span>
      <button class="btn btn-secondary btn-sm" type="button" [disabled]="!canAddStep()" (click)="add('renameProperty')">{{ 'conversion.editor.renameProperty' | transloco }}</button>
      <button class="btn btn-secondary btn-sm" type="button" [disabled]="!canAddStep()" (click)="add('mapEnum')">{{ 'conversion.editor.mapEnum' | transloco }}</button>
      <button class="btn btn-secondary btn-sm" type="button" [disabled]="!canAddStep() || hasTypeStep()" (click)="add('renameType')">{{ 'conversion.editor.renameType' | transloco }}</button>
      <button class="btn btn-secondary btn-sm" type="button" [disabled]="!canAddStep() || hasTypeStep()" (click)="add('splitType')">{{ 'conversion.editor.splitType' | transloco }}</button>
    </div>

    <ng-template #newTypeField>
      <div class="cv-newtype">
        <input type="text" #newName [attr.aria-label]="'conversion.editor.newTypeName' | transloco" [maxLength]="nameMax"
          (keydown.enter)="confirmNewType($event, newName.value)" (keydown.escape)="cancelNewType($event)" (change)="confirmNewType($event, newName.value)">
        @if (addError() === 'empty') { <span class="cv-row-err" role="alert">{{ 'spaces.schema.renameError.empty' | transloco }}</span> }
        @if (addError() === 'exists') { <span class="cv-row-err" role="alert">{{ 'spaces.schema.renameError.exists' | transloco }}</span> }
      </div>
    </ng-template>
  `,
})
export class ConvertStepEditorComponent implements AfterViewChecked {
  /** The rows, in the order they are shown and sent. */
  readonly steps = input.required<readonly EditStep[]>();
  /** The kind and the (staged) name of the type the block is for: new rows are made for them. */
  readonly kind = input.required<TypedKind>();
  readonly type = input.required<string>();
  /** The staged schema, with every type "Add a new type" made already in it: the pickers list its types, and a map reads its enum's values. */
  readonly staged = input.required<ConvertSchemas>();
  /** False while the conversion holds as many steps as it may: no step is offered. */
  readonly canAddStep = input(true);
  /** The server's sentence for a refused row, by this editor's row index. */
  readonly errors = input<Readonly<Record<number, string>>>({});
  /** The row whose sentence takes focus (when it has one). */
  readonly focusError = input<number | null>(null);

  /** The whole new list, after every change. */
  readonly stepsChange = output<EditStep[]>();
  /** A type "Add a new type" made: the host adds it to the staged schema as a copy of `copyOf`. */
  readonly typeAdded = output<AddedType>();

  protected readonly nameMax = CONVERSION_LIMITS.typeNameMax;
  protected readonly conditionMax = CONVERSION_LIMITS.conditionMax;
  protected readonly casesMax = CONVERSION_LIMITS.casesMax;
  protected readonly valuesMax = CONVERSION_LIMITS.valuesMax;
  protected readonly widthOf = widthOf;

  /** The picker whose "Add a new type..." was chosen, and what its name field says is wrong. */
  protected readonly adding = signal<{ row: number; slot: Slot; select: HTMLSelectElement } | null>(null);
  protected readonly addError = signal<'empty' | 'exists' | null>(null);

  protected readonly hasTypeStep = computed(() => this.steps().some(s => s.op === 'renameType' || s.op === 'splitType'));

  private readonly say = pageTranslator();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private focusedError: number | null = null;
  private focusNewName = false;
  private focusPicker: HTMLSelectElement | null = null;

  // ── Narrowing, for the template ──────────────────────────────────────────────────────────────────────────────────────

  protected renameProp(s: EditStep): Row<'renameProperty'> | null { return s.op === 'renameProperty' ? s : null; }
  protected renameType(s: EditStep): Row<'renameType'> | null { return s.op === 'renameType' ? s : null; }
  protected mapEnum(s: EditStep): Row<'mapEnum'> | null { return s.op === 'mapEnum' ? s : null; }
  protected splitType(s: EditStep): Row<'splitType'> | null { return s.op === 'splitType' ? s : null; }

  // ── What the pickers list ────────────────────────────────────────────────────────────────────────────────────────────

  /** The staged values of the map's property, and the one it already holds when the enum no longer lists it (shown as it is, never dropped). */
  protected valueOptions(row: Row<'mapEnum'>, current: string): string[] {
    const values = enumValuesOf(this.staged(), row.kind, row.type, row.property);
    return current !== '' && !values.includes(current) ? [...values, current] : values;
  }

  /** The kind's staged types other than the one being split (and than the block's own, which is the same type by its new name). */
  protected targetOptions(row: Row<'splitType'>, current: string): string[] {
    const types = typesOf(this.staged(), row.kind).filter(t => t !== row.from && t !== this.type());
    return current !== '' && current !== row.from && !types.includes(current) ? [...types, current] : types;
  }

  /** The accessible name of a row's remove button: which step it removes. */
  protected removeAria(s: EditStep): string {
    const to = this.say('conversion.editor.to');
    const what = s.op === 'renameProperty' || s.op === 'renameType' ? `${s.from} ${to} ${s.to}` : s.op === 'mapEnum' ? s.property : s.from;
    return this.say('conversion.editor.removeAria', { what });
  }

  // ── Changes ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private emit(next: EditStep[]): void { this.stepsChange.emit(next); }
  private replace(at: number, row: EditStep): EditStep[] { return this.steps().map((s, i) => (i === at ? row : s)); }
  private valueOf(event: Event): string { return (event.target as HTMLInputElement | HTMLSelectElement).value; }

  protected setText(at: number, field: 'from' | 'to' | 'property', event: Event): void {
    const row = this.steps()[at];
    if (!row) return;
    const value = this.valueOf(event);
    if ((field === 'property' && row.op === 'mapEnum') || (field !== 'property' && (row.op === 'renameProperty' || row.op === 'renameType'))) {
      this.emit(this.replace(at, { ...row, [field]: value } as EditStep));
    }
  }

  protected setPair(at: number, pair: number, field: 'from' | 'to', event: Event): void {
    const row = this.steps()[at];
    if (row?.op !== 'mapEnum') return;
    const value = this.valueOf(event);
    this.emit(this.replace(at, { ...row, pairs: row.pairs.map((p, k) => (k === pair ? { ...p, [field]: value } : p)) }));
  }

  protected addValue(at: number): void {
    const row = this.steps()[at];
    if (row?.op !== 'mapEnum' || row.pairs.length >= this.valuesMax) return;
    this.emit(this.replace(at, { ...row, pairs: [...row.pairs, { from: '', to: '' }] }));
  }

  protected removeValue(at: number, pair: number): void {
    const row = this.steps()[at];
    if (row?.op !== 'mapEnum') return;
    this.emit(this.replace(at, { ...row, pairs: row.pairs.filter((_, k) => k !== pair) }));
  }

  protected setWhen(at: number, caseAt: number, event: Event): void {
    const row = this.steps()[at];
    if (row?.op !== 'splitType') return;
    const when = this.valueOf(event);
    this.emit(this.replace(at, { ...row, cases: row.cases.map((c, k) => (k === caseAt ? { ...c, when } : c)) }));
  }

  protected addCase(at: number): void {
    const row = this.steps()[at];
    if (row?.op !== 'splitType' || row.cases.length >= this.casesMax) return;
    this.emit(this.replace(at, { ...row, cases: [...row.cases, { when: '', to: '' }] }));
  }

  /** A picker changed: a type to move to, or the add option, which asks for a name in place and changes nothing yet. */
  protected setTarget(at: number, slot: Slot, event: Event): void {
    const row = this.steps()[at];
    if (row?.op !== 'splitType') return;
    const select = event.target as HTMLSelectElement;
    if (select.selectedOptions[0]?.hasAttribute('data-add')) {
      this.addError.set(null);
      this.focusNewName = true;
      this.adding.set({ row: at, slot, select });
      return;
    }
    this.adding.set(null);
    this.emit(this.replace(at, this.withTarget(row, slot, select.value)));
  }

  private withTarget(row: Row<'splitType'>, slot: Slot, to: string): Row<'splitType'> {
    return slot === 'otherwise' ? { ...row, otherwise: to } : { ...row, cases: row.cases.map((c, k) => (k === slot ? { ...c, to } : c)) };
  }

  /** The current target of a picker, to put the picker back on when its add is cancelled. */
  private targetOf(row: Row<'splitType'>, slot: Slot): string { return slot === 'otherwise' ? row.otherwise : (row.cases[slot]?.to ?? ''); }

  protected confirmNewType(event: Event, raw: string): void {
    event.stopPropagation();
    const pending = this.adding();
    const row = pending ? this.steps()[pending.row] : undefined;
    if (!pending || row?.op !== 'splitType') return;
    const name = raw.trim();
    if (name === '') { this.addError.set('empty'); return; }
    if (name.length > this.nameMax || typesOf(this.staged(), row.kind).includes(name)) { this.addError.set('exists'); return; }
    this.addError.set(null);
    this.adding.set(null);
    this.focusPicker = pending.select;
    this.typeAdded.emit({ kind: row.kind, name, copyOf: this.type() });
    this.emit(this.replace(pending.row, this.withTarget(row, pending.slot, name)));
  }

  /** Escape in the name field closes that field and nothing else: the dialog around the editor never hears it. */
  protected cancelNewType(event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    const pending = this.adding();
    const row = pending ? this.steps()[pending.row] : undefined;
    if (pending && row?.op === 'splitType') pending.select.value = this.targetOf(row, pending.slot);
    this.adding.set(null);
    this.addError.set(null);
    this.focusPicker = pending?.select ?? null;
  }

  protected remove(at: number): void {
    if (this.adding()?.row === at) this.adding.set(null);
    this.emit(this.steps().filter((_, i) => i !== at));
  }

  /** A new, empty row of this kind, for this block's type; a type step goes where the type steps go. */
  protected add(op: EditStep['op']): void {
    const kind = this.kind();
    const type = this.type();
    const row: EditStep = op === 'renameProperty' ? { op, kind, type, from: '', to: '' }
      : op === 'mapEnum' ? { op, kind, type, property: '', pairs: [{ from: '', to: '' }] }
      : op === 'renameType' ? { op, kind, from: type, to: '' }
      : { op, kind, from: type, cases: [{ when: '', to: '' }], otherwise: '' };
    this.emit(sortEdits([...this.steps(), row]));
  }

  // ── Focus ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** After each render: focus what was asked for once it exists (a refused row's sentence, the new-type name, a picker put back). */
  ngAfterViewChecked(): void {
    const root = this.host.nativeElement;
    const wanted = this.focusError();
    if (wanted === null) this.focusedError = null;
    else if (wanted !== this.focusedError) {
      const el = root.querySelector<HTMLElement>(`[data-row="${wanted}"]`);
      if (el) { el.focus(); this.focusedError = wanted; }
    }
    if (this.focusNewName) {
      const field = root.querySelector<HTMLInputElement>('.cv-newtype input');
      if (field) { field.focus(); this.focusNewName = false; }
    }
    if (this.focusPicker) { this.focusPicker.focus(); this.focusPicker = null; }
  }
}
