/**
 * Styles shared by the schema tab and the per-type editor extracted from it.
 *
 * They live here rather than in either component because both render the same controls: the tab owns the
 * master list and the detail frame, the editor owns the fields inside it, and the two are visually one
 * pane. Two copies of these rules would drift the moment either side was touched, and the drift would be
 * invisible until somebody compared the settings page with the Overview dialog side by side.
 *
 * The editor imports the whole set rather than a hand-split subset. A few list-side rules go unused there,
 * which costs nothing, where splitting by hand would risk leaving a rule behind for a control that still
 * uses it.
 */
export const SCHEMA_MD_STYLES = `
/* A floor, so this row cannot collapse and drag the master/detail grid up with it. The row's height is
   otherwise stable by construction now: one hint string for all four collections, differing by a single
   field name, so it wraps the same way whichever tab is open. That is what stops the add control below
   from moving when you switch category. */
.sch-head-row { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
  min-height:20px; }
.val-controls { display:inline-flex; align-items:center; gap:16px; flex-wrap:wrap; }
.val-lbl { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
.val-select { font:inherit; font-size:12px; text-transform:none; letter-spacing:0; padding:3px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg-elevated); color:var(--text-primary); }
.val-check { display:inline-flex; align-items:center; gap:6px; font-size:12px; color:var(--text-secondary); cursor:pointer; }
.val-check input { margin:0; }
.sch-validation-bar { display:flex; align-items:center; justify-content:space-between; gap:16px 20px; flex-wrap:wrap;
  padding:12px 14px; margin-bottom:14px; border:1px solid var(--border); border-radius:10px; background:var(--bg-surface); }
.sch-validation-bar .svb-label { display:flex; flex-direction:column; gap:2px; min-width:0; }
.sch-validation-bar .svb-title { font-size:13px; font-weight:640; color:var(--text-primary); }
.sch-validation-bar .svb-hint { font-size:11.5px; color:var(--text-muted); }
.sch-md { display:grid; grid-template-columns:minmax(190px,250px) 1fr; gap:18px; align-items:start; margin-top:6px; }
@media (max-width:760px) { .sch-md { grid-template-columns:1fr; } }
.sch-master { display:flex; flex-direction:column; gap:3px; min-width:0; }
/* The list of types scrolls inside itself; the add-row above and imports below stay pinned. */
.sch-type-list { display:flex; flex-direction:column; gap:3px; min-height:0; overflow-y:auto; max-height:340px; }
.sch-type-item { display:flex; align-items:center; gap:8px; width:100%; text-align:left; background:none;
  border:1px solid transparent; border-radius:8px; padding:7px 9px; cursor:pointer; font:inherit; color:var(--text-primary); }
.sch-type-item:hover { background:var(--bg-elevated); }
.sch-type-item.sel { background:color-mix(in srgb,var(--accent) 12%,transparent); border-color:color-mix(in srgb,var(--accent) 34%,transparent); }
.sch-type-item .nm { font-family:var(--font-mono); font-size:13px; color:var(--accent); flex:1; min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sch-type-badges { display:inline-flex; gap:3px; flex-wrap:wrap; justify-content:flex-end; }
.sch-empty-list { color:var(--text-muted); font-size:12.5px; font-style:italic; padding:14px 6px; text-align:center; }
.sch-detail { min-width:0; }
.sch-detail-empty { color:var(--text-muted); font-size:13px; font-style:italic; padding:26px 20px; text-align:center;
  border:1px dashed var(--border); border-radius:10px; }
.sch-detail-head { display:flex; align-items:center; gap:10px; min-height:var(--sch-head-h);
  margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border); box-sizing:content-box; }
.sch-detail-head .dt { font-family:var(--font-mono); font-size:15px; color:var(--accent); font-weight:600; flex:1; min-width:0;
  overflow:hidden; text-overflow:ellipsis; }
.sch-detail-head .acts { display:flex; gap:4px; flex-shrink:0; }
/* Pinned above the list: a bottom rule, not a top one, because it now heads the column.

   It and the detail pane's head are the two column headers, side by side, so they share one height and
   one bottom margin — otherwise their rules sit at different y and the two columns read as misaligned
   even though the grid starts them at the same top edge. --sch-head-h is that shared height; changing
   it moves both. */
.sch-md { --sch-head-h:34px; }
.sch-add-row { display:flex; gap:6px; align-items:center; min-height:var(--sch-head-h);
  margin-bottom:14px; padding-bottom:10px; border-bottom:1px solid var(--border); box-sizing:content-box; }
.sch-add-row input { flex:1; min-width:0; }
.sch-add-btn { display:grid; place-items:center; flex:none; width:30px; height:30px; padding:0;
  border:1px solid var(--border); border-radius:8px; background:var(--bg-primary);
  color:var(--accent); cursor:pointer; }
.sch-add-btn:hover:not(:disabled) { border-color:var(--accent); }
.sch-add-btn:disabled { color:var(--text-muted); cursor:not-allowed; opacity:.6; }
.sch-add-btn:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
/* Same row, but it heads the detail pane's foot rather than the list's head: rule on top, not bottom. */
.sch-add-prop { margin-bottom:0; padding-bottom:0; border-bottom:none;
  margin-top:10px; padding-top:10px; border-top:1px solid var(--border); }
.sch-add-prop input { max-width:260px; }
.sch-add-imports { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; padding-top:8px;
  border-top:1px solid var(--border-muted); }
/* .prop-caret moved to PROP_TABLE_STYLES — it belongs with the rows it opens, and a component rendering the
   caret needs the row rules anyway. Two homes for one class is how the caret survived while the table around
   it lost its styling. */
/* One coherent text scale for the tab: guidance, section labels, inline messages.
   Every section label reads the same and every hint hangs off it the same way — the delimiter is an
   em dash in all of them, where it used to be parentheses in some and a dash in others. */
.sch-hint { font-size:11px; font-weight:400; text-transform:none; letter-spacing:0; color:var(--text-muted); }
.sch-section-label { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px; }
/* One rhythm between sections of the detail pane. They were spaced by whatever each block's own
   margins happened to add up to, so the gaps above "Tag suggestions" and "Property schemas" differed
   by several pixels for no reason a reader could infer. */
.sch-detail .sch-section-label,
.sch-detail > .field > label { margin-top:16px; }
.sch-detail > .field:first-of-type > label,
.sch-detail .sch-section-label:first-of-type { margin-top:0; }
/* The two retention windows sit side by side and wrap only on a genuinely narrow pane.
   .field must be given a BASIS: it is a flex column, so its intrinsic width is its widest child, and the
   chrono hint under the second input is a long sentence — left to size itself that field claimed the whole
   row and both stacked. Verified by measurement, not by looking at the CSS: the first attempt reported
   two inputs with the labels and placeholders all correct, and they were one above the other. */
.ret-row { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start; }
.ret-row .field { flex:1 1 190px; min-width:0; max-width:260px; }
.ret-row input { max-width:150px; }
.sch-msg { font-size:12px; margin-top:6px; }
.sch-msg.err { color:var(--error); }
.sch-msg.ok  { color:var(--success); }
.sch-msg.info { color:var(--text-muted); }
/* The two ends sit side by side like the retention windows, and for the same reason each column needs a
   basis: a flex column's intrinsic width is its widest child, and a long type name would otherwise claim
   the row. Wider than .ret-row's columns because these hold a list rather than one number. */
.ends-row { display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start; }
.ends-row .field { flex:1 1 220px; min-width:0; max-width:320px; }
/* Scrolls rather than growing: a space with forty entity types would otherwise push the cardinality
   checkbox and the pair preview off the pane, and those are the two things that explain the lists. */
.ends-list { display:flex; flex-direction:column; gap:2px; max-height:180px; overflow-y:auto; padding:4px 6px;
  border:1px solid var(--border); border-radius:4px; }
/* text-transform:none is the whole reason this rule is not two lines shorter. These are LABEL elements,
   and the app uppercases labels — so a type called person rendered as PERSON, which is not its name and
   is not what any record carries. Found by reading the screenshot, not the CSS. The name itself gets the
   same mono treatment as the type list on the left, so it reads as an identifier rather than as prose. */
.ends-opt { display:flex; align-items:center; gap:6px; font-size:12px; font-weight:400; cursor:pointer;
  margin:0; text-transform:none; letter-spacing:normal; }
.ends-opt .nm { font-family:var(--font-mono); color:var(--accent); }
.ends-opt .any { color:var(--text-muted); font-style:italic; }
.ends-opt input { margin:0; }
.ends-pairs { display:flex; flex-wrap:wrap; gap:3px; margin-top:4px; }
.sch-type-badges .badge { font-size:9px; }
`;
