/**
 * Retype under strict (Q-93, plan v3 section 4 "Retype", R6-14): what every record editor does when the server refuses a
 * type change because it would leave properties the new type does not declare.
 *
 * ## The rule
 *
 * Under strict a write whose NEW type does not declare a key the record carries is refused with HTTP 422 and the structured
 * body (`introduced` rows, `preExisting` rows). A key declared on the OLD type and undeclared on the new one is INTRODUCED by
 * the retype; a key undeclared on both is PRE-EXISTING and does not block. The plan's flow, one helper (`saveWithRetype`) that
 * every brain update goes through:
 *
 * - every introduced row an UNDECLARED-KEY row (`properties.<key>`, carrying `declared`) -> ask once, through
 *   `RetypeConfirmService.confirm([{ key, value }])` (key WITHOUT the `properties.` prefix);
 * - yes -> send the update AGAIN with `deleteFields: ['properties.<key>', ...]` and a `properties` map without those keys
 *   (the server cap is 100 per write, so a larger set comes back as a second refusal and a second confirm);
 * - no -> no second update, and the type/kind/label control goes back to what it was;
 * - any introduced row that is NOT an undeclared-key row (a rule, a type mismatch) -> no confirm: that is an ordinary refusal
 *   and is shown as one;
 * - a refusal that lists only pre-existing rows never opens the confirm; a write that succeeds (warn/off mode) never asks.
 *
 * ## Why behavioural, over every surface, and what is derived
 *
 * Eight places change a record's type: the four tabs' inline edit rows and the record drawer's four kinds. Each used to call
 * `brainApi.update*` itself, which is how a flow added to one is absent from the next. The behavioural scenarios run over all
 * eight; the gate at the bottom DERIVES the call sites by scanning the client sources (so a ninth, `entry-popup.component.ts`
 * is not in the list because someone remembered it) and holds each to the helper.
 *
 * The confirm service is spied on the real instance when it exists, and replaced by a bare spy when it does not, so on the
 * unchanged base the failure is "the confirm was never asked" and not an import error.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { throwError, of, type Observable } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PropertySchema, SpaceMetaResponse } from '../../core/api.types';
import { BrainStore } from './brain-store.service';
import { CLIENT_ROOT, trackedAppSources } from '../../testing/tracked-sources';
import { stripComments } from '../../testing/strip-comments';
import {
  DRAWER_EDITORS, TAB_EDITORS, httpFailure, mountDrawer, mountTab, refusalBody, settle,
  type WireRow,
} from '../../testing/brain-editors-harness';

type Props = Record<string, string | number | boolean>;
type Kind = 'entity' | 'fact' | 'edge' | 'chrono';
type Mode = 'inline' | 'drawer';
type UpdateBody = { type?: string; label?: string; properties?: Props; deleteFields?: string[] };

/** The record starts on type `A`, which declares `keep` and `drop`; `B` declares `keep` and `extra`, so `drop` is what a retype introduces. */
const KINDS: { kind: Kind; a: string; b: string }[] = [
  { kind: 'entity', a: 'Person', b: 'Company' },
  { kind: 'edge', a: 'knows', b: 'works_at' },
  { kind: 'chrono', a: 'deadline', b: 'event' },
  { kind: 'fact', a: 'decision', b: 'note' },
];
const A_DECLARES = ['keep', 'drop'];
const B_DECLARES = ['keep', 'extra'];

const schemaOf = (keys: string[]): Record<string, PropertySchema> => Object.fromEntries(keys.map(k => [k, {}]));

function metaFor(aKeys: string[] = A_DECLARES): SpaceMetaResponse {
  const typeSchemas: Record<string, Record<string, { propertySchemas: Record<string, PropertySchema> }>> = {};
  for (const { kind, a, b } of KINDS) {
    typeSchemas[kind] = { [a]: { propertySchemas: schemaOf(aKeys) }, [b]: { propertySchemas: schemaOf(B_DECLARES) } };
  }
  return { typeSchemas } as unknown as SpaceMetaResponse;
}

const undeclaredRow = (key: string, value: unknown): WireRow =>
  ({ field: `properties.${key}`, value, reason: `property '${key}' is not declared on this type`, declared: B_DECLARES });

const NAME_OF: Record<Kind, Record<Mode, { exact: string[]; re: RegExp }>> = {
  entity: { inline: { exact: ['editEntType'], re: /^edit.*type$/i }, drawer: { exact: ['drwEntType'], re: /^drw.*type$/i } },
  edge: { inline: { exact: ['editEdgeLabel'], re: /^edit.*label$/i }, drawer: { exact: ['drwEdgeLabel'], re: /^drw.*label$/i } },
  chrono: { inline: { exact: ['editChronoKind'], re: /^edit.*kind$/i }, drawer: { exact: ['drwChronoKind'], re: /^drw.*kind$/i } },
  fact: { inline: { exact: [], re: /^edit.*type$/i }, drawer: { exact: ['drwMemType'], re: /^drw.*type$/i } },
};

function typeControl(host: HTMLElement, kind: Kind, mode: Mode): HTMLSelectElement | HTMLInputElement | null {
  const { exact, re } = NAME_OF[kind][mode];
  const all = [...host.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select[name], input[name]')];
  for (const n of exact) {
    const hit = all.find(c => c.getAttribute('name') === n);
    if (hit) return hit;
  }
  return all.find(c => re.test(c.getAttribute('name') ?? '')) ?? null;
}

/** The confirm: the real service's `confirm` spied when the service exists, a bare spy when it does not (so the red is "never asked"). */
async function spyConfirm(answer: (keys: { key: string; value: unknown }[]) => boolean) {
  const path = '../../core/retype-confirm.service';
  let Service: (new () => { confirm(k: { key: string; value: unknown }[]): Promise<boolean> }) | undefined;
  try { Service = (await import(/* @vite-ignore */ path)).RetypeConfirmService; } catch { /* absent on the base */ }
  if (!Service) return vi.fn(async (_keys: { key: string; value: unknown }[]) => false);
  const real = TestBed.inject(Service);
  return vi.spyOn(real, 'confirm').mockImplementation(async keys => answer(keys));
}

interface Run {
  host: HTMLElement;
  api: ReturnType<typeof mountTab>['api'];
  updateApi: string;
  confirm: Awaited<ReturnType<typeof spyConfirm>>;
  /** Pick the new type in the editor's own control. */
  setType(type: string): Promise<void>;
  typeValue(): string;
  keys(): string[];
  save(): void;
  /** Render and let the pending promises of the last action run (the retype flow is asynchronous). */
  settled(): Promise<void>;
  saveButton(): HTMLButtonElement | null;
  /** Every update call's body, in order. */
  sent(): UpdateBody[];
  /** The refusal text a person can see: every role=alert region. */
  alerts(): string;
}

type ServerFn = (body: UpdateBody) => Observable<unknown>;

/** Open the editor of `mode` for `kind` on a record of type `a` storing `stored`, with the update API answered by `server`. */
async function run(
  kind: Kind, mode: Mode, stored: Props, server: ServerFn, answer: (k: { key: string; value: unknown }[]) => boolean,
  aKeys: string[] = A_DECLARES,
): Promise<Run> {
  const { a } = KINDS.find(k => k.kind === kind)!;
  const over = { [kind === 'edge' ? 'label' : 'type']: a, properties: stored };
  if (mode === 'drawer') {
    const editor = DRAWER_EDITORS.find(e => e.kind === kind)!;
    const m = mountDrawer(editor);
    TestBed.inject(BrainStore).spaceMeta.set(metaFor(aKeys));
    m.api[editor.updateApi].mockImplementation((_s: string, _id: string, body: UpdateBody) => server(body));
    m.state.open(kind as never, editor.record(over) as never);
    await settle(m.fixture);
    await settle(m.fixture);
    const confirm = await spyConfirm(answer);
    return finish(m.fixture, m.host, m.api, editor.updateApi, confirm, kind, mode, () => m.state.save(),
      () => m.host.querySelector<HTMLButtonElement>('.drawer-header button.btn-primary'));
  }
  const editor = TAB_EDITORS.find(e => e.kind === kind)!;
  const m = mountTab(editor);
  m.c['store'].spaceMeta.set(metaFor(aKeys));
  m.api[editor.updateApi].mockImplementation((_s: string, _id: string, body: UpdateBody) => server(body));
  const record = editor.record(over);
  m.c['store'][editor.storeList].set([record]);
  editor.openEdit(m.c, record);
  await settle(m.fixture);
  await settle(m.fixture);
  const confirm = await spyConfirm(answer);
  return finish(m.fixture, m.host, m.api, editor.updateApi, confirm, kind, mode, () => editor.submitEdit(m.c, 'r1'),
    () => m.host.querySelector<HTMLButtonElement>('td button.btn-primary'));
}

function finish(
  fixture: Parameters<typeof settle>[0], host: HTMLElement, api: Run['api'], updateApi: string, confirm: Run['confirm'],
  kind: Kind, mode: Mode, doSave: () => void, button: () => HTMLButtonElement | null,
): Run {
  return {
    host, api, updateApi, confirm,
    async setType(type) {
      const control = typeControl(host, kind, mode);
      expect(control, `no type control for a ${kind} in the ${mode} editor`).toBeTruthy();
      control!.value = type;
      control!.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      await settle(fixture);
      await settle(fixture);
    },
    typeValue: () => typeControl(host, kind, mode)?.value ?? '',
    keys: () => [...host.querySelectorAll<HTMLInputElement>('.prop-row .prop-key')].map(i => i.value).sort(),
    save: doSave,
    saveButton: button,
    settled: () => settle(fixture),
    sent: () => api[updateApi].mock.calls.map(c => c[2] as UpdateBody),
    alerts: () => [...host.querySelectorAll('[role="alert"]')].map(n => n.textContent ?? '').join(' | '),
  };
}

const typeOf = (body: UpdateBody): string | undefined => body.type ?? body.label;
const fail422 = (introduced: WireRow[], preExisting: WireRow[] = []) =>
  throwError(() => httpFailure(422, refusalBody({ introduced, preExisting })));

/** A strict server: refuses a write that leaves a key the new type does not declare and the old type did, answers a write that does not. */
function strictServer(oldDeclares: string[] = A_DECLARES): ServerFn {
  return body => {
    const gone = new Set((body.deleteFields ?? []).map(f => f.replace(/^properties\./, '')));
    const introduced = Object.keys(body.properties ?? {})
      .filter(k => !gone.has(k) && !B_DECLARES.includes(k) && oldDeclares.includes(k))
      .map(k => undeclaredRow(k, (body.properties as Props)[k]));
    return introduced.length ? fail422(introduced) : of({ _id: 'r1', ...body });
  };
}

const SURFACES = KINDS.flatMap(k => (['inline', 'drawer'] as const).map(mode => ({ ...k, mode, label: `${k.kind} ${mode}` })));
const STORED: Props = { keep: 'k', drop: 'd' };

describe('the surfaces under test are the surfaces that change a type', () => {
  it('there is a tab row and a drawer row for every kind', () => {
    for (const k of KINDS) {
      expect(TAB_EDITORS.some(e => e.kind === k.kind), `no tab row for ${k.kind}`).toBe(true);
      expect(DRAWER_EDITORS.some(e => e.kind === k.kind), `no drawer row for ${k.kind}`).toBe(true);
    }
    expect(SURFACES.length).toBeGreaterThanOrEqual(8);
  });
});

describe.each(SURFACES)('retype from the $label editor', ({ kind, mode, a, b }) => {
  it('a refusal whose introduced rows are all undeclared keys asks ONCE, with the keys (no prefix) and their values', async () => {
    const r = await run(kind, mode, STORED, strictServer(), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.confirm, 'the confirm was never asked').toHaveBeenCalledTimes(1));
    expect(r.confirm.mock.calls[0][0]).toEqual([{ key: 'drop', value: 'd' }]);
  });

  it('on yes, sends the update again with deleteFields and no removed key in `properties` (type still the new one)', async () => {
    const r = await run(kind, mode, STORED, strictServer(), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.sent(), 'no second update was sent after the confirm').toHaveLength(2));
    const [first, second] = r.sent();
    expect(typeOf(first)).toBe(b);
    expect(first.deleteFields ?? [], 'the first attempt must not delete anything').toEqual([]);
    expect(first.properties).toHaveProperty('drop');
    expect(typeOf(second)).toBe(b);
    expect(second.deleteFields).toEqual(['properties.drop']);
    expect(second.properties ?? {}).not.toHaveProperty('drop');
    expect(second.properties).toHaveProperty('keep', 'k');
  });

  it('on no, sends nothing more and puts the type control back to what it was', async () => {
    const r = await run(kind, mode, STORED, strictServer(), () => false);
    await r.setType(b);
    expect(r.typeValue()).toBe(b);
    r.save();
    await vi.waitFor(() => expect(r.confirm, 'the confirm was never asked').toHaveBeenCalledTimes(1));
    await r.settled();
    await vi.waitFor(() => expect(r.typeValue(), 'Cancel did not restore the previous type').toBe(a));
    expect(r.sent(), 'a second update went out after Cancel').toHaveLength(1);
    expect(r.keys(), 'cancelling lost a property').toEqual(expect.arrayContaining(['keep', 'drop']));
    expect(r.saveButton()?.disabled, 'Save stayed disabled after Cancel').toBe(false);
  });

  it('a rule row among the introduced rows is an ordinary refusal: no confirm, the refusal shown as an alert', async () => {
    const rule: WireRow = { field: 'rules.positive', reason: 'count must be positive', outcome: 'violated' };
    const r = await run(kind, mode, STORED, () => fail422([rule]), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.alerts(), 'the refusal is not shown in a role=alert region').toContain('count must be positive'));
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.sent()).toHaveLength(1);
  });

  it('a type-mismatch row among the introduced rows is an ordinary refusal too', async () => {
    const mismatch: WireRow = { field: 'properties.keep', value: 'k', reason: 'property \'keep\' must be a number', outcome: 'violated' };
    const r = await run(kind, mode, STORED, () => fail422([mismatch]), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.alerts()).toContain('must be a number'));
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.sent()).toHaveLength(1);
  });

  it('a mix of an undeclared-key row and a rule row opens no confirm (deleting the key would not fix the write)', async () => {
    const rule: WireRow = { field: 'rules.positive', reason: 'count must be positive', outcome: 'violated' };
    const r = await run(kind, mode, STORED, () => fail422([undeclaredRow('drop', 'd'), rule]), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.alerts()).toContain('count must be positive'));
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.sent()).toHaveLength(1);
  });

  it('a refusal with only PRE-EXISTING rows never opens the confirm, and says what it is', async () => {
    const legacy: WireRow = { field: 'properties.legacy', value: 'z', reason: 'property \'legacy\' is not declared on this type', declared: B_DECLARES };
    const r = await run(kind, mode, { ...STORED, legacy: 'z' }, () => fail422([], [legacy]), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.alerts(), 'the refusal is not shown in a role=alert region').toContain('legacy'));
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.sent()).toHaveLength(1);
  });

  it('when the write simply succeeds (warn or off mode) nothing is asked, and one update is sent', async () => {
    // The drawer renders the record the update answers with (author line), so the answer is a whole record.
    const r = await run(kind, mode, STORED, body => of({ _id: 'r1', author: { instanceId: 'test-instance', instanceLabel: 'Test Instance' }, ...body }), () => true);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.sent()).toHaveLength(1));
    await r.settled();
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.sent()[0].deleteFields ?? []).toEqual([]);
  });

  it('more than 100 introduced keys: the first resend carries at most 100 deleteFields, the rest come back as a second refusal and a second confirm', async () => {
    const many = Array.from({ length: 130 }, (_v, i) => `k${String(i).padStart(3, '0')}`);
    const stored: Props = Object.fromEntries(many.map(k => [k, 'v']));
    const r = await run(kind, mode, stored, strictServer(many), () => true, many);
    await r.setType(b);
    r.save();
    await vi.waitFor(() => expect(r.confirm, 'a second confirm was never asked for the keys beyond the cap').toHaveBeenCalledTimes(2), { timeout: 8000 });
    await vi.waitFor(() => expect(r.sent().at(-1)?.deleteFields?.length ?? 0).toBeGreaterThan(0));

    const sent = r.sent();
    expect(sent.length, 'one update per refusal plus the last').toBeGreaterThanOrEqual(3);
    const resends = sent.slice(1);
    for (const body of resends) {
      expect(body.deleteFields!.length, 'a write may delete at most 100 fields').toBeLessThanOrEqual(100);
    }
    const asked = r.confirm.mock.calls.map(c => c[0].map((k: { key: string }) => k.key));
    expect(asked[1].length, 'the second confirm lists what the first resend did not remove').toBeLessThan(asked[0].length);
    const removed = new Set(resends.flatMap(b => b.deleteFields!.map(f => f.replace(/^properties\./, ''))));
    expect([...removed].sort(), 'every introduced key is removed by the end').toEqual(many);
    const last = sent.at(-1)!;
    expect(Object.keys(last.properties ?? {}).filter(k => many.includes(k)), 'the last write still carries a removed key').toEqual([]);
  });
});

/** The derived gate: nothing calls a brain update by itself. */
describe('every client source that updates a brain record goes through the retype helper', () => {
  const SOURCES = trackedAppSources().map(f => ({ file: f, text: stripComments(readFileSync(resolve(CLIENT_ROOT, f), 'utf8')) }));
  const API = 'src/app/core/brain-api.service.ts';
  const CALL = /\bupdate(Entity|Fact|Edge|Chrono)\b/;

  it('finds the four update methods in the API service (a floor, so an empty scan cannot pass)', () => {
    const api = SOURCES.find(s => s.file === API)!;
    expect(api, `${API} is not a tracked source`).toBeTruthy();
    const methods = [...api.text.matchAll(/\b(update(?:Entity|Fact|Edge|Chrono))\s*\(/g)].map(m => m[1]);
    expect(new Set(methods).size).toBeGreaterThanOrEqual(4);
  });

  it('every update method\'s body type declares deleteFields (updateChrono\'s did not)', () => {
    const api = SOURCES.find(s => s.file === API)!.text;
    const found: string[] = [];
    for (const m of api.matchAll(/\b(update(?:Entity|Fact|Edge|Chrono))\s*\(([^)]*)\)\s*:\s*Observable/g)) {
      found.push(m[1]);
      expect(m[2], `${m[1]}'s body type has no deleteFields, so a retype resend cannot carry it`).toContain('deleteFields');
    }
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('retype-flow.ts exists and exports saveWithRetype', () => {
    const flow = SOURCES.find(s => s.file === 'src/app/pages/brain/retype-flow.ts');
    expect(flow, 'src/app/pages/brain/retype-flow.ts is not a tracked source').toBeTruthy();
    expect(flow!.text).toMatch(/export\s+(?:async\s+)?(?:function|const)\s+saveWithRetype\b/);
  });

  it('retype-confirm.service.ts exports a root-provided RetypeConfirmService with confirm()', () => {
    const svc = SOURCES.find(s => s.file === 'src/app/core/retype-confirm.service.ts');
    expect(svc, 'src/app/core/retype-confirm.service.ts is not a tracked source').toBeTruthy();
    expect(svc!.text).toMatch(/providedIn:\s*'root'/);
    expect(svc!.text).toMatch(/export\s+class\s+RetypeConfirmService\b/);
    expect(svc!.text).toMatch(/\bconfirm\s*\(/);
  });

  it('every non-spec source that calls a brain update method references saveWithRetype or RetypeConfirmService', () => {
    const callers = SOURCES.filter(s => s.file !== API && CALL.test(s.text));
    expect(callers.length, 'no caller of a brain update method was found').toBeGreaterThanOrEqual(1);
    const bare = callers.filter(s => !/\bsaveWithRetype\b|\bRetypeConfirmService\b/.test(s.text)).map(s => s.file);
    expect(bare, 'these call a brain update directly and bypass the retype flow').toEqual([]);
  });
});
