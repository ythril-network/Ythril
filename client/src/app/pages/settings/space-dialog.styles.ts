/**
 * Styles shared by the spaces page and its dialog/tab child components (A17.8b).
 *
 * Angular scopes component styles, so a child that renders the chip inputs or the sp-* dialog
 * chrome needs these rules in its OWN metadata. Rather than paste ~90 lines into each of the six
 * components — five copies free to drift apart — they share this one const. The repo styles
 * components inline (there is no styleUrls anywhere), so this stays DRY without breaking that
 * convention. Angular AOT statically resolves an imported const, so `styles: [SPACE_DIALOG_STYLES]`
 * compiles; if it ever could not, the build would fail loudly rather than drop the styles.
 */
import { CHIP_STYLES } from '../../shared/chip.styles';
import { PROP_TABLE_STYLES } from '../../shared/prop-table.styles';
import { STACK } from '../../shared/stacking';

export const SPACE_DIALOG_STYLES = `
${CHIP_STYLES}
${PROP_TABLE_STYLES}
/* storage bar */
.st-bar { height:6px; border-radius:3px; background:var(--border); overflow:hidden; }
.st-bar-fill { height:100%; border-radius:3px; transition:width .3s; }
.st-bar-fill.ok     { background:var(--success); }
.st-bar-fill.warn   { background:var(--warning); }
.st-bar-fill.danger { background:var(--danger); }
/* drag handle */
.drag-handle { cursor:grab; color:var(--text-muted); padding:0 4px; user-select:none; font-size:16px; line-height:1; }
.drag-handle:hover { color:var(--text-primary); }
.drag-handle-disabled { cursor:default; opacity:0.3; }
.drag-handle-disabled:hover { color:var(--text-muted); }
.cdk-drag-preview { background:var(--bg-primary); border:1px solid var(--accent); border-radius:var(--radius-sm); box-shadow:var(--shadow-lg); opacity:0.95; }
.cdk-drag-placeholder { opacity:0.3; }
.cdk-drag-animating { transition:transform 250ms cubic-bezier(0,0,0.2,1); }
/* sort buttons */
.sort-group { display:flex; gap:2px; border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; }
.sort-btn { background:none; border:none; padding:3px 8px; font-size:12px; cursor:pointer; color:var(--text-muted); font-family:var(--font); transition:background .15s,color .15s; white-space:nowrap; }
.sort-btn:hover { background:var(--bg-surface); color:var(--text-primary); }
.sort-btn.active { background:var(--accent-dim); color:var(--accent); font-weight:600; }
/* search input */
/* Only what the global input rule does not decide. This used to set its own height (28px), its own padding, and --
   the real defect -- background:var(--bg-surface), which made it the one input in the product sitting on a different
   surface token from every other. */
.space-search-input { min-width:160px; }
/* create dialog */
.dialog-backdrop { position:fixed; inset:0; background:var(--bg-scrim); display:flex; align-items:center; justify-content:center; z-index:${STACK.dialog}; }
.dialog { background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); padding:24px; width:90%; max-width:960px; max-height:90vh; overflow-y:auto; }
.dialog-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
/* settings popup */
.sp-backdrop { position:fixed; inset:0; background:var(--bg-scrim); z-index:${STACK.popup}; display:flex; align-items:center; justify-content:center; }
.sp-panel { width:92vw; height:92vh; max-width:1200px; background:var(--bg-primary); border:1px solid var(--border); border-radius:var(--radius-lg); display:flex; flex-direction:column; overflow:hidden; }
.sp-header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--border); flex-shrink:0; }
/* Wraps rather than clips: Danger Zone is the last tab and was the first to vanish in a narrow dialog,
   which is a poor thing to make unreachable. Wrapping over a scroller for the same reason as the global
   .tabs — a scrolled strip looks exactly like a clipped one, so nothing signals the missing tabs. */
.sp-tabs { display:flex; flex-wrap:wrap; border-bottom:1px solid var(--border); flex-shrink:0;
  background:var(--bg-surface); }
.sp-tabs > .sp-tab { flex:none; white-space:nowrap; }
.sp-tab { background:none; border:none; border-bottom:2px solid transparent; padding:10px 20px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); transition:color .15s; }
.sp-tab:hover { color:var(--text-primary); }
.sp-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:500; }
.sp-tab.danger-tab.active { color:var(--danger); border-bottom-color:var(--danger); }
.sp-body { flex:1; overflow-y:auto; padding:24px; }
.sp-footer { display:flex; align-items:center; gap:8px; padding:12px 20px; border-top:1px solid var(--border); flex-shrink:0; }
/* schema */
.sch-section { margin-bottom:28px; }
.sch-section-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--text-muted); margin-bottom:12px; padding-bottom:6px; border-bottom:1px solid var(--border); }
.sch-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.sch-grid-3 { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
/* danger zone */
.dz-section { border:1px solid var(--border); border-radius:var(--radius-md); padding:16px; margin-bottom:16px; }
.dz-section.dz-red { border-color:var(--danger); }
.dz-section-title { font-weight:600; margin-bottom:6px; font-size:14px; }
.dz-section.dz-red .dz-section-title { color:var(--danger); }
/* A secondary note inside a danger-zone section — for a pointer to a control that lives elsewhere, which must
   NOT get a heading: a heading promises a control, and a reader who finds none cannot tell what the block is
   for (reported verbatim by an operator). */
.dz-hint { font-size:12px; color:var(--text-muted); margin:2px 0 0; }
/* The five retention buckets. auto-fit with a minimum rather than five fixed columns, so a narrow dialog wraps
   to two rows instead of overflowing; the inputs are capped because a day count is three digits at most.
   NO BACKTICKS in this file — it is one template string, and one backtick ends it.  */
.ttl-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(128px,1fr)); gap:10px 12px; }
.ttl-grid input { max-width:120px; }
.ttl-grid label { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* ── schema: top-level collection tabs ── */
.sch-coll-tabs { display:flex; border-bottom:2px solid var(--border); margin-bottom:0; overflow-x:auto; gap:0; flex-shrink:0; }
.sch-coll-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px; padding:10px 22px; cursor:pointer; font-size:13px; font-family:var(--font); color:var(--text-muted); display:inline-flex; align-items:center; gap:6px; transition:color .15s; white-space:nowrap; }
.sch-coll-tab:hover { color:var(--text-primary); }
.sch-coll-tab.active { color:var(--text-primary); border-bottom-color:var(--accent); font-weight:600; }
.sch-cnt-badge { background:color-mix(in srgb,var(--accent) 15%,transparent); color:var(--accent); font-size:10px; font-weight:700; border-radius:10px; padding:1px 6px; min-width:18px; text-align:center; }
.sch-coll-body { padding:20px 0 0; }
/* ── type-list table (entity types / edge labels) ── */
.type-table { width:100%; border-collapse:collapse; font-size:13px; margin-bottom:0; }
.type-table th { text-align:left; font-size:11px; font-weight:600; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; padding:5px 10px; border-bottom:1px solid var(--border); background:var(--bg-elevated); }
.type-table td { padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:middle; }
.type-table tr:hover td { background:var(--bg-elevated); }
/* The property table, its rows, its detail card and the Required toggle are interpolated at the top of this
   const from PROP_TABLE_STYLES — three components render them, so they are not owned by this file. */
/* ── schema sub-section headers ── */
.sch-sub { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:var(--text-muted); padding:14px 0 8px; margin-bottom:2px; }
`;
