# UI primitives

The shared Angular components every settings and list page is built from. Written down because they were
discoverable only by reading another page that happened to use them — so a page PR could plausibly
re-roll a badge, a timestamp format or a usage bar without ever learning one existed. Each of these
replaced two or three divergent implementations; re-rolling one puts a fourth dialect back.

All live in `client/src/app/shared/` (except `ConfirmDialogService`, in `client/src/app/core/`), are
standalone, and are `OnPush`. Import the component class directly into your component's `imports`.

**Use these before writing new markup.** If a primitive is *almost* right, extend the primitive — a
variant on `StatusPill` serves every page; a bespoke badge on one page serves one page and becomes the
next thing someone has to reconcile.

---

## `<app-settings-card>` — the grouping block

The standard container for a settings section: icon + heading + one-line purpose, an optional status pill
in the header, and your content in the body. Replaces ad-hoc `.section` blocks and inline-styled `div`s.

```html
<app-settings-card icon="image" heading="Vision" purpose="Captions uploaded images.">
  <app-status-pill pill variant="active">Local · Ollama</app-status-pill>
  <!-- body content -->
</app-settings-card>
```

| Input | Type | Notes |
|---|---|---|
| `heading` | `string` | **required** |
| `icon` | `string` | a registered `ph-icon` name |
| `purpose` | `string` | one line, sentence case — what the section is *for*, not what the controls do |

Content projected with the `pill` attribute lands in the header; everything else lands in the body.

---

## `<app-status-pill>` — the one status vocabulary

Every "what state is this in?" signal. Before it there were three badge dialects
(`badge-red/green/gray`, `badge-active/failing`, `badge-2xx/4xx`), so the same state looked different on
three screens.

```html
<app-status-pill variant="warn" [dot]="true">Expiring</app-status-pill>
<app-status-pill variant="error" icon="warning">Failing</app-status-pill>
```

| Input | Type | Default |
|---|---|---|
| `variant` | `'active' \| 'ok' \| 'warn' \| 'error' \| 'off' \| 'env' \| 'pending'` | `'off'` |
| `icon` | `string` | `''` |
| `dot` | `boolean` | `false` |

`env` is for "pinned by an infrastructure env var" — a state, not a severity. Reach for it instead of
greying out a control with no explanation.

---

## `<app-summary-strip>` — the answer above the fold

The operator-first row at the top of a list or settings page: the headline counts, with the ones that
need attention coloured. **Every list page gets one.** It is the difference between a page that answers
"is anything wrong here?" at a glance and one that makes you read a table.

```html
<app-summary-strip
  heading="Tokens"
  [items]="[{ label: 'Active', value: 4 }, { label: 'Expiring', value: 1, variant: 'warn' }]" />
```

| Input | Type | Default |
|---|---|---|
| `heading` | `string` | `''` |
| `items` | `SummaryItem[]` | `[]` |

```ts
interface SummaryItem { label: string; value: string | number; variant?: StatusVariant }
```

Content projected after the items renders inside the strip — that is where a `<app-usage-bar>` goes.

---

## `<app-relative-time>` — the one timestamp treatment

Renders a locale-aware relative label ("2 hours ago") with the absolute time on hover, `tabular-nums`,
and a machine-readable `<time datetime>`. **Every timestamp in the app goes through it.**

```html
<app-relative-time [value]="token.lastUsed" />
```

`value` is required and accepts a `Date`, an ISO string, or epoch milliseconds.

The formatting function is exported and pure — pass `nowMs` (and optionally a locale) to test it
deterministically rather than mocking the clock.

---

## `<app-usage-bar>` — "X of Y used"

One bar with health thresholds; colour tracks the fill (`ok` → `warn` at `warnAtPercent` → `danger` at
95%). Consolidated storage's `usage-bar-*` and about's `disk-bar-*`, which drew the same concept two ways.

```html
<app-usage-bar [used]="usedGiB" [total]="limitGiB" [warnAtPercent]="80" />
```

| Input | Type | Default |
|---|---|---|
| `used` | `number` | **required** |
| `total` | `number \| null` | `null` — renders as "unlimited", not as a full bar |
| `warnAtPercent` | `number` | `80` |

---

## `ConfirmDialogService` — never `window.confirm`

Themed, CDK-backed, and awaitable. Native `confirm()` is unstyled, untranslatable and blocks the event
loop.

```ts
private readonly confirmDialog = inject(ConfirmDialogService);

if (await this.confirmDialog.confirm({ title, message, danger: true })) { /* … */ }
```

| Field | Notes |
|---|---|
| `title`, `message` | required; **already localised by the caller** |
| `confirmLabel`, `cancelLabel` | default to `common.confirm` / `common.cancel` |
| `danger` | styles the confirm button red — use it for every destructive action |
| `requireText` | disables confirm until the user types this exact string. Use for irreversible actions (the type-the-id ritual) |
| `requireTextLabel` | the label above that input, e.g. "Type the space id" |

Cancel is the default action; Confirm is the one that has to be chosen.

---

## `<ph-icon>` — icons

Inline SVG from Phosphor Icons (regular weight), embedded at build time — no runtime fetches.

```html
<ph-icon name="trash" [size]="18" />
```

⚠️ **An unregistered name renders blank with no error.** Add the path to the `ICONS` map in
`ph-icon.component.ts` when you use a new one. `npm run preflight` fails on an unregistered name — it
has bitten this codebase twice, both times invisibly.

---

## `plural` pipe and `PluralText` — a count beside a word

A number next to a word ("3 edges", "2 Kanten", "5 rekordów") is one sentence, in the plural form the reader's
language uses for that number. English has two forms; Polish has four. **Every count shown beside a word goes
through one of these two.**

```html
<span>{{ total | plural:'brain.spaceChip.records' }}</span>
```

```ts
private readonly plural = inject(PluralText);

this.plural.text('brain.cascade.kind.edge', n);
```

The base names a key family, one key per form: `.one` and `.other` in `en`, `.one`, `.few`, `.many` and `.other`
in `pl`. Each sentence carries its own `{{count}}`. The client unit tests check every locale for every form.

Both read the page's language from `ActiveLanguage`. During a switch it keeps the old language until the new
words have loaded, so a count and its word never come from two languages. For the same reason, a list joined
for a sentence (`formatList`) takes `ActiveLanguage.language()`, never `transloco.getActiveLang()`. Neither is
ever bound as HTML.

---

## Checklist for a page PR

Not primitives, but the same class of thing — verify these on whatever page you touch:

- `<app-relative-time>` on every timestamp; `tabular-nums` on every numeric column.
- Every user-facing string through transloco. No hardcoded English — `en`, `de` and `pl` all need the
  key, and the client unit tests check coverage.
- A count beside a word through the `plural` pipe or `PluralText`, never `{{ n }} {{ 'key' | transloco }}`.
- `<ph-icon>` rather than a raw glyph.
- A `<app-summary-strip>` on every list page.
- A visible in-flight state on every async action.
- An unsaved-changes guard on every editable form.
- Destructive actions: `danger` on the button *and* on the confirm dialog.
