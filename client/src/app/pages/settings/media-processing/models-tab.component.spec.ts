/**
 * ModelsTabComponent — face-recognition Person Entity Types picker (item 16).
 *
 * The field is sourced from the Schema Library's entity types, but any already-stored value stays
 * selectable/removable. These tests exercise the component logic directly (no template render), so the
 * services are light mocks.
 */
import { readFileSync } from 'node:fs';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../../testing/transloco-testing';
import { ModelsTabComponent } from './models-tab.component';
import { MediaProcessingStateService } from './media-processing-state.service';
import { PipelineStatusService } from './pipeline-status.service';
import { SchemaApi } from '../../../core/schema-api.service';
import { HttpClient } from '@angular/common/http';
import { ConfirmDialogService } from '../../../core/confirm-dialog.service';

function setup(libEntries: { knowledgeType: string; typeName: string }[] = [], initialTypes?: string[]) {
  const touched = vi.fn();
  const state = {
    face: { personEntityTypes: initialTypes } as { personEntityTypes?: string[] },
    touched: { set: touched },
    faceLocked: () => false,
    managed: false,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ModelsTabComponent, getTranslocoModule()],
    providers: [
      { provide: MediaProcessingStateService, useValue: state },
      { provide: PipelineStatusService, useValue: { status: () => null, bySidecarKey: () => new Map() } },
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: libEntries }) } },
    ],
  });
  const c = TestBed.createComponent(ModelsTabComponent).componentInstance;
  c.ngOnInit(); // loads libEntityTypes from the mocked library
  return { c, state, touched };
}

/**
 * The card footer, RENDERED (B.3 / B.4).
 *
 * Both findings are about what the row looks like, so both are asserted against a real DOM rather than
 * the source: a CSS rule that never applies to anything still greps fine, and a disabled button with no
 * explanation is indistinguishable from a broken one only when you look at it.
 */
function renderTab(cfg: Record<string, unknown>) {
  TestBed.resetTestingModule();
  const http = {
    get: vi.fn().mockReturnValue(of(cfg)),
    patch: vi.fn().mockReturnValue(of({ ok: true, config: cfg })),
    post: vi.fn().mockReturnValue(of({ ok: true, reachable: true })),
  } as unknown as HttpClient;
  TestBed.configureTestingModule({
    imports: [ModelsTabComponent, getTranslocoModule()],
    providers: [
      MediaProcessingStateService,
      { provide: HttpClient, useValue: http },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      { provide: PipelineStatusService, useValue: {
        status: () => null, bySidecarKey: () => new Map(),
        modelState: () => 'unconfigured', sidecarState: () => 'unconfigured',
      } },
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }) } },
    ],
  });
  const state = TestBed.inject(MediaProcessingStateService);
  state.load();
  const fixture = TestBed.createComponent(ModelsTabComponent);
  fixture.detectChanges();
  return { fixture, state, el: fixture.nativeElement as HTMLElement };
}

/** Minimal media-config shape: only what the Models tab reads. */
const CFG = (over: Record<string, unknown> = {}) => ({
  visionProvider: 'local', sttProvider: 'local',
  vision: { baseUrl: 'http://ollama:11434', model: 'llava' },
  stt: { baseUrl: 'http://whisper:9000', model: 'base' },
  embedding: { provider: 'local', model: 'nomic-embed-text-v1.5', dimensions: 768, similarity: 'cosine' },
  documentProcessing: { mode: 'ocr', assistModel: { baseUrl: '', model: '' } },
  lockedByInfra: [],
  ...over,
});

describe('ModelsTabComponent — the card footer', () => {
  // Transloco echoes keys in specs (see transloco-testing.ts), so the assertions are on keys — stable,
  // and they do not go stale when the English wording is edited.
  const embeddingCard = (el: HTMLElement) => el.querySelector('#model-card-embedding') as HTMLElement;

  it('B.4: the in-process embedder says why Test is disabled, instead of just being dead', () => {
    // "A dead button and a broken button look identical." With no endpoint the embedder IS the bundled
    // in-process model — a fact about the configuration, not a fault.
    const { el } = renderTab(CFG());
    const card = embeddingCard(el);
    expect(card, 'the embedding card renders').toBeTruthy();
    const test = [...card.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('mediaProcessing.action.test'));
    expect(test, 'it has a Test button').toBeTruthy();
    expect((test as HTMLButtonElement).disabled).toBe(true);
    expect(card.textContent).toContain('mediaProcessing.test.inProcess');
  });

  it('B.4: and says nothing of the kind once an endpoint IS configured', () => {
    const { el } = renderTab(CFG({ embedding: { provider: 'external', baseUrl: 'http://emb:8080', model: 'nomic' } }));
    const card = embeddingCard(el);
    expect(card.textContent).not.toContain('mediaProcessing.test.inProcess');
    const test = [...card.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').includes('mediaProcessing.action.test'));
    expect((test as HTMLButtonElement).disabled, 'and Test is live again').toBe(false);
  });

  // NOT tested here: that a markup-bearing translation renders as markup rather than printing its tags.
  // Specs echo translation KEYS (see transloco-testing.ts), so there are no tags in a unit render and any
  // such assertion passes against broken code — the first attempt at one did exactly that. It lives in
  // `testing/standalone/i18n-markup-rendering.test.js`, which reads the real translations and enumerates
  // every key that carries markup.

  it('B.3: the test row wraps, so a status pill can never push an action out of the card', () => {
    // It was `nowrap` with nothing shrinkable but the hint, so a second pill pushed the Verify button
    // outside the card and out of reach — one Verify per page load, on the feature they most wanted.
    // Read from the applied style rather than the source: the rule has to actually reach the element.
    const { el } = renderTab(CFG());
    const row = el.querySelector('.testrow');
    expect(row, 'the footer row exists').toBeTruthy();
    expect(getComputedStyle(row as Element).flexWrap).toBe('wrap');
  });
});

describe('ModelsTabComponent — person-types picker', () => {
  it('loads entity types from the library (entities only, deduped, sorted)', () => {
    const { c } = setup([
      { knowledgeType: 'entity', typeName: 'person' },
      { knowledgeType: 'fact', typeName: 'note' },     // non-entity, excluded
      { knowledgeType: 'entity', typeName: 'org' },
      { knowledgeType: 'entity', typeName: 'person' },    // dup
    ]);
    expect(c.libEntityTypes()).toEqual(['org', 'person']);
  });

  it('availablePersonTypes excludes already-selected types', () => {
    const { c } = setup([
      { knowledgeType: 'entity', typeName: 'person' },
      { knowledgeType: 'entity', typeName: 'org' },
    ], ['person']);
    expect(c.availablePersonTypes()).toEqual(['org']);
  });

  it('addPersonType adds a type (no dup) and marks the form touched', () => {
    const { c, state, touched } = setup([{ knowledgeType: 'entity', typeName: 'org' }], ['person']);
    c.addPersonType('org');
    expect(state.face.personEntityTypes).toEqual(['person', 'org']);
    expect(touched).toHaveBeenCalledWith(true);
    // adding a dup is a no-op
    c.addPersonType('org');
    expect(state.face.personEntityTypes).toEqual(['person', 'org']);
  });

  it('removePersonType drops the type and marks the form touched', () => {
    const { c, state, touched } = setup([], ['person', 'org']);
    c.removePersonType('person');
    expect(state.face.personEntityTypes).toEqual(['org']);
    expect(touched).toHaveBeenCalledWith(true);
  });

  it('keeps a stored type that is no longer in the library (still removable)', () => {
    // 'legacy' is stored but not in the library — it must stay listed and removable.
    const { c, state } = setup([{ knowledgeType: 'entity', typeName: 'person' }], ['legacy']);
    expect(state.face.personEntityTypes).toContain('legacy');
    expect(c.availablePersonTypes()).toEqual(['person']);   // library options don't include the stored 'legacy'
    c.removePersonType('legacy');
    expect(state.face.personEntityTypes).toEqual([]);
  });
});

/**
 * The per-card Save button, asserted in the DOM.
 *
 * The service tests drive `cardDirty`/`saveCard` directly, which is exactly the blind spot that let the
 * graph panel's filters ship documented-but-unreachable: logic that works, wired to no control. A
 * mutation that stopped rendering these buttons entirely survived the service suite. So this renders the
 * real template against the real service and asserts the button is THERE, in the right card and no other.
 */
describe('ModelsTabComponent — per-card Save button', () => {
  function render(cfg: Record<string, unknown>) {
    TestBed.resetTestingModule();
    const patch = vi.fn().mockReturnValue(of({ ok: true, config: cfg }));
    const http = { get: vi.fn().mockReturnValue(of(cfg)), patch, post: vi.fn().mockReturnValue(of({})) };
    TestBed.configureTestingModule({
      imports: [ModelsTabComponent, getTranslocoModule()],
      providers: [
        MediaProcessingStateService,
        { provide: HttpClient, useValue: http },
        { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
        // The rendered template asks for more of this service than the logic-only tests do.
        { provide: PipelineStatusService, useValue: {
          status: () => null, bySidecarKey: () => new Map(),
          modelState: () => null, sidecarState: () => null,
        } },
        { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }) } },
      ],
    });
    const state = TestBed.inject(MediaProcessingStateService);
    state.load();
    const fixture = TestBed.createComponent(ModelsTabComponent);
    fixture.detectChanges();
    return { fixture, state };
  }

  const CFG = {
    visionProvider: 'local', sttProvider: 'local',
    vision: { baseUrl: 'http://ollama:11434', model: 'llava' },
    stt: { baseUrl: 'http://whisper:9000', model: 'base' },
    embedding: { provider: 'local', model: 'nomic', dimensions: 768, similarity: 'cosine' },
    documentProcessing: { mode: 'ocr', assistModel: {} },
    faceRecognition: { enabled: false },
    lockedByInfra: [],
  };

  const saveIn = (fixture: { nativeElement: HTMLElement }, card: string) =>
    fixture.nativeElement.querySelector(`#model-card-${card} .card-save`);

  it('shows no Save button until something changes', () => {
    const { fixture } = render(CFG);
    expect(fixture.nativeElement.querySelectorAll('.card-save').length).toBe(0);
  });

  it('shows Save in the edited card and in NO other', () => {
    const { fixture, state } = render(CFG);
    state.form.stt!.model = 'large-v3';
    state.touched.set(true);
    fixture.detectChanges();

    expect(saveIn(fixture, 'stt'), 'the edited card').toBeTruthy();
    for (const other of ['embedding', 'vision', 'assist', 'face']) {
      expect(saveIn(fixture, other), `${other} must not offer a save`).toBeNull();
    }
  });

  it('never offers Save on the env-only cards', () => {
    // doc-render and unstructured report infrastructure and have no editable field; a button there
    // would be a control that cannot do anything.
    const { fixture, state } = render(CFG);
    state.form.stt!.model = 'large-v3';
    state.touched.set(true);
    fixture.detectChanges();

    expect(saveIn(fixture, 'doc-render')).toBeNull();
    expect(saveIn(fixture, 'unstructured')).toBeNull();
  });

  it('clicking it saves that card', () => {
    const { fixture, state } = render(CFG);
    const spy = vi.spyOn(state, 'saveCard');
    state.form.vision!.model = 'moondream';
    state.touched.set(true);
    fixture.detectChanges();

    (saveIn(fixture, 'vision') as HTMLButtonElement).click();

    expect(spy).toHaveBeenCalledWith('vision');
  });
});

/**
 * R.6 — a result arriving must not move the buttons.
 *
 * A test result is rendered next to the button that produced it, which is right for what a screen reader
 * hears and wrong for layout: the pill and detail line sit BETWEEN Test and Verify in the DOM, so pressing
 * Test pushed Verify out from under the pointer that had just been over it, and the next click landed on
 * whatever had slid into that spot. The fix lays the actions out first with `order`, leaving DOM order alone.
 *
 * jsdom has no layout engine, so this cannot be measured here. It WAS measured, in Edge against the built
 * bundle, on the vision card with a failing Test:
 *
 *     with the order rules:     Test left=295  Verify left=419   (result wrapped to a second line)
 *     order rules removed:      Test left=295  Verify left=295, top +33px  (Verify fell to line 2)
 *
 * What this test can do is fail if the rules are deleted or reordered — the measurement lives in the PR,
 * the rule lives here.
 */
describe('ModelsTabComponent — the footer row does not reflow under the cursor', () => {
  // Read from the project root: under vitest, `import.meta.url` is not a file: URL, so `new URL(...)` throws
  // before a single assertion runs. Vitest's cwd is `client/`.
  const source = readFileSync('src/app/pages/settings/media-processing/models-tab.component.ts', 'utf8');

  it('lays out the action buttons before any result', () => {
    expect(source).toMatch(/\.testrow > button\s*\{[^}]*order:\s*0/);
    expect(source).toMatch(/\.testrow > app-status-pill,\s*\.testrow > \.hint\s*\{[^}]*order:\s*1/);
  });

  it('keeps Save at the far end, after the results', () => {
    // Save is the card's own action and belongs at the end of the row, not beside Test as a peer.
    //
    // The rule is read from `card-save.component.ts`, which is where the BUTTON is, and that pairing is the
    // point rather than bookkeeping. The rule lived in the tab; the button moved into its own component when
    // three more cards needed one; emulated view encapsulation scopes a component's styles to elements
    // written in that component's own template, so the tab's rule stopped matching a button it no longer
    // contains. Save rendered between Verify and the hint, with the class still on the element, the CSS
    // still in the file, and nothing erroring — caught by looking at it, not by a test. Asserting the rule
    // where the element is means the two cannot drift apart again.
    const save = readFileSync('src/app/pages/settings/media-processing/card-save.component.ts', 'utf8');
    expect(save).toMatch(/\.card-save\s*\{[^}]*order:\s*2[^}]*margin-left:\s*auto/);
    expect(save).toMatch(/:host\s*\{[^}]*display:\s*contents/);
    // And the tab must not keep a copy: a rule that matches nothing reads as covered.
    expect(source).not.toMatch(/\.testrow \.card-save\s*\{/);
  });

  it('still wraps rather than overflowing the card', () => {
    // B.3: nowrap is what pushed Verify outside the card entirely. The order rules must not reintroduce it.
    expect(source).toMatch(/\.testrow\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(source).not.toMatch(/\.testrow\s*\{[^}]*flex-wrap:\s*nowrap/);
  });
});
