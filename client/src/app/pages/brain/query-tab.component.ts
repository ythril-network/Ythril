import { ChangeDetectionStrategy, Component, ViewChild, computed, inject, input, output, signal } from '@angular/core';
import { groupRecallResults, chunkLabel, passageText, relatedOf, orderingOf } from './recall-grouping';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { QueryCollection, QueryResult, RecallKnowledgeType, RecallResult, RecallResponse, RECORD_TYPES, BRAIN_COLLECTIONS } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { PhIconComponent } from '../../shared/ph-icon.component';
import { RecallFormComponent, type RecallFormState, type RecallTypeOpt } from './recall-form.component';
import { JsonTreeComponent } from '../../shared/json-tree.component';
import { recallRequestFrom } from './recall-request';
import { BrainStore } from './brain-store.service';

/**
 * The brain page's Query tab — advanced (MongoDB-style) query + semantic recall.
 *
 * Extracted from BrainComponent (A17.9b-6a) as the first tab component. Read-only: it owns the
 * query/recall forms and results, and talks only to `BrainApi` (+ `BrainStore` for the recall
 * "filter by type" options). The active space id is a required input — the shell's nav state stays on
 * the shell — and the async methods read it at call time so a mid-flight space switch cannot stale it.
 *
 * OnPush: every result path writes a signal.
 */
@Component({
  selector: 'app-query-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslocoPipe, PhIconComponent, RecallFormComponent, JsonTreeComponent],
  styles: [`
    .query-panel {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .query-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
    }
    .query-form-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: flex-end;
    }
    .query-form-row .field { margin: 0; }
    .query-textarea {
      width: 100%;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      color: var(--text-primary);
      resize: vertical;
      min-height: 64px;
    }
    .query-textarea.error { border-color: var(--error); }
    .query-results-header {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--text-muted);
    }
    .query-results-header strong { color: var(--text-primary); }
    .query-result-card {
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text-secondary);
    }
    .rel-block { margin-top:10px; border-top:1px solid var(--border); padding-top:8px; }
    .rel-head { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted);
      margin-bottom:6px; }
    .rel-kind { font-size:11px; color:var(--text-secondary); font-weight:550; margin:6px 0 3px; }
    .rel-item { border-left:2px solid var(--border); padding-left:8px; margin-bottom:6px; }
    .rel-meta { display:flex; gap:6px; align-items:center; font-size:11px; color:var(--text-muted);
      margin-bottom:2px; }
    .rel-via { font-family:var(--font-mono, monospace); }
    .query-empty {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 14px;
    }
    /*
      THE PANEL BAR — mode on the left, the run control on the right, and it stays put.

      A sticky position with a background of its own: the form below is tall, and an action that scrolls
      away is one the reader has to hunt for after every edit. The bottom border is what separates the
      request from the answer now that no button sits between them.
    */
    .query-bar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      padding: 8px 0 10px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-page, var(--bg-surface));
    }
    .query-bar-modes { display: flex; gap: 8px; }
    .query-bar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .query-bar-error { font-size: 12px; color: var(--error); max-width: 46ch; }

    /*
      THE ANSWER IS A CARD, so it reads as a different thing from the request rather than as more of it.
      Its header carries what the answer IS — how many, how big, and which view — and sticks to the top of
      the card while a long result scrolls under it.
    */
    .query-answer {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      overflow: hidden;
      margin-top: 12px;
    }
    .query-answer-head {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-subtle, var(--bg-surface));
      font-size: 12px;
      color: var(--text-secondary);
    }
    .query-answer-head strong { color: var(--text-primary); }
    .query-answer-tools { display: flex; align-items: center; gap: 6px; margin-left: auto; }
    .query-answer-body { padding: 10px 12px; }
    /* A wide record scrolls inside the card rather than pushing the page sideways. */
    .query-answer-body { overflow-x: auto; }

    /*
      THE DECIDING SCORE reads as the primary figure; the stages that also ran sit behind it. Both monospace,
      because they are values a reader compares between rows, and a proportional font makes 0.750 and 0.705
      the same width.
    */
    .score-by {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-subtle, rgba(127,127,127,0.10));
      border-radius: var(--radius-sm);
      padding: 1px 6px;
      white-space: nowrap;
    }
    .score-also {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
    }
  `],
  template: `
          <div class="query-panel">
            <!--
              THE MODE AND THE ACTION ON ONE BAR, and the action on the right.

              Owner, 2026-09-07: *"lets place the search button top-right. after results are returned it
              looks bad between there taking a line but only be a button."* It sat under a tall form, so it
              was a full row holding one control, wedged between the request and the answer — the one place
              on the panel where a horizontal rule would have been doing the work instead.

              Sticky, because the form is tall enough to scroll the action off screen: the thing you press
              after editing a parameter should not require scrolling back up to find it.
            -->
            <div class="query-bar">
              <div class="query-bar-modes">
                <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'search'" [class.btn-secondary]="queryMode() !== 'search'" (click)="queryMode.set('search')">{{ 'brain.query.mode.semanticSearch' | transloco }}</button>
                <button class="btn btn-sm" [class.btn-primary]="queryMode() === 'advanced'" [class.btn-secondary]="queryMode() !== 'advanced'" (click)="queryMode.set('advanced')">{{ 'brain.query.mode.advancedQuery' | transloco }}</button>
              </div>
              <div class="query-bar-actions">
                @if (queryMode() === 'search') {
                  @if (recallError()) {
                    <span class="query-bar-error">{{ recallError() }}</span>
                  }
                  @if (recallResults().length) {
                    <button class="btn btn-sm btn-secondary" (click)="clearRecall()">{{ 'brain.query.clearResults' | transloco }}</button>
                  }
                  <button class="btn btn-sm btn-primary" [disabled]="recallRunning() || !recallForm.query.trim()" (click)="runRecall()">
                    @if (recallRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'brain.query.searchButton' | transloco }}
                  </button>
                } @else {
                  @if (queryError()) {
                    <span class="query-bar-error">{{ queryError() }}</span>
                  }
                  @if (queryResult()) {
                    <button class="btn btn-sm btn-secondary" (click)="clearQuery()">{{ 'brain.query.clearResults' | transloco }}</button>
                  }
                  <button class="btn btn-sm btn-primary" [disabled]="queryRunning()" (click)="runQuery()">
                    @if (queryRunning()) { <span class="spinner" style="width:11px;height:11px;border-width:2px;"></span> }
                    {{ 'brain.query.runQuery' | transloco }}
                  </button>
                }
              </div>
            </div>

            <!-- Semantic Search mode. The FORM is its own component, app-recall-form: U-1 adds eleven
                 more parameters to it, so it is a split rather than an insertion, and the layout that makes
                 room for them comes first. The request built from that form stays here — 19 characterization
                 cases pin it, and not one of their assertions changed. -->
            @if (queryMode() === 'search') {
              <app-recall-form
                [form]="recallForm"
                [typeOpts]="recallTypeOpts"
                [typeNames]="recallTypeSchemaOptions()"
                [running]="recallRunning()"
                [error]="recallError()"
                [hasResults]="recallResults().length > 0"
                (run)="runRecall()"
                (clear)="clearRecall()" />

              <!-- THE ANSWER WAS SHORTENED, and until now the page did not say so.
                   Placed above the results rather than below them: a reader who scrolls to the end has already
                   concluded that is all there was, which is the whole failure. Says both guarantees, because
                   "shortened" on its own reads as "unreliable" — the records that came back are complete and
                   they are the top of the ranking, with nothing missing from the middle. -->
              @if (recallTruncated(); as t) {
                <div class="alert alert-warning" style="margin-top:12px;">
                  <div><strong>{{ 'brain.query.truncated.title' | transloco: { returned: t.returned, count: t.count } }}</strong></div>
                  <div style="font-size:12px; margin-top:4px;">{{ 'brain.query.truncated.body' | transloco }}</div>
                  <div style="font-size:12px; margin-top:4px;">{{ 'brain.query.truncated.what' | transloco }}</div>
                </div>
              }

              <!-- A SEARCH THAT MATCHED NOTHING SAYS SO. Without this the panel showed exactly what it
                   shows before the first search — nothing — so a reader could not tell an answered question
                   from an unasked one, and the natural reading is that the button did not work. -->
              <!-- THE WALK STOPPED SHORT, which is a different fact from the answer being shortened: what is
                   missing here are records the traversal never read. Placed beside the truncation notice and
                   above the results for the same reason — a reader who reaches the end has already concluded
                   the neighbourhood was complete. The download is offered only when there IS one: a bounded
                   link scan leaves nothing complete to write. -->
              @if (graphShort(); as g) {
                <div class="alert alert-warning" style="margin-top:12px;">
                  <div><strong>{{ 'brain.query.graphShort.title' | transloco: { nodes: g.nodes } }}</strong></div>
                  <div style="font-size:12px; margin-top:4px;">{{ 'brain.query.graphShort.body' | transloco }}</div>
                  @if (g.complete; as c) {
                    <div style="font-size:12px; margin-top:4px;">
                      <a [href]="c.download" target="_blank" rel="noopener">{{ 'brain.query.graphShort.download' | transloco: { nodes: c.nodes } }}</a>
                      @if (c.ceilingHit) {
                        <span style="margin-left:6px;">{{ 'brain.query.graphShort.ceilingHit' | transloco }}</span>
                      }
                    </div>
                  }
                </div>
              }

              @if (recallRan() && !recallResults().length && !recallError()) {
                <div class="query-empty">{{ 'brain.query.noMatches' | transloco }}</div>
              }

              @if (recallResults().length) {
                <!--
                  THE ANSWER, IN ITS OWN CARD. Owner, 2026-09-07: put the result in a card or separate it
                  with a real UI element. The header says what came back before any of it is read — how
                  many, how many passages they were grouped from, and how big the answer was.

                  The RENDERED view is the one that reads; the JSON view is the one that matches what an
                  MCP caller receives, which is the point of this panel. Neither is a summary of the other.
                -->
                <div class="query-answer">
                  <div class="query-answer-head">
                    <span><strong>{{ recallGroups().length }}</strong> {{ 'brain.query.resultsCount' | transloco: { count: recallGroups().length } }}</span>
                    <!-- Grouping makes a topK of 10 look like 6, so the passage count is stated rather than
                         left for the reader to wonder about. Only shown when grouping actually happened. -->
                    @if (recallResults().length !== recallGroups().length) {
                      <span>{{ 'brain.query.groupedPassages' | transloco: { count: recallResults().length } }}</span>
                    }
                    @if (answerSize(); as size) {
                      <span>{{ size }}</span>
                    }
                    <div class="query-answer-tools">
                      @if (answerView() === 'json') {
                        <button class="btn btn-ghost btn-sm" type="button" (click)="tree?.expandAll()">{{ 'brain.query.expandAll' | transloco }}</button>
                        <button class="btn btn-ghost btn-sm" type="button" (click)="tree?.collapseAll()">{{ 'brain.query.collapseAll' | transloco }}</button>
                      }
                      <button class="btn btn-sm" type="button"
                        [class.btn-primary]="answerView() === 'rendered'" [class.btn-secondary]="answerView() !== 'rendered'"
                        (click)="answerView.set('rendered')">{{ 'brain.query.view.rendered' | transloco }}</button>
                      <button class="btn btn-sm" type="button"
                        [class.btn-primary]="answerView() === 'json'" [class.btn-secondary]="answerView() !== 'json'"
                        (click)="answerView.set('json')">{{ 'brain.query.view.json' | transloco }}</button>
                    </div>
                  </div>
                  <div class="query-answer-body">
                    @if (answerView() === 'json') {
                      <!-- The RESPONSE, not the result list: the count, the budget fields and every graph
                           subtree are what a caller has to reason about, and hiding them here is what made
                           this panel teach a shape the product does not have. -->
                      <app-json-tree [value]="recallRaw()" [openTo]="2" />
                    } @else {
                @for (g of recallGroups(); track $index) {
                  <div class="query-result-card" style="margin-top:6px;">
                    @if (g.file; as f) {
                      <!-- A grouped document: name the FILE once, then say where inside it matched. -->
                      <div style="display:flex; gap:8px; margin-bottom:4px; align-items:center; flex-wrap:wrap;">
                        <span class="badge badge-purple">file</span>
                        <strong style="font-size:12px; word-break:break-all;">{{ f.path }}</strong>
                        <!--
                          THE SCORE THAT DECIDED THE PLACE, named. It read "Score" and showed plain vector
                          similarity — which on an instance with a cross-encoder configured is not the number
                          that ordered the answer, so the panel was labelling a figure that decided nothing.
                          The other stages follow it, dimmer, for a reader asking why.
                        -->
                        @if (orderingOf(g.hits[0]); as ord) {
                          <span class="score-by" [attr.title]="'brain.query.orderedBy' | transloco: { by: ord.by }">
                            {{ ord.by }}: {{ ord.value.toFixed(3) }}
                          </span>
                          @for (st of ord.stages; track st.name) {
                            @if (st.name !== ord.by) {
                              <span class="score-also">{{ st.name }}: {{ st.value.toFixed(3) }}</span>
                            }
                          }
                        }
                        @if (g.hitCount > 1) {
                          <span class="badge">{{ 'brain.query.passages' | transloco: { count: g.hitCount } }}</span>
                        }
                      </div>
                      @if (f.description) {
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px;">{{ f.description }}</div>
                      }
                      <ul style="margin:0; padding-left:16px;">
                        @for (h of g.hits; track $index) {
                          <li style="margin:2px 0;">
                            @if (chunkHeading(h); as heading) {
                              <span style="font-size:11px; color:var(--text-secondary); font-weight:550;">{{ heading }}</span>
                            }
                            <!-- The passage's own text, not the raw record: a JSON dump per passage is
                                 unreadable stacked six deep, and the text is what actually matched.
                                 Falls back to the record only when a hit carries no text at all. -->
                            @if (passageOf(h); as text) {
                              <div style="white-space:pre-wrap; word-break:break-word; font-size:12px;">{{ text }}</div>
                            } @else {
                              <app-json-tree [value]="h" [openTo]="1" />
                            }
                          </li>
                        }
                      </ul>
                    } @else {
                      <div style="display:flex; gap:8px; margin-bottom:4px; align-items:center;">
                        <span class="badge badge-purple">{{ g.hits[0].type }}</span>
                        <!--
                          THE SCORE THAT DECIDED THE PLACE, named. It read "Score" and showed plain vector
                          similarity — which on an instance with a cross-encoder configured is not the number
                          that ordered the answer, so the panel was labelling a figure that decided nothing.
                          The other stages follow it, dimmer, for a reader asking why.
                        -->
                        @if (orderingOf(g.hits[0]); as ord) {
                          <span class="score-by" [attr.title]="'brain.query.orderedBy' | transloco: { by: ord.by }">
                            {{ ord.by }}: {{ ord.value.toFixed(3) }}
                          </span>
                          @for (st of ord.stages; track st.name) {
                            @if (st.name !== ord.by) {
                              <span class="score-also">{{ st.name }}: {{ st.value.toFixed(3) }}</span>
                            }
                          }
                        }
                        <!-- A hit that HAS a node in the graph gets the same jump the entities and edges tabs
                             offer. Traverse results are entities too, so an expanded neighbour is reachable
                             from here without going back to a list. -->
                        @if (graphTargetOf(g.hits[0]); as target) {
                          <button class="icon-btn" style="margin-left:auto;" [attr.title]="'common.viewInGraph' | transloco"
                            [attr.aria-label]="'common.viewInGraph' | transloco" (click)="viewInGraph.emit(target)"><ph-icon name="graph" [size]="16"/></button>
                        }
                      </div>
                      <app-json-tree [value]="g.hits[0]" [openTo]="1" />
                    }

                    <!--
                      WHAT THE WALK REACHED, under the match that reached it.

                      These used to be appended to the result list as if they were matches — in rank order,
                      counted in the total, indistinguishable from a record that actually answered the
                      question. A neighbour has no score of its own and did not answer anything; it is only
                      meaningful beside the record that reached it.

                      Grouped by kind and showing the WHOLE record, because this panel is where queries are
                      tested before they are sent by something else: what is on screen has to be what the API
                      returned, or the panel teaches a contract the product does not have.
                    -->
                    @if (relatedOf(g.hits[0]); as rel) {
                      @if (rel.total > 0) {
                        <div class="rel-block">
                          <div class="rel-head">{{ 'brain.query.related' | transloco: { count: rel.total } }}</div>
                          @for (bucket of [
                            { label: 'brain.query.related.entities', items: rel.entities },
                            { label: 'brain.query.related.memories', items: rel.memories },
                            { label: 'brain.query.related.chronos', items: rel.chronos },
                            { label: 'brain.query.related.files', items: rel.files }
                          ]; track bucket.label) {
                            @if (bucket.items.length) {
                              <div class="rel-kind">{{ bucket.label | transloco: { count: bucket.items.length } }}</div>
                              @for (r of bucket.items; track $index) {
                                <div class="rel-item">
                                  <div class="rel-meta">
                                    <span class="badge">{{ r.kind }}</span>
                                    <span>{{ 'brain.query.related.hops' | transloco: { hops: r.hops } }}</span>
                                    @if (r.label) { <span class="rel-via">{{ r.label }}</span> }
                                  </div>
                                  <app-json-tree [value]="r.record" [openTo]="1" />
                                </div>
                              }
                            }
                          }
                        </div>
                      }
                    }
                  </div>
                }
                    }
                  </div>
                </div>
              }
            }

            <!-- Advanced Query mode -->
            @if (queryMode() === 'advanced') {
              <div class="query-form">
                <div class="query-form-row">
                  <div class="field" style="min-width:160px;">
                    <label>{{ 'brain.query.collection' | transloco }}</label>
                    <select [(ngModel)]="queryForm.collection" name="queryCollection" [attr.aria-label]="'brain.query.collection' | transloco">
                      @for (c of queryCollections; track c) { <option [value]="c">{{ c }}</option> }
                    </select>
                  </div>
                  <div class="field" style="min-width:80px;">
                    <label>{{ 'brain.query.limit' | transloco }}</label>
                    <input type="number" [(ngModel)]="queryForm.limit" name="queryLimit" min="1" max="100" style="width:80px;" />
                  </div>
                  <div class="field" style="min-width:100px;">
                    <label>{{ 'brain.query.maxTimeMs' | transloco }}</label>
                    <input type="number" [(ngModel)]="queryForm.maxTimeMS" name="queryMaxTimeMS" min="100" max="30000" style="width:100px;" />
                  </div>
                </div>
                <div class="field">
                  <label>{{ 'brain.query.filter' | transloco }} <span style="color:var(--text-muted);font-size:11px;">{{ 'brain.query.filterHint' | transloco }}</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryFilterError()"
                    [(ngModel)]="queryForm.filter"
                    name="queryFilter"
                    rows="3"
                    [placeholder]="'brain.query.filterPlaceholder' | transloco"
                  ></textarea>
                  @if (queryFilterError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryFilterError() }}</div>
                  }
                </div>
                <div class="field">
                  <label>{{ 'brain.query.projection' | transloco }} <span style="color:var(--text-muted);font-size:11px;">{{ 'brain.query.projectionHint' | transloco }}</span></label>
                  <textarea
                    class="query-textarea"
                    [class.error]="queryProjectionError()"
                    [(ngModel)]="queryForm.projection"
                    name="queryProjection"
                    rows="2"
                    [placeholder]="'brain.query.projectionPlaceholder' | transloco"
                  ></textarea>
                  @if (queryProjectionError()) {
                    <div style="font-size:11px; color:var(--error); margin-top:3px;">{{ queryProjectionError() }}</div>
                  }
                </div>
                <!-- Run, clear and the error live on the panel bar, top-right. -->
              </div>

              @if (queryResult(); as res) {
                <!--
                  THE SAME CARD AS THE SEARCH ANSWER, so the panel has one idiom for "this is what came
                  back". The documents were a pretty-printed blob per result, which is unreadable the moment
                  a record has a properties bag — the tree is the whole reason this mode is usable on real
                  data.
                -->
                <div class="query-answer">
                  <div class="query-answer-head">
                    <span><strong>{{ res.count }}</strong> {{ 'brain.query.resultsFrom' | transloco: { count: res.count, collection: res.collection } }}</span>
                    @if (res.results.length) {
                      <div class="query-answer-tools">
                        <button class="btn btn-ghost btn-sm" type="button" (click)="tree?.expandAll()">{{ 'brain.query.expandAll' | transloco }}</button>
                        <button class="btn btn-ghost btn-sm" type="button" (click)="tree?.collapseAll()">{{ 'brain.query.collapseAll' | transloco }}</button>
                      </div>
                    }
                  </div>
                  <div class="query-answer-body">
                    @if (res.results.length === 0) {
                      <div class="query-empty">{{ 'brain.query.noDocuments' | transloco }}</div>
                    } @else {
                      <app-json-tree [value]="res.results" [openTo]="2" />
                    }
                  </div>
                </div>
              }
            }
          </div>
  `,
})
export class QueryTabComponent {
  private brainApi = inject(BrainApi);
  private store = inject(BrainStore);
  private transloco = inject(TranslocoService);

  readonly spaceId = input.required<string>();

  // Query panel
  queryMode = signal<'search' | 'advanced'>('search');
  readonly queryCollections: readonly QueryCollection[] = BRAIN_COLLECTIONS;
  queryForm = { collection: 'memories' as QueryCollection, filter: '', projection: '', limit: 20, maxTimeMS: 5000 };
  queryRunning = signal(false);
  queryResult = signal<QueryResult | null>(null);
  queryError = signal('');
  queryFilterError = signal('');
  queryProjectionError = signal('');

  // Semantic search
  //
  // `recallKnowledgeTypes` was here and was DEAD: declared, never read, not by the template either. The
  // rendered list is `recallTypeOpts` below. Deleted rather than converted — a copy of an enumeration that
  // nothing reads is the cheapest kind to keep and the easiest to start believing in.
  // `maxPerType: 0` and `includeContent: true` are the SERVER's defaults expressed as form state, not new policy:
  // 0 means "no cap" and is omitted from the request, and `includeContent` starts true because sending false makes
  // recall look as though it has stopped returning passages. `includeFreshWrites` starts false because it is an
  // opt-in scan.
  /** Focus an entity in the graph tab — the shell switches tab and sets the focus id, exactly as it does
   *  for the entities and edges tabs. */
  viewInGraph = output<string>();

  /*
   * Every default here is either the SERVER's default or a value that means "say nothing", and that is the
   * whole design of this object: a form whose defaults differ from the route's would put a decision nobody
   * made into every request.
   *
   * So the zeros are not laziness. `depth: 0` is no expansion, `maxTimeMS: 0` is not a legal deadline,
   * `maxBytes`/`maxChars`/`maxTokens: 0` mean "use the instance default" against server floors of 1000 and 1,
   * and `skip: 0` is the first page. None of them can be mistaken for a number an operator chose, and none is
   * sent. `direction: ''` is the same idea for a string: the server picks unless somebody says.
   */
  recallForm: RecallFormState = {
    query: '', topK: 10, minScore: 0, filter: '', projection: '', tags: '', type: '',
    maxPerType: 0, includeFreshWrites: false, includeContent: true, includeDiagnostics: false, includeRecordMeta: false,
    depth: 0, edgeLabels: '', direction: '',
    includeChrono: false, includeMemories: false, includeFiles: false,
    maxTimeMS: 0, maxBytes: 0, maxChars: 0, maxTokens: 0, charsPerToken: 0,
    skip: 0, remainderDump: false,
  };

  /**
   * Set when the answer was SHORTENED by the byte budget, so the page can say so.
   *
   * The server has reported this since the spill shipped and the client never read it — so a hundred-match
   * search could show a handful of records with nothing anywhere on the page explaining why. Under the old
   * record cap that was three records out of a hundred.
   *
   * Only the two numbers an operator can act on are kept. The four size figures are deliberately
   * left out: they are for a caller tuning a request programmatically, and a byte count in the interface is a
   * number nobody can do anything with.
   */
  recallTruncated = signal<{ returned: number; count: number } | null>(null);

  /** Type names offered by the recall "filter by type" dropdown (F5): schema type
   *  names for the space UNION the distinct `type` values present in the loaded
   *  records, so it's usable whether or not a schema is defined. */
  recallTypeSchemaOptions(): string[] {
    const ts = this.store.spaceMeta()?.typeSchemas;
    return [...new Set([
      ...Object.keys(ts?.entity ?? {}),
      ...Object.keys(ts?.memory ?? {}),
      ...this.store.memories().map(m => m.type),
      ...this.store.entities().map(e => e.type),
      ...this.store.edges().map(e => e.type),
    ].filter((t): t is string => !!t))].sort();
  }
  /** Type restriction + per-type minimums. Unchecked types are simply not sent. */
  recallTypeOpts: RecallTypeOpt[] =
    RECORD_TYPES.map(type => ({ type, on: false, min: null }));
  /*
   * `showRecallAdvanced` was here and is GONE with the button it drove.
   *
   * Six parameters lived behind it, which is the arrangement the owner's instruction rules out: a field
   * an operator cannot see is a capability they do not know they have. Groups replace it, and the row
   * this came from says so in as many words — the answer is not a second disclosure.
   */
  /**
   * Whether a search has COMPLETED, which an empty result list cannot say on its own.
   *
   * `recallResults()` is `[]` both before the first search and after one that matched nothing, so the panel
   * rendered the same thing for both: nothing at all. The advanced-query side has never had this problem —
   * it keeps the whole response, so `res.results.length === 0` is a state it can render. Semantic search
   * keeps only the array, and an array cannot distinguish the two.
   */
  recallRan = signal(false);

  recallRunning = signal(false);
  recallResults = signal<RecallResult[]>([]);
  /** The response as it arrived, for the JSON view. Never read by the rendered view. */
  recallRaw = signal<unknown>(null);

  /** Set when the traversal stopped short, with the download link if the instance could write one. */
  graphShort = signal<{ nodes: number; complete: RecallResponse['graphComplete'] | null } | null>(null);

  /**
   * Which view of the answer is showing.
   *
   * RENDERED by default, because that is the one that answers a question. The JSON view is for checking
   * what an MCP caller would receive from the same request, which is what this panel is for — and a reader
   * who wants it asks for it, rather than being handed a wall of braces first.
   */
  answerView = signal<'rendered' | 'json'>('rendered');

  @ViewChild(JsonTreeComponent) tree?: JsonTreeComponent;

  /**
   * The tree currently on screen, so the header's expand/collapse buttons can drive it.
   *
   * ONE handle for both modes, and it cannot be ambiguous: the modes are mutually exclusive, so at most one
   * tree exists at a time. A template reference per tree was the first attempt and does not compile — a
   * reference does not cross an `@if` boundary, and the buttons live in the card header while the tree
   * lives in its body. The AOT build is what said so; the spec transpile had passed.
   */

  /**
   * How big the answer was, in the unit a caller pays in.
   *
   * Serialised here rather than taken from the response's own `charsReturned`: that field counts the RESULT
   * LIST as the server framed it, and what the reader is looking at is the whole response. Two numbers that
   * disagree by a little are worse than one number that is what it says it is.
   */
  answerSize = computed(() => {
    const raw = this.recallRaw();
    if (raw === null) return '';
    const chars = JSON.stringify(raw).length;
    return chars < 1024 ? `${chars} chars` : `${(chars / 1024).toFixed(1)} KB`;
  });
  recallError = signal('');

  /**
   * Recall hits with each document's chunk matches collapsed under it (4c-ii).
   *
   * A long paper relevant in five places used to return five near-identical rows, pushing everything else
   * out of view. The server has always sent `parentFileId` + an inlined `parentFile` on chunk hits; nothing
   * read them until now, so this is presentation only — no API change, and MCP callers still get the flat
   * list they are built around.
   */
  recallGroups = computed(() => groupRecallResults(this.recallResults()));

  /** A match's neighbourhood, grouped by kind — rendered under the match, never beside it in the ranking. */
  relatedOf(hit: RecallResult) { return relatedOf(hit); }
  orderingOf(hit: RecallResult) { return orderingOf(hit as Record<string, unknown>); }

  /** The heading a passage sits under, when the chunker recorded one. */
  chunkHeading(r: RecallResult): string | undefined {
    return chunkLabel(r);
  }

  /** The passage's own text for display, or undefined when the hit carries none. */
  passageOf(r: RecallResult): string | undefined {
    return passageText(r);
  }

  runQuery(): void {
    this.queryFilterError.set('');
    this.queryProjectionError.set('');
    this.queryError.set('');

    let filter: Record<string, unknown> = {};
    let projection: Record<string, unknown> | undefined;

    if (this.queryForm.filter.trim()) {
      try { filter = JSON.parse(this.queryForm.filter.trim()); }
      catch (e) { this.queryFilterError.set(`Invalid JSON — ${e instanceof Error ? e.message : 'check your filter syntax'}`); return; }
    }
    if (this.queryForm.projection.trim()) {
      try { projection = JSON.parse(this.queryForm.projection.trim()); }
      catch (e) { this.queryProjectionError.set(`Invalid JSON — ${e instanceof Error ? e.message : 'check your projection syntax'}`); return; }
    }

    this.queryRunning.set(true);
    this.brainApi.queryBrain(this.spaceId(), {
      collection: this.queryForm.collection,
      filter,
      projection,
      limit: this.queryForm.limit,
      maxTimeMS: this.queryForm.maxTimeMS,
    }).subscribe({
      next: (res) => { this.queryRunning.set(false); this.queryResult.set(res); },
      error: (err) => {
        this.queryRunning.set(false);
        this.queryError.set(err.error?.error ?? 'Query failed');
      },
    });
  }

  clearQuery(): void {
    this.queryResult.set(null);
    this.queryError.set('');
  }

  runRecall(): void {
    /*
     * The request is built by `recallRequestFrom`, which is also what the JSON preview beside the form
     * shows. Not two readers of the same rules: the preview is worth nothing unless it is the SAME
     * request, and a second implementation of "the same" is this codebase's most expensive defect shape —
     * with a worse failure mode here, because a preview is BELIEVED. A caller pastes the JSON, gets a
     * different answer from the one on screen, and nothing anywhere is wrong.
     *
     * What stays here is what a REQUEST is, rather than what it contains: the empty-query no-op, the
     * error message, and the three signals cleared on the click so a stale one cannot describe an answer
     * nobody has received yet.
     */
    const { body, errorKey } = recallRequestFrom(this.recallForm, this.recallTypeOpts);
    if (errorKey) { this.recallError.set(this.transloco.translate(errorKey)); return; }
    if (!body) return;   // a blank question is a no-op, not an error to report

    this.recallRunning.set(true);
    this.recallError.set('');
    this.recallResults.set([]);
    this.recallTruncated.set(null);
    this.recallRan.set(false);   // a stale "no matches" must not describe the search now running
    this.brainApi.recallBrain(this.spaceId(), body).subscribe({
      /*
       * STORED AS THE SERVER SENT IT. Not flattened, and that is the fix rather than a refactor.
       *
       * This used to append every `_graph` node to the result list, so a traversed neighbour arrived looking
       * exactly like a match: in rank order, counted in the total, carrying a `source: 'traverse'` marker
       * that nothing here rendered. Reported by the owner — *"the graph entries seem to be included in rank
       * and handed as main result instead of part of a graph"* — along with the reason it matters more here
       * than it would elsewhere: **this panel is the surface people test queries on.** A request tried here
       * and then sent by an MCP client has to come back the same shape, or the panel is teaching a contract
       * the product does not have.
       *
       * So the list holds exactly what the server ranked, each record keeps its own `_graph`, and the
       * neighbourhood renders beneath the match that reached it.
       */
      next: (res) => {
        this.recallRunning.set(false);
        this.recallRan.set(true);
        this.recallResults.set(res.results);
        // THE WHOLE RESPONSE, kept for the JSON view. The rendered view reads the result list; the JSON view
        // has to show `count`, the budget fields and every `_graph` — those are what a caller reasons about,
        // and showing only the results is what made this panel teach a shape the product does not have.
        this.recallRaw.set(res);
        /*
         * A SHORT GRAPH IS ITS OWN FACT, not a shade of `truncated`.
         *
         * `truncated` is the byte budget dropping whole matches off the end of the ranking. This is the WALK
         * stopping, so what is missing are records it never read — and the panel showed `graphNodes` with
         * nothing to say whether that was the whole neighbourhood or the first few of forty.
         *
         * `graphComplete` may be absent while this is true: a bounded link scan leaves nothing complete to
         * write, because the missing records are precisely the ones never read. So the link is optional and
         * its absence is not an error.
         */
        this.graphShort.set(res.graphTruncated === true
          ? { nodes: res.graphNodes ?? 0, complete: res.graphComplete ?? null }
          : null);
        // `=== true` rather than truthy: the field is optional on the type (an older server sends none), and an
        // absent one must read as "not truncated" rather than as "unknown".
        this.recallTruncated.set(res.truncated === true
          ? { returned: res.returned ?? res.results.length, count: res.count }
          : null);
      },
      // NOT `recallRan` on an error: a failed search did not find nothing, it did not finish. Saying "no
      // matches" beside an error message would tell the reader two different things about one click.
      error: (err) => { this.recallRunning.set(false); this.recallError.set(err.error?.error ?? 'Search failed'); },
    });
  }

  clearRecall(): void {
    this.recallRan.set(false);
    this.recallResults.set([]);
    this.recallRaw.set(null);
    this.graphShort.set(null);
    this.recallError.set('');
    this.recallTruncated.set(null);
  }

  /**
   * The graph node a recall hit corresponds to, or null when it has none.
   *
   * An entity IS a node. An edge is shown by focusing the entity it starts from — the same choice the edges
   * tab makes, so the button means the same thing in both places. Memories, chrono entries and file chunks
   * have no node, and get no button rather than one that lands on an empty graph.
   */
  graphTargetOf(hit: RecallResult): string | null {
    const id = hit.type === 'entity' ? hit['_id'] : hit.type === 'edge' ? hit['from'] : undefined;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
}
