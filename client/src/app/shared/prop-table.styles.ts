/**
 * The property-schema table: its rows, its expanded detail card, and the Required toggle.
 *
 * ## Why this is its own module
 *
 * Angular scopes component styles, so a component that RENDERS `.pdet-fields` and does not carry the rule
 * defining it gets browser defaults — silently, with no error anywhere. That has now happened twice to this
 * exact table:
 *
 *  - when `schema-type-editor` was extracted out of the schema tab it left `CHIP_STYLES` behind, and the enum
 *    remove button rendered as an oversized browser control (reported by the canary operator);
 *  - and it left THESE behind at the same time, which nobody noticed until the owner sent a screenshot on
 *    2026-08-15: the Required pill rendered as a raw checkbox with its label wrapped underneath, and the
 *    detail card lost its three-column grid AND its padding, so every field ran the full width of the dialog
 *    with its label jammed against the edge.
 *
 * Two copies already existed — `SPACE_DIALOG_STYLES` and `prop-schema-table.component.ts` each had their own,
 * character-identical. So the third consumer needing them was not a new problem: it was the same rules in a
 * third place, which is the point at which this repo extracts instead of pasting. One const, three importers,
 * and `prop-table-styles-reach-their-renderers.test.js` fails the build if a fourth renderer forgets it.
 *
 * ## What changed in the arrangement, and why
 *
 * The owner's report was *"functionality is good, just looks and arrangement sux"*, so restoring the lost
 * rules is most of it — but two of them were worth fixing rather than restoring:
 *
 *  - **The detail grid was three FIXED columns.** In a dialog this narrow that gives a select about 130px and
 *    then wraps the labels. `auto-fit` with a floor lets it be three columns when there is room and two when
 *    there is not, instead of three cramped ones always.
 *  - **The Required toggle showed a native checkbox** inside a pill that already says the same thing with
 *    colour and weight — two indicators of one state, and the native box is the one that cannot be styled to
 *    match anything around it. The input stays for keyboard and assistive tech and is visually hidden; the
 *    pill is the affordance. Focus is drawn on the pill through `:focus-within`, so tabbing to it is still
 *    visible.
 *
 * NO BACKTICKS anywhere in this file — it is one template string, and one backtick ends it.
 */
export const PROP_TABLE_STYLES = `
/* ── the table ── */
.prop-table { width:100%; border-collapse:collapse; font-size:13px; }
.prop-table th { text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); padding:5px 8px; border-bottom:1px solid var(--border); }
.prop-table td { padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:middle; }
/* ── property rows ── */
.prop-row { cursor:pointer; user-select:none; }
.prop-row:hover td { background:var(--bg-elevated); }
.prop-row.prow-open td { background:color-mix(in srgb,var(--accent) 6%,transparent); }
.prop-row.prow-open td:first-child { box-shadow:inset 2px 0 0 var(--accent); }
.prop-caret { color:var(--text-muted); flex-shrink:0; display:inline-flex; transition:color .15s; }
/* A property row's disclosure is a BUTTON, so a keyboard reaches it; it looks like the caret it replaced. */
.prop-toggle { background:none; border:none; padding:2px; cursor:pointer; }
.prop-toggle:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.prop-row:hover .prop-caret, .prop-row.prow-open .prop-caret { color:var(--accent); }
/* The name is the row identity, so it does not shrink when the constraint column is long. */
.prop-name { display:flex; align-items:center; gap:8px; min-width:0; }
.prop-name-key { font-family:var(--font-mono); font-size:12px; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; }
/* ── expanded detail card ── */
.prop-expand-row td { background:var(--bg-elevated); padding:0; }
.prop-expand-inner { padding:12px 16px; }
/* Inset on the left so the card reads as belonging to the row above rather than as a sibling of the table. */
.pdet { background:var(--bg-surface); border-top:2px solid color-mix(in srgb,var(--accent) 30%,transparent); box-shadow:inset 3px 0 0 color-mix(in srgb,var(--accent) 45%,transparent); }
/* auto-fit, not repeat(3,1fr): three fixed columns in a narrow dialog wrap every label. */
.pdet-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px 16px; padding:14px 16px; }
.pdet-fields .field { margin:0; min-width:0; }
.pdet-fields .field label, .pdet-full .field label { display:block; margin-bottom:4px; font-size:11px; font-weight:600; letter-spacing:.03em; color:var(--text-muted); }
.pdet-fields .field input, .pdet-fields .field select { width:100%; }
.pdet-full { padding:0 16px 14px; }
/* ── the Required toggle ── */
.req-toggle { display:inline-flex; align-items:center; gap:6px; font-size:11px; line-height:1; white-space:nowrap; cursor:pointer; color:var(--text-muted); background:none; border:1px solid var(--border); font-family:var(--font); padding:4px 9px; border-radius:999px; transition:all .15s; }
.req-toggle:hover { background:var(--bg-elevated); color:var(--text-primary); border-color:color-mix(in srgb,var(--accent) 40%,transparent); }
.req-toggle:focus-within { outline:2px solid var(--accent); outline-offset:1px; }
.req-toggle.is-req { color:var(--warning); border-color:color-mix(in srgb,var(--warning) 50%,transparent); background:color-mix(in srgb,var(--warning) 8%,transparent); font-weight:600; }
/* Visually hidden, not display:none — a removed input is not focusable and not announced. */
.req-toggle input { position:absolute; width:1px; height:1px; margin:-1px; padding:0; border:0; overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap; }
/* The dot IS the state, since the native box cannot be styled to match anything around it. */
.req-toggle::before { content:''; width:6px; height:6px; border-radius:50%; flex-shrink:0; border:1px solid currentColor; transition:background .15s; }
.req-toggle.is-req::before { background:currentColor; }
`;
