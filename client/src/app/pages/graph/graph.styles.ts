/**
 * Styles for the graph page — the canvas shell, toolbar, side panel, detail table and record drawer.
 *
 * Extracted verbatim from `graph.component.ts` during the god-file split, following the
 * `pages/brain/*.styles.ts` precedent: 558 lines of CSS in the middle of a component file pushes the
 * TypeScript that a reader came for past the point where anyone scrolls. Not one declaration changed.
 *
 * NB: never put a backtick in a comment in here — it terminates the template literal, and the error
 * points at the component's `@Component` decorator rather than at this file.
 */
export const GRAPH_STYLES = `
    :host {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 56px - 56px);
      min-height: 0;
      gap: 8px;
    }
    :host.embedded {
      height: 70vh;
      min-height: 400px;
    }

    /* ── Space chips (matches brain style) ─────────────────────────────────── */
    .space-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      flex-shrink: 0;
    }
    .space-chip {
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1px;
      min-width: 90px;
      white-space: nowrap;
    }
    .space-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .space-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
    }
    .space-chip-label { font-size: 12px; font-weight: 500; }
    .space-chip-id { font-size: 10px; color: var(--text-muted); }
    .space-chip.active .space-chip-id { color: var(--accent); opacity: 0.7; }

    /* ── Toolbar ───────────────────────────────────────────────────────────── */

    /* ── Canvas zone ──────────────────────────────────────────────────────── */

    .canvas-row {
      display: flex;
      flex: 1;
      min-height: 0;
      gap: 8px;
    }

    .canvas-zone {
      position: relative;
      flex: 1;
      min-height: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-primary);
      overflow: hidden;
    }

    .cy-container {
      width: 100%;
      height: 100%;
      position: absolute;
      inset: 0;
    }

    .truncation-banner {
      position: absolute;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 20;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: var(--error-dim);
      border: 1px solid var(--error);
      border-radius: var(--radius-sm);
      color: var(--warning);
      font-size: 13px;
      white-space: nowrap;
    }
    .truncation-banner button {
      background: transparent;
      border: none;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      padding: 0 2px;
    }

    .canvas-empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      gap: 8px;
    }
    .empty-icon {
      font-size: 52px;
      line-height: 1;
      opacity: 0.2;
    }
    .canvas-empty h3 {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 15px;
      margin: 0;
    }
    .canvas-empty p {
      color: var(--text-muted);
      font-size: 13px;
      margin: 0;
      opacity: 0.7;
    }

    /* Loading overlay */
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--bg-primary) 60%, transparent);
      z-index: 30;
      backdrop-filter: blur(2px);
    }
    .loading-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid color-mix(in srgb, var(--accent) 25%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: graph-spin 0.75s linear infinite;
    }
    @keyframes graph-spin { to { transform: rotate(360deg); } }
    .loading-overlay { flex-direction: column; gap: 14px; }
    .loading-waiting { max-width: 420px; padding: 0 16px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .loading-waiting p { margin: 0 0 6px; }
    .loading-waiting .loading-waiting-title { color: var(--text-primary); }
    .wait-reasons { margin-top: 10px; text-align: center; color: var(--text-muted); font-size: 13px; }
    .wait-reasons p { margin: 0 0 4px; }

    /* ── Side panel (shown when node or edge selected) ───────────────────── */

    .side-panel {
      width: 560px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-surface);
      overflow: hidden;
      min-height: 0;
    }

    /* Side panel body: two columns */
    .side-panel-body {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }



    /* ── Shared badge, button helpers ──────────────────────────────────────── */
    .tag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      font-size: 11px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      border: 1px solid var(--border);
      margin-right: 3px;
    }

    /* entity chips */
    .chip {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 2px 8px; border-radius: 10px;
      background: var(--accent-dim); border: 1px solid var(--accent);
      font-size: 11px; color: var(--text-primary);
    }
`;


/**
 * Styles for `GraphLinkedRecordsComponent` — the memory/chrono lists under a node or edge panel.
 *
 * These left `GRAPH_STYLES` when the markup did. A parent component's styles do not reach a child's
 * template, so leaving them behind would have rendered the lists unstyled: still present, still
 * clickable, just visually wrong — which no unit test can see.
 */
export const GRAPH_LINKED_RECORDS_STYLES = `
  /* The pane itself — this component IS the right column of a side panel. */
  :host {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .list-section {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-bottom: 1px solid var(--border);
  }
  .list-section:last-child { border-bottom: none; }
  .list-section-header {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 12px 6px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .list-section-header .count-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--bg-overlay);
    border-radius: 8px;
    font-size: 10px;
    color: var(--text-muted);
  }
  .list-body { overflow-y: auto; flex: 1; }
  .list-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background var(--transition);
  }
  .list-row:last-child { border-bottom: none; }
  .list-row:hover { background: var(--bg-elevated); }
  .list-row-text {
    flex: 1;
    font-size: 12px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list-row-date {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .list-empty {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    padding: 16px 12px;
  }

  /* Filter bar. flex-shrink:0 so it stays put while the lists below take the remaining height. */
  .detail-filters {
    display: flex;
    gap: 6px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .detail-filters select,
  .detail-filters input {
    padding: 3px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font);
    font-size: 11px;
    min-width: 0;
  }
  /* The select must state width:auto explicitly. A global select rule sets width:100%, which becomes a
     100% flex-basis here: it ate the whole row and left the text box a 14px sliver. Declaring nothing
     means inheriting whatever global rule exists, which is how that slipped past the unit tests. */
  .detail-filters select { flex: 0 0 auto; width: auto; }
  /* The text box takes the slack. */
  .detail-filters input { flex: 1 1 auto; }
  .detail-filters select:focus,
  .detail-filters input:focus { outline: none; border-color: var(--accent); }
`;


/**
 * The record cards' own rules — the LEFT column of a side panel.
 *
 * They moved out of `GRAPH_STYLES` with the markup, for the reason `GRAPH_LINKED_RECORDS_STYLES` already
 * records: the parent's styles are scoped to the parent's own template, so markup moved into a child renders
 * UNSTYLED unless its rules move with it — and no unit test can see that.
 *
 * `.record-card` became `:host`, because the host is the element the parent lays out. Left on an inner
 * wrapper it would leave the host unsized, `flex: 0 0 50%` would do nothing, and the column would collapse.
 *
 * `.drawer-muted` did not come along at first, because at that moment nothing in the graph page rendered it —
 * the unavailable message asked for `.muted`, which was declared nowhere at all. Fixing that spelling gave the
 * class its first two users here, and a class with users has to be DEFINED where they can reach it: brain's
 * copy lives in `BRAIN_DRAWER_STYLES`, which is scoped to brain's own components and could never reach a
 * graph child. So it is declared below, and `shared-styles-reach-their-renderers` now watches this pair.
 */
export const GRAPH_RECORD_CARD_STYLES = `
  /* The card itself — this component IS the left column of a side panel. */
  :host {
    display: block;
    flex: 0 0 50%;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 12px 14px;
  }


  /* Drawer fields (same pattern as brain component) */
  .drawer-field { margin-bottom: 14px; }
  .drawer-label {
    font-size: 10px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  .drawer-value {
    font-size: 12px;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  /* Why a panel is empty, said quietly. Without this rule the sentence inherits the drawer-value colour,
     text-primary, and reads as a record's value rather than as an explanation of its absence. */
  .drawer-muted { color: var(--text-muted); }
  .drawer-hr { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .drawer-readonly-value {
    font-size: 12px;
    color: var(--text-muted);
    padding: 4px 8px;
    border: 1px solid var(--border-muted, var(--border));
    border-radius: var(--radius-sm);
    background: var(--bg-elevated);
    word-break: break-all;
    line-height: 1.4;
  }
  .drawer-tag {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    margin: 2px 3px 2px 0;
  }
`;

/**
 * The panel header's own rules, moved out of GRAPH_STYLES with its markup.
 *
 * They had to move: a parent's styles are scoped to the parent's own template, so a header rendered by a child
 * component would have taken none of them — no border, no spacing, an unstyled h3 — and no unit test can see
 * that. `shared-styles-reach-their-renderers` is the gate for the case where the class is owned by a SHARED
 * module; these are owned here, which is why they travel with the component instead.
 *
 * `.side-panel-header` became `:host`, for the reason the record card records: the host is the element the
 * panel lays out, and a wrapper inside would leave it unsized.
 */
export const GRAPH_PANEL_HEADER_STYLES = `
  :host {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    gap: 8px;
  }
  .side-panel-title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .side-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .side-panel-title h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side-panel-header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  /* The view button was two identical inline styles, one per copy of this bar. */
  .view-btn { display: inline-flex; align-items: center; }
`;

/**
 * The toolbar's own rules, moved out of GRAPH_STYLES with its markup (G-7).
 *
 * `.graph-toolbar` became `:host`, and the descendant selectors written against it became plain element
 * selectors — inside the component they are already scoped to its template, and leaving them qualified would
 * have meant matching nothing, since the host does not carry the class it is selected by from outside.
 */
export const GRAPH_TOOLBAR_STYLES = `
  :host {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  select,
  input[type="search"],
  input[type="text"] {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font);
    font-size: 13px;
    padding: 6px 10px;
    outline: none;
    transition: border-color var(--transition);
  }
  select:focus,
  input:focus {
    border-color: var(--accent);
  }

  select { min-width: 140px; }

  .search-wrapper {
    position: relative;
    flex: 1;
    min-width: 200px;
    max-width: 360px;
  }

  .toolbar-divider {
    width: 1px;
    height: 22px;
    background: var(--border);
    flex-shrink: 0;
  }
  .toolbar-spacer { flex: 1; }
  .toolbar-label {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .depth-control {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .depth-control input[type="range"] {
    accent-color: var(--accent);
    width: 80px;
    cursor: pointer;
  }
  .depth-value {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    min-width: 14px;
    text-align: center;
  }

  .pill-group {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    flex-shrink: 0;
  }
  .pill-group button {
    padding: 5px 12px;
    font-size: 12px;
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border: none;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
    white-space: nowrap;
  }
  .pill-group button + button { border-left: 1px solid var(--border); }
  .pill-group button.active {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .pill-group button:hover:not(.active) {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }

  .toolbar-toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .toolbar-toggle input[type="checkbox"] { accent-color: var(--accent); }

  .toolbar-btn {
    padding: 5px 10px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 14px;
    cursor: pointer;
    line-height: 1;
    transition: border-color var(--transition), color var(--transition), background var(--transition);
  }
  .toolbar-btn:hover {
    border-color: var(--accent);
    color: var(--text-primary);
    background: var(--accent-dim);
  }
  .graph-stats {
    font-size: 12px;
    color: var(--text-muted);
    white-space: nowrap;
    font-family: var(--font-mono);
  }
`;
