/**
 * A component that renders "there is nothing here" must also be able to render "we could not find out".
 *
 * The bug this gate freezes: eight surfaces wrote `error: () => this.loading.set(false)`, so a failed
 * request cleared the spinner and fell straight through to the empty state. `/files/conflicts` was the
 * sharpest — a 500 from the server produced a green check-circle and "No conflicts", which is not merely
 * unhelpful but actively wrong. `/brain` was the widest: a user with a full brain was told to create their
 * first space. The file manager rendered no message at all, which reads as a broken page.
 *
 * Why a gate and not just the fix: the empty state is the *easy* branch. Every one of those was written by
 * someone who handled the empty case carefully and then had nowhere to put a failure, and nothing in the
 * build objected. The next list added to this app will have the same shape.
 *
 * **The check is per-branch-chain, not per-file.** The first version of this gate asked "does this file
 * mention an error state?" and a mutation that changed the guard to `@else if (false)` survived it — the
 * element and its bindings stayed in the file while the branch went dead, and an unrelated dialog's
 * `createError()` kept the file looking compliant. So the template's `@if / @else if / @else` chains are
 * parsed, and the chain that renders an empty state is the one that has to carry a failure branch.
 *
 * Scope comes from what the templates actually render, NOT from a list of components someone remembered —
 * a checker built from the code it audits inherits that code's omissions. Comments are stripped before
 * matching, because the comments explaining these fixes quote the very markers below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLIENT_ROOT as CLIENT, trackedAppSources } from './tracked-sources';
import { stripComments } from './strip-comments';

/**
 * Components that render an empty state but are allowed not to distinguish a failure.
 *
 * Each entry is asserted below to still be a real file that still has an empty state and still has no
 * failure branch — so a component that gets fixed cannot quietly linger here, and a renamed path fails
 * loudly instead of silently exempting nothing. That assertion already earned its keep: it evicted
 * `space-duplicates-tab`, added here on the reasoning that its `@empty` covers local form state, while the
 * file had a `state.dupeError()` branch all along and needed no exemption.
 */
const EXEMPT: Record<string, string> = {
  'src/app/pages/settings/schema-type-editor.component.ts':
    'Presentational: it edits a draft handed to it and resolves nothing itself, so it has no request that ' +
    'could fail. Its two empty states are a linked library entry that declares no properties — resolved by ' +
    'the HOST and passed in as `linkedProps` — and a type that has no properties yet, which is local form ' +
    'state the operator is in the middle of filling in. The fetch that can actually fail is the schema ' +
    "tab's library picker, which has its own failure branch (asserted separately below).",
  'src/app/pages/settings/token-table.component.ts':
    'Presentational: it receives its rows as an input and makes no request of its own. It cannot be rendered ' +
    'on a failed load at all — the Tokens page chain is `@if (loading()) … @else if (loadError() !== null) ' +
    '{ <app-error-state/> } @else { <app-token-table/> }`, so a 500 reaches the error branch and this ' +
    'component is never created. Its two empty states are "you have no tokens yet" and "the search matched ' +
    'nothing", and the second exists BECAUSE the distinction matters: an operator who filters to nothing must ' +
    'not be told their tokens are gone.',
  'src/app/pages/graph/graph-linked-records.component.ts':
    'Presentational: it receives its rows as an input and makes no request of its own, so it has no failure to distinguish. ' +
    'The panel that DOES fetch (graph.component) has the error state.',
  'src/app/pages/settings/space-duplicates-tab.component.ts':
    "Its @empty covers the duplicate-rule list inside the settings form — local, unsaved state that is never " +
    'fetched, so there is no request to fail. (The file does have a `state.dupeError()` branch, but that is the ' +
    'SAVE error and does not guard this list, which is why the chain-level check still reports it.)',
  'src/app/pages/settings/webhooks.component.ts':
    "Its unguarded @empty is the \"no spaces selected\" label inside the webhook form's own space picker — it " +
    'reflects a checkbox the user just cleared, not a load. The webhook LIST above it has its own error branch.',
  'src/app/pages/settings/space-schema-tab.component.ts':
    "The type lists render the space's own schema, which arrives with the space that the parent route already " +
    'loaded — there is no request here to fail. The one list this component does fetch, the library picker, ' +
    'has its own failure branch (asserted separately below).',
};

/**
 * Anything that renders a "nothing here" state — matched as a class ATTRIBUTE, not a bare class name.
 * A bare name also matches the `.empty-state-inner { … }` rule in the component's own `styles`, and those
 * false positives are in the styles array, outside every `@if` chain, so they always read as unguarded.
 */
const EMPTY_MARKERS = /class="[^"]*\b(?:empty-state|empty-state-inner|sch-empty-list)\b/g;

/** A condition derived from something error-shaped. `false` and `x().length === 0` deliberately do not match. */
const IS_FAILURE_COND = (cond: string): boolean => /(^|[^\w])[\w.$]*(error|fail)/i.test(cond);


interface Block {
  /** `if` | `else if` | `else` | `for` | `empty` */
  kind: string;
  /** The parenthesised condition, empty for `@else` / `@empty`. */
  cond: string;
  /** Index of the `@`. */
  at: number;
  /** Index of the opening `{` and its matching `}`. */
  open: number;
  close: number;
}

function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Angular control-flow blocks, in source order. */
function parseBlocks(code: string): Block[] {
  const out: Block[] = [];
  const RE = /@(if|else\s+if|else|for|empty)\b/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let cond = '';
    // Walk to the `{` that opens the body, capturing the top-level parenthesised condition on the way.
    while (i < code.length) {
      const c = code[i];
      if (c === '(') { depth++; i++; if (depth === 1) cond = ''; continue; }
      if (c === ')') { depth--; i++; continue; }
      if (c === '{' && depth === 0) break;
      if (c === ';' && depth === 0) break; // malformed — bail rather than run away
      if (depth > 0) cond += c;
      i++;
    }
    if (code[i] !== '{') continue;
    const close = matchBrace(code, i);
    if (close < 0) continue;
    out.push({ kind: m[1].replace(/\s+/g, ' '), cond: cond.trim(), at: m.index, open: i, close });
  }
  return out;
}

/**
 * Group blocks into `@if / @else if / @else` chains. A chain's conditions are what a reader sees as the
 * mutually-exclusive states of one region, which is exactly the unit this gate cares about.
 */
function chains(code: string, blocks: Block[]): { conds: string[]; from: number; to: number }[] {
  const continuation = new Set<Block>();
  const next = (b: Block): Block | undefined =>
    blocks.find(x => x.at > b.close && code.slice(b.close + 1, x.at).trim() === '' && x.kind.startsWith('else'));

  for (const b of blocks) {
    const n = next(b);
    if (n) continuation.add(n);
  }

  const out: { conds: string[]; from: number; to: number }[] = [];
  for (const b of blocks) {
    if (b.kind !== 'if' || continuation.has(b)) continue;
    const conds = [b.cond];
    let cur = b;
    for (let n = next(cur); n; n = next(cur)) {
      conds.push(n.cond);
      cur = n;
    }
    out.push({ conds, from: b.at, to: cur.close });
  }
  return out;
}

interface Surface {
  path: string;
  /** One entry per empty state rendered, with the failure conditions available to guard it. */
  empties: { index: number; guardedBy: string[] }[];
  hasEmpty: boolean;
  hasError: boolean;
}

function analyse(path: string): Surface {
  const code = stripComments(readFileSync(resolve(CLIENT, path), 'utf8'));
  const blocks = parseBlocks(code);
  const cs = chains(code, blocks);

  /** Each empty state, with the block that IS it when the source says so (`@empty`) rather than merely holds it. */
  const positions: { index: number; own?: Block }[] = [];
  EMPTY_MARKERS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMPTY_MARKERS.exec(code))) positions.push({ index: m.index });
  // `@empty` blocks are the `@for` form of the same thing.
  for (const b of blocks) if (b.kind === 'empty') positions.push({ index: b.open, own: b });

  /** The block that most tightly contains an index, so a guard is attributed to the right region. */
  const innermost = (index: number): Block | undefined =>
    blocks.filter(b => b.open < index && index < b.close).sort((a, b) => b.open - a.open)[0];

  const empties = positions.map(({ index, own: ownBlock }) => {
    // Two shapes both count as guarded:
    //  1. a sibling branch in an enclosing chain — `@if (loading()) … @else if (loadError()) … @else if (empty)`.
    //     An OUTER chain counts too: if an outer branch catches the failure, the inner empty is unreachable.
    const siblings = cs
      .filter(c => c.from <= index && index <= c.to)
      .flatMap(c => c.conds)
      .filter(IS_FAILURE_COND);
    //  2. a failure branch INSIDE the empty region — which is how the four brain record tabs do it, with the
    //     error state nested in the `@empty` block of the table's `@for`. Different shape, same guarantee.
    const own = ownBlock ?? innermost(index);
    const inside = own
      ? [...code.slice(own.open, own.close).matchAll(/@(?:else\s+)?if\s*\(([^)]*\))/g)]
          .map(m => m[1])
          .filter(IS_FAILURE_COND)
      : [];
    return { index, guardedBy: [...siblings, ...inside] };
  });

  return {
    path,
    empties,
    hasEmpty: empties.length > 0,
    hasError: empties.every(e => e.guardedBy.length > 0),
  };
}

function surfaces(): Surface[] {
  return trackedAppSources()
    .filter(p => p.endsWith('.component.ts'))
    .map(analyse);
}

describe('a failed load must not read as an empty list', () => {
  const all = surfaces();
  const withEmpty = all.filter(s => s.hasEmpty);

  it('found the components and parsed their templates (guards against a vacuous pass)', () => {
    // If the glob, the cwd, the comment stripper or the block parser breaks, every assertion below passes
    // by measuring nothing.
    expect(all.length).toBeGreaterThan(50);
    expect(withEmpty.length).toBeGreaterThanOrEqual(15);
    // And the parser must actually be finding guards, not returning empty lists everywhere.
    expect(withEmpty.filter(s => s.empties.some(e => e.guardedBy.length > 0)).length).toBeGreaterThanOrEqual(8);
  });

  it('the empty-state marker reads class attributes, not CSS declarations', () => {
    // Pinned directly rather than left to a side effect: the bare-name version of this pattern matched
    // `.empty-state-inner { … }` inside a component's own `styles` array, and a match there sits outside
    // every @if chain — so four fully-compliant components were reported as unguarded.
    const re = () => new RegExp(EMPTY_MARKERS.source);
    expect('<div class="empty-state">').toMatch(re());
    expect('<div class="empty-state" style="padding:24px;">').toMatch(re());
    expect('.empty-state-inner { padding: 8px 0; }').not.toMatch(re());
    expect('.sch-empty-list { color: var(--text-muted); }').not.toMatch(re());
  });

  it('every empty state sits in a branch chain that can also render a failure', () => {
    const gaps = withEmpty
      .filter(s => !s.hasError && !(s.path in EXEMPT))
      .map(s => `${s.path} (${s.empties.filter(e => !e.guardedBy.length).length} unguarded)`);
    expect(
      gaps,
      `These render "nothing here" with no failure branch in the same @if chain, so a 500 shows the empty state:\n` +
        gaps.map(p => `  - ${p}`).join('\n') +
        `\n\nAdd an error branch before the empty one (see ErrorStateComponent and httpErrorReason), ` +
        `or add the file to EXEMPT with the reason it cannot fail.`,
    ).toEqual([]);
  });

  it('no exemption outlives its reason', () => {
    const byPath = new Map(all.map(s => [s.path, s]));
    for (const [path, reason] of Object.entries(EXEMPT)) {
      const s = byPath.get(path);
      expect(s, `EXEMPT lists ${path}, which is not a tracked component — renamed or deleted?`).toBeDefined();
      expect(s!.hasEmpty, `EXEMPT lists ${path} but it no longer renders an empty state; drop the entry.`).toBe(true);
      expect(
        s!.hasError,
        `${path} now guards every empty state, so its exemption is stale — delete the entry. Reason given: ${reason}`,
      ).toBe(false);
      expect(reason.length, `EXEMPT ${path} needs a real reason, not a placeholder.`).toBeGreaterThan(40);
    }
  });

  it('the surfaces fixed in this change keep a failure branch', () => {
    // Named rather than counted: a count survives one of them regressing while another is added.
    const fixed = [
      'src/app/pages/brain/brain.component.ts',
      'src/app/pages/brain/review-tab.component.ts',
      'src/app/pages/files/conflicts.component.ts',
      'src/app/pages/files/file-manager.component.ts',
      'src/app/pages/schema-library/schema-library.component.ts',
      'src/app/pages/settings/networks.component.ts',
      'src/app/pages/settings/tokens.component.ts',
    ];
    const byPath = new Map(all.map(s => [s.path, s]));
    for (const path of fixed) {
      const s = byPath.get(path);
      expect(s, `${path} is gone — if it was renamed, update this list.`).toBeDefined();
      const unguarded = s!.empties.filter(e => !e.guardedBy.length).length;
      expect(unguarded, `${path} has ${unguarded} empty state(s) with no failure branch in the same chain.`).toBe(0);
    }
  });

  it("the schema tab's library picker guards its own fetch", () => {
    // space-schema-tab is EXEMPT for its type lists (space meta, loaded by the parent) but it does fetch the
    // library, and that list had the bug. Asserted by name so the exemption cannot cover the real load.
    const code = stripComments(
      readFileSync(resolve(CLIENT, 'src/app/pages/settings/space-schema-tab.component.ts'), 'utf8'),
    );
    expect(code).toMatch(/@else if \(libPickerError\(\) !== null\)/);
    expect(code).toMatch(/libPickerError\.set\(httpErrorReason\(err\)\)/);
  });

  it('no list load swallows its error into a bare loading reset', () => {
    // The exact shape of the original bug: an error handler whose only job is to stop the spinner.
    const offenders: string[] = [];
    const SWALLOW = /error:\s*\(\s*\)\s*=>\s*(?:\{\s*)?this\.\w*[Ll]oading\w*\.set\(false\)\s*;?\s*\}?\s*,/;
    for (const s of withEmpty) {
      const code = stripComments(readFileSync(resolve(CLIENT, s.path), 'utf8'));
      if (SWALLOW.test(code)) offenders.push(s.path);
    }
    expect(
      offenders,
      `An error handler that only clears the spinner leaves the template with nothing to branch on:\n` +
        offenders.map(p => `  - ${p}`).join('\n'),
    ).toEqual([]);
  });
});
