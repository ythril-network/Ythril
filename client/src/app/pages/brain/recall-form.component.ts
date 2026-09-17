import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { PhIconComponent } from '../../shared/ph-icon.component';
import type { RecallKnowledgeType } from '../../core/api.types';
import { recallRequestJson } from './recall-request';

/**
 * The recall form's state, mutated IN PLACE by the controls. The host owns it and decides when it runs.
 *
 * **Every parameter `recall` accepts has a field here except `space`**, which the panel takes from the page it
 * is opened on — a selector would let a search run against a space the page is not showing and then render
 * the results under this one's name. `query-panel-offers-every-recall-parameter.test.js` derives the list from
 * the tool's own schema and fails while one is unreachable, so a parameter added to `recall` fails until this
 * interface catches up.
 *
 * The names are the API's, with one exception that is worth knowing: **`depth` was called `traverse`** while
 * the panel sent the traversal as a bare number. It is an object now, so the field is the object's field.
 */
export interface RecallFormState {
  query: string;
  topK: number;
  minScore: number;
  filter: string;
  /** A JSON object, like `filter`, and for the same reason: the API takes an object and a field list is less. */
  projection: string;
  tags: string;
  type: string;
  maxPerType: number;
  includeFileContent: boolean;
  includeDiagnostics: boolean;
  /** Storage bookkeeping — when a record was written and what it links to. Off by default; see the tooltip. */
  includeRecordMeta: boolean;
  /** How far to walk. 0 means no expansion, which is the server default, so it is not sent. */
  depth: number;
  /** Comma-separated, like `tags`. Empty means every label. */
  edgeLabels: string;
  /** Empty means "do not say" — the server picks. */
  direction: '' | 'outbound' | 'inbound' | 'both';
  includeChrono: boolean;
  includeMemories: boolean;
  includeFiles: boolean;
  maxTimeMS: number;
  maxBytes: number;
  maxChars: number;
  maxTokens: number;
  skip: number;
  /** WRITES A FILE into the space. The control has to say so, which is why it is not just another checkbox. */
  remainderDump: boolean;
}

/** One row of the per-type restriction: ticked or not, with an optional guaranteed minimum. */
export interface RecallTypeOpt {
  type: RecallKnowledgeType;
  on: boolean;
  min: number | null;
}

/**
 * The semantic-search form, as its own component and laid out across the width.
 *
 * ## Why it left the tab
 *
 * `U-1` is owner-directed and adds eleven more parameters to this form: *"one input field for EACH AND EVERY
 * available option a recall has… FULL CAPABILITIES."* `query-tab.component.ts` was 652 lines with the form
 * and the results in one template, so that is a split rather than an insertion — and the split comes first,
 * because the layout is what makes room for the controls and doing them the other way round means laying
 * them out twice.
 *
 * The characterization net for it is `query-tab.characterization.spec.ts`: 19 cases over the request the
 * host builds, every one mutation-tested. **Not one of its assertions is edited by this change** — the
 * request-building logic did not move, only the controls that feed it.
 *
 * ## The disclosure is GONE, not replaced
 *
 * Six of these parameters lived behind a "Show advanced" button, which is the arrangement the owner's
 * instruction rules out: a field an operator cannot see is a capability they do not know they have. The
 * answer is not a second disclosure but GROUPS — and the row this came from says exactly that.
 *
 * ## Grouped by what a parameter DOES
 *
 * Owner, 2026-08-30: *"uniform fields, use width and not every item below each other."* Four groups, because
 * four is what the parameters actually divide into:
 *
 * - **the question** — what to look for, and which records are eligible at all;
 * - **ranking** — how many come back and how good they have to be;
 * - **the graph** — the traversal, which is six parameters that only mean anything together;
 * - **the answer** — the time limit and what the envelope carries;
 * - **size** — the ceiling in its four units, the page offset, and the remainder dump.
 *
 * They reflow by available width rather than in one stacked column, so the whole form is visible at once on
 * a normal screen. The question spans the full width because it is the only field always used.
 *
 * ## One group reveals its own detail, and that is not a disclosure
 *
 * The five traversal qualifiers appear once the depth is above 0. The difference from a Show-advanced
 * button is who opened it: the operator did, by asking for hops. A control that cannot affect the request
 * yet is not hidden — it does not exist yet.
 *
 * There used to be a second: `charsPerToken`, shown once a token ceiling existed for it to convert. The
 * parameter was removed at 5.0 — it did nothing unless `maxTokens` was also set, and an operator who needs
 * the ceiling exact should state `maxChars`, which is the unit the server applies.
 *
 * ## Every parameter, and the one that is deliberately absent
 *
 * `space` has no control and never will: the panel is opened ON a space, and a selector would let a search
 * run against a different one and render its results under this space's name. The parity gate carries that
 * as its one PERMANENT exemption; every other row in it is now gone.
 *
 * NOTE: no backticks anywhere in this template, including comments. One ends the template string and the
 * error then points at @Component rather than at the line.
 */
@Component({
  selector: 'app-recall-form',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    /* One grid for every group, reflowing by width rather than by a breakpoint: the panel is rendered inside
       a tab that is itself sometimes beside a detail pane, so a media query would be measuring the wrong box. */
    .rf-groups { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:12px; align-items:start; }
    /* The three lower groups are a FLEX row, not grid tracks, and that is the difference between using the
       width and merely wrapping in it: auto-fit cuts the container into as many 230px tracks as fit - five
       at 1216px — so three groups sat in three of them and 40% of the row was empty. Measured, not guessed:
       the boxes came back at x=252/498/743 with the row ending at 1468. A flex basis of 230px makes the three
       share whatever there is and wrap only when 230 stops fitting. */
    .rf-row { display:flex; flex-wrap:wrap; gap:12px; align-items:stretch; margin-top:12px; }
    /* Grows to share the row, and STOPS at 420. Both halves were measured on a real screen: without the
       grow, four groups left 40% of a 1216px row empty; without the cap, the fourth group wrapping at
       760px became a 700px-wide row of number fields on its own. A gap beside a lone group is a worse
       use of space than a 700px box for a 4-digit number is a control. */
    .rf-row > .rf-group { flex:1 1 230px; min-width:0; max-width:420px; }
    .rf-wide { grid-column:1 / -1; }
    .rf-group { border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; min-width:0; }
    .rf-legend { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--text-muted);
      margin-bottom:8px; }
    /* Uniform, which is the half of the instruction a grid alone does not satisfy: every input fills its
       column, so the fields line up down the group instead of each sizing to its own placeholder. */
    .rf-field { margin:0 0 8px; min-width:0; }
    .rf-field:last-child { margin-bottom:0; }
    .rf-field > label { display:block; font-size:11px; color:var(--text-dim); margin-bottom:3px; }
    .rf-field input[type=text], .rf-field input[type=number], .rf-field select, .rf-field textarea { width:100%; }
    /* flex-start, not center: three of these labels wrap to two lines in a narrow column, and a checkbox
       centred against two lines of text sits between them rather than beside the first word. */
    .rf-check { display:flex; align-items:flex-start; gap:6px; font-size:12px; cursor:pointer;
      margin:0 0 6px; text-transform:none; }
    .rf-check:last-child { margin-bottom:0; }
    .rf-check input { margin:2px 0 0; flex:0 0 auto; }
    .rf-types { display:flex; flex-wrap:wrap; gap:10px; }
    .rf-type { display:inline-flex; align-items:center; gap:4px; font-size:12px; }
    .rf-type input[type=number] { width:52px; }
    .rf-hint { color:var(--text-muted); font-size:11px; display:inline-flex; vertical-align:middle; }
    /* The request sits BESIDE the groups on a wide screen and under them when there is no room, which is
       the same rule as the groups themselves rather than a second layout. It scrolls rather than growing:
       a traversal with six labels is a tall body, and pushing the Search button off the screen to show a
       preview of what the button would do is the wrong trade. */
    /* TWO shares of the row rather than one, and measured: with five siblings the preview came out 234px
       wide and clipped its own first line. A column of 4-digit numbers and a column of JSON do not want
       the same width. */
    /* The two-class selector, not the one-class one: the preview carries both, and
       two classes beat one however the rules are ordered — so the one-class version lost silently and the
       preview came out the width of a column of 4-digit numbers, clipping its own first line. Measured,
       not read: 234px against a 300px basis. */
    .rf-row > .rf-group.rf-json { flex:2 1 300px; min-width:0; max-width:560px; }
    .rf-json pre { margin:0; max-height:260px; overflow:auto; padding:8px 10px; font-size:11px;
      font-family:var(--font-mono, monospace); background:var(--bg-elevated); border:1px solid var(--border);
      border-radius:var(--radius-sm);
      /* pre-WRAP: a query is a sentence and a filter is a long line, so horizontal scrolling would hide
         the start of the very key somebody is checking. Wrapping keeps the whole request readable. */
      white-space:pre-wrap; word-break:break-word; }
    .rf-json-head { display:flex; align-items:center; justify-content:space-between; gap:8px;
      margin-bottom:4px; }
  `],
  template: `
<!-- ONE pair of handlers for the whole form, rather than an (ngModelChange) on each of twenty-five
     controls.

     input and change both BUBBLE, so this catches every text field, number, select and checkbox in the
     form — including ones added later. Twenty-five bindings would be twenty-five chances to forget one,
     and a forgotten one does not break anything visibly: the request preview simply stops updating for
     that field, which is the one failure a preview must not have, because it is believed. -->
<div (input)="bumpRequest()" (change)="bumpRequest()">
<!--
     THE QUESTION AND THE TWO JSON FIELDS, side by side as cards.

     They were a full-width question with the filter and projection buried in the grid below it, among the
     tag and type controls. Owner, 2026-09-07: the JSON filter and projection should be cards beside the
     question. They belong together because they are the three things that decide WHAT is searched — the
     rest of this form decides how much comes back and in what shape.

     Same rf-row of rf-group cards the section further down uses, so the panel has one card idiom rather
     than two. The two JSON cards carry rf-json, which gives them the wider flex basis a monospace textarea
     needs before it starts wrapping mid-token.
  -->
<div class="rf-row">
  <div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.question' | transloco }}</div>
    <div class="rf-field">
      <label>{{ 'brain.query.search.label' | transloco }}</label>
      <input
        type="text"
        [(ngModel)]="form().query"
        name="recallQuery"
        [placeholder]="'brain.query.search.placeholder' | transloco"
        style="font-size:14px; padding:8px 12px;"
        (keydown.enter)="run.emit()"
        [attr.aria-label]="'brain.query.search.label' | transloco"
      />
    </div>
  </div>

  <div class="rf-group rf-json">
    <div class="rf-legend">{{ 'brain.query.filter' | transloco }}</div>
    <div class="rf-field">
      <textarea [(ngModel)]="form().filter" name="recallFilter" rows="3"
        [placeholder]="'brain.query.filter.placeholder' | transloco"
        [attr.aria-label]="'brain.query.filter' | transloco"
        style="font-family:var(--font-mono, monospace); font-size:12px;"></textarea>
    </div>
  </div>

  <!-- A JSON object like the filter, deliberately, and not a comma-separated field list: the API takes an
       object and can exclude as well as include, so a field list would be a control that looks complete and
       cannot express half of what the parameter does. -->
  <div class="rf-group rf-json">
    <div class="rf-legend">{{ 'brain.query.projection' | transloco }}
      <span class="rf-hint" [attr.title]="'brain.query.projection.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
    </div>
    <div class="rf-field">
      <textarea [(ngModel)]="form().projection" name="recallProjection" rows="3"
        [placeholder]="'brain.query.projection.placeholder' | transloco"
        [attr.aria-label]="'brain.query.projection' | transloco"
        style="font-family:var(--font-mono, monospace); font-size:12px;"></textarea>
    </div>
  </div>
</div>

<div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.narrow' | transloco }}</div>
    <div class="rf-groups">
      <div class="rf-field">
        <label>{{ 'brain.query.tags' | transloco }}</label>
        <input type="text" [(ngModel)]="form().tags" name="recallTags"
          [placeholder]="'brain.query.tags.placeholder' | transloco" />
      </div>
      <div class="rf-field">
        <label>{{ 'brain.query.filterByType' | transloco }}</label>
        <select [(ngModel)]="form().type" name="recallType">
          <option value="">{{ 'brain.query.anyType' | transloco }}</option>
          @for (t of typeNames(); track t) {
            <option [value]="t">{{ t }}</option>
          }
        </select>
      </div>
    </div>
</div>

<div class="rf-row">
  <!-- Ranking. -->
  <div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.ranking' | transloco }}</div>
    <div class="rf-field">
      <label>{{ 'brain.query.topK' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.topK.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <!-- No max attribute: topK has no ceiling at either API door since 4.0.0 (P-34), and one here
           would make the FORM the narrowest of the three ways in — an operator told 100 is the limit
           while a script beside them asks for 500. The answer is bounded by size, not count.
           No backticks in this comment: an inline template is a template literal. -->
      <input type="number" [(ngModel)]="form().topK" name="recallTopK" min="1" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.minScore' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.minScore.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().minScore" name="recallMinScore" min="0" max="1" step="0.05" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.maxPerType' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.maxPerType.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().maxPerType" name="recallMaxPerType" min="0" max="100"
        [placeholder]="'brain.query.maxPerType.none' | transloco" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.types' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.types.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <div class="rf-types">
        @for (opt of typeOpts(); track opt.type) {
          <span class="rf-type">
            <input type="checkbox" [(ngModel)]="opt.on" [name]="'recallType-' + opt.type" [attr.aria-label]="opt.type" />
            <span>{{ opt.type }}</span>
            <!-- The per-type minimum appears only for a ticked type: a floor on a type you are not asking
                 for is a number with no effect, and it is also what the request builder ignores. -->
            @if (opt.on) {
              <input type="number" [(ngModel)]="opt.min" [name]="'recallMin-' + opt.type" min="0"
                [max]="form().topK" [placeholder]="'brain.query.minPerType.placeholder' | transloco"
                [attr.title]="'brain.query.minPerType.tooltip' | transloco" />
            }
          </span>
        }
      </div>
    </div>
  </div>

  <!-- The graph, which is the traversal OBJECT: six parameters that only mean anything together. Sending
       the walk as a bare number reached the depth and nothing else, so five of these were unreachable from
       the UI however the request was written by hand. -->
  <div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.graph' | transloco }}</div>
    <div class="rf-field">
      <label>{{ 'brain.query.traverse' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.traverse.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().depth" name="recallTraverse" min="0" max="5"
        [placeholder]="'brain.query.traverse.none' | transloco" />
    </div>
    <!-- Everything below qualifies the walk, so it is dead weight at depth 0 — shown only once there is a
         walk to qualify. Not a disclosure: the operator opened it by asking for hops. -->
    @if (form().depth > 0) {
      <div class="rf-field">
        <label>{{ 'brain.query.direction' | transloco }}
          <span class="rf-hint" [attr.title]="'brain.query.direction.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
        </label>
        <select [(ngModel)]="form().direction" name="recallDirection">
          <option value="">{{ 'brain.query.direction.default' | transloco }}</option>
          <option value="outbound">{{ 'brain.query.direction.outbound' | transloco }}</option>
          <option value="inbound">{{ 'brain.query.direction.inbound' | transloco }}</option>
          <option value="both">{{ 'brain.query.direction.both' | transloco }}</option>
        </select>
      </div>
      <div class="rf-field">
        <label>{{ 'brain.query.edgeLabels' | transloco }}
          <span class="rf-hint" [attr.title]="'brain.query.edgeLabels.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
        </label>
        <input type="text" [(ngModel)]="form().edgeLabels" name="recallEdgeLabels"
          [placeholder]="'brain.query.edgeLabels.placeholder' | transloco" />
      </div>
      <label class="rf-check">
        <input type="checkbox" [(ngModel)]="form().includeChrono" name="recallIncludeChrono" />
        <span>{{ 'brain.query.includeChrono' | transloco }}</span>
      </label>
      <label class="rf-check">
        <input type="checkbox" [(ngModel)]="form().includeMemories" name="recallIncludeMemories" />
        <span>{{ 'brain.query.includeMemories' | transloco }}</span>
      </label>
      <label class="rf-check">
        <input type="checkbox" [(ngModel)]="form().includeFiles" name="recallIncludeFiles" />
        <span>{{ 'brain.query.includeFiles' | transloco }}</span>
      </label>
    }
  </div>

  <!-- The answer: the two ceilings, and what the envelope carries. -->
  <div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.answer' | transloco }}</div>
    <div class="rf-field">
      <!-- ONE control for the size ceiling, not two. maxTokens is a convenience onto the same number and the
           server applies whichever is smaller, so offering both would let an operator set two limits and then
           have to work out which one won. -->
      <label>{{ 'brain.query.recallMaxBytes' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.recallMaxBytes.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().maxBytes" name="recallMaxBytes" min="0" max="5000000" step="1000"
        [placeholder]="'brain.query.recallMaxBytes.default' | transloco" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.maxTimeMs' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.recallMaxTimeMs.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().maxTimeMS" name="recallMaxTimeMS" min="0" max="30000"
        [placeholder]="'brain.query.recallMaxTimeMs.none' | transloco" />
    </div>
    <label class="rf-check">
      <input type="checkbox" [(ngModel)]="form().includeFileContent" name="recallIncludeContent" />
      <span>{{ 'brain.query.includeFileContent' | transloco }}</span>
      <span class="rf-hint" [attr.title]="'brain.query.includeFileContent.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
    </label>
    <label class="rf-check">
      <input type="checkbox" [(ngModel)]="form().includeDiagnostics" name="recallIncludeDiagnostics" />
      <span>{{ 'brain.query.includeDiagnostics' | transloco }}</span>
      <span class="rf-hint" [attr.title]="'brain.query.includeDiagnostics.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
    </label>
    <label class="rf-check">
      <input type="checkbox" [(ngModel)]="form().includeRecordMeta" name="recallIncludeRecordMeta" />
      <span>{{ 'brain.query.includeRecordMeta' | transloco }}</span>
      <span class="rf-hint" [attr.title]="'brain.query.includeRecordMeta.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
    </label>
  </div>

  <!-- The size ceiling in its other three units, and the page control.
       The comment above the byte ceiling used to say offering more than one unit would make an operator
       work out which won. That was right about TWO overlapping numbers and wrong as a rule: the server
       applies whichever is SMALLEST, so the honest fix is to say so once here rather than to hide two thirds
       of the parameter. Characters and bytes are not the same thing in a German or Polish space — that was
       B-1, a real bug — and tokens is the unit an agent budget is actually written in. -->
  <div class="rf-group">
    <div class="rf-legend">{{ 'brain.query.group.size' | transloco }}</div>
    <div class="rf-field">
      <label>{{ 'brain.query.maxChars' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.maxChars.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().maxChars" name="recallMaxChars" min="0" step="1000"
        [placeholder]="'brain.query.recallMaxBytes.default' | transloco" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.maxTokens' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.maxTokens.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().maxTokens" name="recallMaxTokens" min="0" step="100"
        [placeholder]="'brain.query.recallMaxBytes.default' | transloco" />
    </div>
    <div class="rf-field">
      <label>{{ 'brain.query.skip' | transloco }}
        <span class="rf-hint" [attr.title]="'brain.query.skip.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
      </label>
      <input type="number" [(ngModel)]="form().skip" name="recallSkip" min="0" />
    </div>
    <!-- The only control on this form that WRITES, so it says so on the face rather than in a tooltip: it
         puts a JSON file into the space and that file is downloadable for a day. A checkbox that looks like
         its three read-only neighbours would be the dishonest version. -->
    <label class="rf-check">
      <input type="checkbox" [(ngModel)]="form().remainderDump" name="recallRemainderDump" />
      <span>{{ 'brain.query.remainderDump' | transloco }}</span>
      <span class="rf-hint" [attr.title]="'brain.query.remainderDump.tooltip' | transloco"><ph-icon name="info" [size]="11"/></span>
    </label>
    @if (form().remainderDump) {
      <div class="sch-msg" style="font-size:11px; color:var(--text-dim); margin-top:4px;">
        {{ 'brain.query.remainderDump.writes' | transloco }}
      </div>
    }
  </div>
  <!-- The request this form would send, as an operator would paste it into an MCP call.
       It does NOT re-build the request: it calls the same function the search calls and prints what comes
       back. A preview assembled separately would be believed — somebody pastes it, gets a different answer
       from the one on screen, and nothing anywhere is wrong. See recall-request.ts. -->
  <div class="rf-group rf-json">
    <div class="rf-json-head">
      <span class="rf-legend" style="margin:0;">{{ 'brain.query.request.label' | transloco }}</span>
      <button class="btn btn-ghost btn-sm" type="button" [disabled]="!request().json"
        (click)="copyRequest()">{{ (copied() ? 'brain.query.request.copied' : 'brain.query.request.copy') | transloco }}</button>
    </div>
    @if (request().json) {
      <pre>{{ request().json }}</pre>
    } @else {
      <!-- Two different reasons for having no request, and they read differently on purpose: a blank
           question is not an error, and a broken filter is. -->
      <div class="rf-hint" style="display:block;">
        {{ (request().errorKey ? 'brain.query.request.invalid' : 'brain.query.request.empty') | transloco }}
      </div>
    }
    <div class="rf-hint" style="display:block; margin-top:5px;">{{ 'brain.query.request.hint' | transloco }}</div>
  </div>
</div>

<!--
  NO ACTION ROW HERE. The run and clear controls live on the panel's sticky bar, top-right, because this
  form is tall: a button at the BOTTOM of it is a full row holding one control, wedged between the request
  and the answer, and it scrolls out of reach exactly when a parameter has just been changed.

  The run and clear outputs are unchanged — Enter in the question field still emits run — so the contract
  holds and the host decides where the controls are drawn.
-->
</div>
`,
})
export class RecallFormComponent {
  /** The form state, mutated IN PLACE. The host owns it, builds the request from it, and decides when. */
  readonly form = input.required<RecallFormState>();
  /** The per-type rows, also mutated in place — one array, two derivations in the host's request builder. */
  readonly typeOpts = input.required<RecallTypeOpt[]>();
  /** Type names for the restrict-to-type shortcut. Resolved by the host, which is what knows the space. */
  readonly typeNames = input<string[]>([]);
  readonly running = input(false);
  readonly error = input('');
  /** Whether there is anything to clear — the button is pointless otherwise. */
  readonly hasResults = input(false);

  /**
   * Asked for, not done. Both of these belong to the host for the reason the tree store's docblock gives:
   * a form that decided when a search happens would be deciding what the panel is for.
   */
  readonly run = output<void>();
  readonly clear = output<void>();

  // ── The request, shown rather than described ──────────────────────────────────────────────────────────
  /**
   * The body this form would send, or the reason there is none.
   *
   * **A computed over a bumped tick, because the form object is mutated IN PLACE.** `ngModel` writes into the
   * same object every time, so a computed reading it would never recompute — the same reason the tree store
   * bumps a signal after mutating its nodes. `bumpRequest` is bound to the form's own change events.
   */
  readonly request = computed(() => { this.tick(); return recallRequestJson(this.form(), this.typeOpts()); });

  private readonly tick = signal(0);
  bumpRequest(): void { this.tick.update(n => n + 1); }

  readonly copied = signal(false);

  /**
   * Copy the request, and say so.
   *
   * `navigator.clipboard` is absent in a non-secure context and can be refused by permission, so the
   * confirmation follows the WRITE rather than the click — a button that says "Copied" when nothing was is
   * worse than one that does nothing visible.
   */
  async copyRequest(): Promise<void> {
    const json = this.request().json;
    if (!json) return;
    try {
      await navigator.clipboard.writeText(json);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Nothing to report: the text is on screen and selectable, which is the fallback.
    }
  }
}
