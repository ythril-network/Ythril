/**
 * A refused write is rendered so that it can be heard and acted on, in every record editor (bundle-23, R6-14, a11y + ux returns).
 *
 * What the editors did: `fmtApiError` flattened a refusal into one English line ("Schema violation - field: reason; ..."),
 * and the tabs and the drawer put it in a plain `<div>`. A screen reader is not told it appeared, the property that caused
 * it is not marked, a record's twentieth row is silently missing, and a rule shows as its internal name (`rules.minAge`) and
 * not the message its author wrote. The server now answers a structured body (`introduced`, `preExisting`, `declared`,
 * `truncated`, rule `outcome`), and `describeRefusal` (core/refusal-text.ts) turns it into words and rows. THIS spec holds
 * what the editors DO with that: it does not test the formatter's own sentences (its owner does), it tests that
 *   - the refusal is an element with `role="alert"`, in the create form's error, the inline-edit error and the drawer error;
 *   - a refused `properties.<key>` row marks that property's value input `aria-invalid="true"` and points
 *     `aria-describedby` at an element carrying the row's text;
 *   - a truncated list says how many rows were left out, an undeclared-key row lists the declared keys, and a rule row says
 *     the rule's MESSAGE and never the raw `rules.<name>` field (checked against the shipped English words);
 *   - a pre-existing row is shown as pre-existing, marks nothing invalid and does not block another save.
 *
 * The editors are the table in `testing/brain-editors-harness.ts` (four tabs x create/inline edit, and the drawer for four
 * kinds). Red on the unchanged base: the errors are `<div>`s, no input is marked, and the formatter flattens the body.
 */
import { describe, it, expect } from 'vitest';
import { locale } from '../../testing/files-page-harness';
import {
  TAB_EDITORS, DRAWER_EDITORS, uncoveredEditors, mountTab, mountDrawer, settle, propertyValueInput, describedByText, refusalBody,
  type TabEditor, type DrawerEditor, type WireRow, type MountedTab, type MountedDrawer,
} from '../../testing/brain-editors-harness';

const EN = locale('en');

/** One editor surface and how to drive it: mount it holding `properties`, then refuse its next save. */
interface Surface {
  name: string;
  start(properties: Record<string, string | number | boolean>): Promise<void>;
  /** Queue a refusal as the next answer and submit; ends settled. */
  refuse(body: unknown, status?: number): Promise<void>;
  /** Submit once more and say how many times the write has reached the API in all. */
  submitAgain(): number;
  host(): HTMLElement;
  saveButton(): HTMLButtonElement | null;
}

function tabSurface(ed: TabEditor, via: 'create' | 'edit'): Surface {
  let m: MountedTab;
  const call = via === 'create' ? ed.createApi : ed.updateApi;
  const submit = (): void => (via === 'create' ? ed.submitCreate(m.c) : ed.submitEdit(m.c, 'r1'));
  return {
    name: `${ed.kind} tab, ${via === 'create' ? 'create form' : 'inline edit'}`,
    async start(properties) {
      m = mountTab(ed, EN);
      if (via === 'create') ed.openCreate(m.c, properties);
      else {
        const rec = ed.record();
        m.c.store[ed.storeList].set([rec]);
        ed.openEdit(m.c, rec, properties);
      }
      await settle(m.fixture);
    },
    async refuse(body, status) {
      if (via === 'create') m.failCreate(status ?? 400, body); else m.failUpdate(status ?? 422, body);
      submit();
      await settle(m.fixture);
    },
    submitAgain() { submit(); return m.api[call].mock.calls.length; },
    host: () => m.host,
    saveButton: () => m.host.querySelector<HTMLButtonElement>(via === 'create' ? 'form.create-form button[type="submit"]' : 'table .btn-primary'),
  };
}

function drawerSurface(ed: DrawerEditor): Surface {
  let m: MountedDrawer;
  return {
    name: `record drawer (${ed.kind})`,
    async start(properties) {
      m = mountDrawer(ed, EN);
      m.state.open(ed.kind as never, ed.record() as never);
      (m.state as unknown as Record<string, { properties: unknown }>)[ed.editModel].properties = { ...properties };
      await settle(m.fixture);
    },
    async refuse(body, status) {
      m.failUpdate(status ?? 422, body);
      m.state.save();
      await settle(m.fixture);
    },
    submitAgain() { m.state.save(); return m.api[ed.updateApi].mock.calls.length; },
    host: () => m.host,
    saveButton: () => m.host.querySelector<HTMLButtonElement>('.drawer .btn-primary'),
  };
}

const SURFACES: Surface[] = [
  ...TAB_EDITORS.flatMap(ed => [tabSurface(ed, 'create'), tabSurface(ed, 'edit')]),
  ...DRAWER_EDITORS.map(drawerSurface),
];

/** Everything the editor shows as refusal text: its alerts, plus whatever its inputs say describes them. */
function refusalSurface(host: HTMLElement): string {
  const alerts = Array.from(host.querySelectorAll('[role="alert"]')).map(a => a.textContent ?? '');
  const described = Array.from(host.querySelectorAll('[aria-describedby]')).map(i => describedByText(host, i as HTMLElement) ?? '');
  return [...alerts, ...described].join('\n');
}
const alertText = (host: HTMLElement): string => Array.from(host.querySelectorAll('[role="alert"]')).map(a => a.textContent ?? '').join('\n');
const invalid = (host: HTMLElement, key: string): string | null => propertyValueInput(host, key)?.getAttribute('aria-invalid') ?? null;

const SIZE_ROW: WireRow = { field: 'properties.size', value: 'x', reason: 'must be a number', outcome: 'violated' };

describe('the surface table covers every record editor the source has', () => {
  it('finds nothing uncovered', () => { expect(uncoveredEditors()).toEqual([]); });
});

describe.each(SURFACES.map(s => [s.name, s] as const))('a refusal in the %s', (_name, s) => {
  it('is an element with role=alert, whatever the body (a plain refusal)', async () => {
    await s.start({});
    await s.refuse({ error: 'The store is not answering.' }, 500);
    const alerts = Array.from(s.host().querySelectorAll('[role="alert"]'));
    expect(alerts.length, 'the refusal is shown in a plain element: a screen reader is not told it appeared').toBeGreaterThan(0);
    expect(alertText(s.host())).toContain('The store is not answering.');
  });

  it('is an element with role=alert for a structured schema refusal, and never shows the raw code', async () => {
    await s.start({ size: 'x' });
    await s.refuse(refusalBody({ message: 'The write was refused.', introduced: [SIZE_ROW] }));
    expect(s.host().querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
    expect(alertText(s.host())).toMatch(/size/);
    expect(alertText(s.host()), 'the machine code is shown to the operator').not.toMatch(/schema_violation/);
  });

  it('marks the refused property value input aria-invalid and describes it with the row text', async () => {
    await s.start({ size: 'x', other: 'fine' });
    expect(propertyValueInput(s.host(), 'size'), 'precondition: the editor shows the property row').not.toBeNull();
    await s.refuse(refusalBody({ introduced: [SIZE_ROW] }));
    const input = propertyValueInput(s.host(), 'size');
    expect(input, 'the refused row disappeared from the editor').not.toBeNull();
    expect(input!.getAttribute('aria-invalid')).toBe('true');
    const described = describedByText(s.host(), input!);
    expect(described, 'aria-describedby must name an element that exists and has text').not.toBeNull();
    expect(described!).toMatch(/size/);
    expect(invalid(s.host(), 'other'), 'a property the refusal did not name is marked invalid').not.toBe('true');
  });

  it('marks an undeclared key and lists the declared keys the type does declare', async () => {
    await s.start({ colour: 'red' });
    await s.refuse(refusalBody({
      introduced: [{ field: 'properties.colour', value: 'red', reason: 'not declared', declared: ['size', 'weight'], outcome: 'violated' }],
    }));
    expect(invalid(s.host(), 'colour')).toBe('true');
    const surface = refusalSurface(s.host());
    expect(surface).toMatch(/colour/);
    expect(surface, 'the declared keys the writer could have used are not listed').toMatch(/size/);
    expect(surface).toMatch(/weight/);
  });

  it('says how many rows a truncated refusal left out', async () => {
    await s.start({ size: 'x' });
    await s.refuse(refusalBody({ introduced: [SIZE_ROW, { field: 'properties.weight', reason: 'must be a number' }], truncated: 37 }));
    expect(alertText(s.host()), 'the 37 omitted rows are not counted: the operator sees a short list as a complete one').toMatch(/\b37\b/);
  });

  it('shows a rule by its message, never by its raw rules.<name> field, and says when a rule could not be checked', async () => {
    await s.start({});
    await s.refuse(refusalBody({
      introduced: [
        { field: 'rules.minAge', reason: 'Age must be at least 18', outcome: 'violated' },
        { field: 'rules.byEmail', reason: 'no_such_overload', outcome: 'could_not_evaluate' },
        { field: 'meta.rules.noSecrets', reason: 'too_large', outcome: 'too_large' },
      ],
    }));
    const text = alertText(s.host());
    expect(text, 'the rule\'s own message is not shown').toContain('Age must be at least 18');
    for (const raw of ['rules.minAge', 'rules.byEmail', 'rules.noSecrets']) {
      expect(text, `the raw field ${raw} is shown in place of the rule's message`).not.toContain(raw);
    }
    expect(text, 'a rule that could not be evaluated is not said to be so').toMatch(/could not|couldn't|cannot|unable|not (?:be )?(?:evaluated|checked)/i);
    expect(text, 'a rule whose input was too large is not said to be so').toMatch(/too (?:large|big|long)|exceed|limit/i);
  });

  it('shows a pre-existing row as pre-existing, marks nothing for it, and does not block another save', async () => {
    await s.start({ size: 'x', legacy: 'y' });
    await s.refuse(refusalBody({
      introduced: [SIZE_ROW],
      preExisting: [{ field: 'properties.legacy', value: 'y', reason: 'must be a number', outcome: 'violated' }],
    }));
    expect(invalid(s.host(), 'size')).toBe('true');
    expect(invalid(s.host(), 'legacy'), 'a break the record already had before this write is marked as if this write caused it').not.toBe('true');
    expect(refusalSurface(s.host()), 'the pre-existing row is not said to be pre-existing').toMatch(/already|pre-?existing|existing/i);
    expect(s.saveButton(), 'the save button is gone after a refusal').not.toBeNull();
    expect(s.saveButton()!.disabled, 'a refusal must leave the editor usable').toBe(false);
  });

  it('treats a body with only pre-existing rows as no reason to mark or block anything', async () => {
    await s.start({ legacy: 'y' });
    await s.refuse(refusalBody({
      introduced: [],
      preExisting: [{ field: 'properties.legacy', value: 'y', reason: 'must be a number', outcome: 'violated' }],
    }));
    expect(invalid(s.host(), 'legacy')).not.toBe('true');
    expect(refusalSurface(s.host())).toMatch(/already|pre-?existing|existing/i);
    expect(s.saveButton()!.disabled).toBe(false);
    const before = s.submitAgain();
    expect(before, 'the editor refused to submit again after a pre-existing-only answer').toBeGreaterThanOrEqual(2);
  });
});
