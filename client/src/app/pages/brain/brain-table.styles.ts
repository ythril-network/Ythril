/**
 * Brain-scoped styles shared by the record tabs' list views (memories/entities/edges/chrono/filemeta)
 * — the search/filter header, the create form, the filter chips, the inline delete confirm, and the
 * clamped description cell. Extracted alongside the first tab component (A17.9b-6d); each tab component
 * imports this so its Emulated-encapsulated view keeps the same look. The table/pagination/empty-state/
 * tag styles are GLOBAL (styles.scss), so they are not duplicated here.
 *
 * The shell still carries its own copies inline while the remaining tabs live there; once all five tabs
 * are components the shell's copies become dead and get removed in a final cleanup.
 */
export const BRAIN_RECORD_TABLE_STYLES = `
    .content-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    /* The plain search input styles itself (record-search-bar.component.ts) and app-entity-search
       matches that spec — see the note there. Both are capped to the same width here so the entities
       bar and the other tabs' bars line up. */
    .content-header app-entity-search {
      flex: 1;
      min-width: 180px;
      max-width: 400px; /* match the plain search input above (was 520 — the entities bar rendered wider) */
    }
    /* A slim row above the table, now only carrying the facts tab's active ENTITY-filter chip
       (the type/tag filters moved into the headers in 2b-ii). */
    .list-filter-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    /* Slice 2b-ii: filters dock UNDER each column label (via th[app-sort-th]'s projected slot).
       These style the docked controls uniformly across every tab. */
    .col-filter-select, .col-filter-input {
      height: 26px;
      max-width: 100%;
      box-sizing: border-box;
      padding: 2px 6px;
      font-size: 12px;
      font-weight: 400;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      color: var(--text-primary);
    }
    .col-filter-select { min-width: 96px; }
    .col-filter-input { min-width: 90px; }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: 10px;
      background: var(--accent-dim);
      border: 1px solid var(--accent);
      color: var(--accent);
      font-size: 11px;
      font-weight: 500;
    }
    .filter-chip button {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 2px;
    }
    .tag-clickable, .entity-clickable {
      cursor: pointer;
      transition: opacity var(--transition);
    }
    .tag-clickable:hover, .entity-clickable:hover { opacity: 0.7; }
    /* Uniform control height across every brain form control. 34px matches app-tag-input's wrap —
       the tallest single-line control — so aligning to it lifts the plain inputs/selects up to a
       shared height instead of leaving four different ones on the page (search 5/10, filter 30,
       create 5/8, global 8/12). Single-line fields become identical; textarea/properties grow. */
    .create-form { --brain-control-h: 34px; }
    .create-form {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      margin-bottom: 12px;
    }
    /* The form is a vertical stack of .form-row blocks. Each tab composes its own rows in
       table-column order: single-line fields (name/type/tags, from/to/label/weight) go in a plain
       row at one uniform height; the tall fields (description then properties, or fact then
       description) go in a .form-row.rich where each field flexes and grows, tops aligned. This makes
       the feedback's "same input height … description the current height as baseline but expands with
       properties container" a structure rather than a pile of per-field inline widths. */
    .create-form .form-row {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .create-form .form-row.rich > .field { flex: 1; min-width: 220px; }
    .create-form .field { margin-bottom: 0; display: flex; flex-direction: column; }
    .create-form label { font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 2px; }
    .create-form input, .create-form select, .create-form textarea {
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 13px;
      background: var(--bg-primary);
      color: var(--text-primary);
      box-sizing: border-box;
    }
    /* Single-line controls (and app-tag-input's wrap, already 34px) share the one height. */
    .create-form input:not([type=checkbox]), .create-form select { min-height: var(--brain-control-h); }
    /* Description starts at the single-line height as its baseline and grows from there. */
    .create-form textarea { resize: vertical; min-height: var(--brain-control-h); }
    .inline-confirm {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--error);
    }
    .inline-confirm button { font-size: 11px; }
    /* The td stays a real table cell so it fills its column; the 3-line clamp lives on an inner box
       (setting display:-webkit-box on the td itself drops it out of table layout). */
    .desc-cell {
      font-size: 12px;
      color: var(--text-muted);
    }
    .desc-cell .desc-clamp {
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pill-group { display:flex; border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; flex-shrink:0; }
    .pill-group button { padding:5px 10px; font-size:11px; background:transparent; border:none; border-right:1px solid var(--border); color:var(--text-secondary); cursor:pointer; white-space:nowrap; }
    .pill-group button:last-child { border-right:none; }
    .pill-group button.active { background:var(--accent-dim); color:var(--accent); }
    .pill-group button:hover:not(.active) { background:var(--bg-surface); }
`;
