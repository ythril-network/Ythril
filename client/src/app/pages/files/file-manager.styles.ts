/**
 * Styles for the pieces extracted out of `file-manager.component.ts` (G-3).
 *
 * They had to travel with their markup rather than stay on the page. Angular scopes a component's styles to
 * its own template, so a rule the page declares cannot reach an element a child renders — and the failure is
 * silent: no error, no warning, just an unstyled control that still works. This repo has been bitten twice by
 * exactly that, which is why `shared-styles-reach-their-renderers` exists.
 *
 * **Two rules changed shape on the way, and that is the load-bearing part.** `.preview-body img` and
 * `.preview-body iframe` were written against the page's wrapper, which is now the PARENT of the component
 * that renders the image. Left qualified they would have matched nothing at all: an image with no width cap
 * and a PDF frame with no height, on a page that still looked fine until you opened one.
 */
/**
 * The toolbar strip: the space selector, the breadcrumb, the new-folder form and the sidebar toggle.
 *
 * `:host` is not styled here on purpose. The component renders two in-flow blocks that carry their own
 * margins, so it needs no box of its own — and a `:host` given border or margin without an explicit
 * `display` would apply them to a shrink-wrapping inline box, which still renders and looks almost right.
 */
export const FILE_TOOLBAR_STYLES = `
    .space-selector {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }

    .breadcrumb {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      flex: 1;
      flex-wrap: wrap;
    }

    .breadcrumb-sep { color: var(--text-muted); }

    .breadcrumb-item {
      color: var(--accent);
      cursor: pointer;
      border: none;
      background: none;
      font-size: 13px;
      font-family: var(--font);
      padding: 0;
    }
    .breadcrumb-item:hover { text-decoration: underline; }
    .breadcrumb-item.current { color: var(--text-primary); cursor: default; }
    .breadcrumb-item.current:hover { text-decoration: none; }

    /* The new-folder form. THE IN-TABLE RENAME FORM USES THE SAME CLASS and has its own copy in
       file-listing.component.ts — two consumers, so the rule exists in both places. Moving it to one alone
       left the other an unstyled block, which is how that was learned.
       (No backticks in here: one ends the template literal and the error points at @Component.) */
    .rename-form { display: flex; gap: 6px; align-items: center; }

    .sidebar-toggle {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      margin-left: auto;
    }
    .sidebar-toggle:hover { background: var(--bg-hover); }
`;

export const FILE_PREVIEW_STYLES = `
  .md-rendered { line-height: 1.6; word-break: break-word; }
  /*
   * A mermaid fence renders to inline SVG inside the markdown HTML, so this needs ::ng-deep for the
   * same reason every other rule below does: the content arrives through [innerHTML] and carries no
   * component scoping at all.
   *
   * This rule lived in file-manager.component.ts until 2026-09-03, where it matched NOTHING — a page
   * cannot style into a child's template, let alone into that child's [innerHTML]. So a diagram in a
   * previewed document was neither centred nor width-capped, and a wide one overflowed its column. It
   * looked like a slightly wonky diagram rather than a missing stylesheet, which is why it survived the
   * cut that moved .preview-body img and iframe here and left it behind.
   */
  .md-rendered ::ng-deep .mermaid-diagram { display: flex; justify-content: center; margin: 0.8em 0; }
  .md-rendered ::ng-deep .mermaid-diagram svg { max-width: 100%; height: auto; }
  .md-rendered ::ng-deep h1, .md-rendered ::ng-deep h2, .md-rendered ::ng-deep h3 { margin: 0.8em 0 0.4em; line-height: 1.25; }
  .md-rendered ::ng-deep h1 { font-size: 1.5em; } .md-rendered ::ng-deep h2 { font-size: 1.3em; } .md-rendered ::ng-deep h3 { font-size: 1.12em; }
  .md-rendered ::ng-deep p { margin: 0.5em 0; }
  .md-rendered ::ng-deep ul, .md-rendered ::ng-deep ol { margin: 0.5em 0; padding-left: 1.5em; }
  .md-rendered ::ng-deep code { background: var(--bg-muted); padding: 0.1em 0.35em; border-radius: 4px; font-family: var(--font-mono, monospace); font-size: 0.9em; }
  .md-rendered ::ng-deep pre { background: var(--bg-muted); padding: 12px; border-radius: 6px; overflow: auto; margin: 0.6em 0; }
  .md-rendered ::ng-deep pre code { background: none; padding: 0; }
  .md-rendered ::ng-deep a { color: var(--accent, #6ea8fe); }
  .md-rendered ::ng-deep blockquote { margin: 0.5em 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--text-muted); }
  .md-rendered ::ng-deep table { border-collapse: collapse; margin: 0.5em 0; }
  .md-rendered ::ng-deep th, .md-rendered ::ng-deep td { border: 1px solid var(--border); padding: 4px 8px; }
  .md-rendered ::ng-deep img { max-width: 100%; }

  /* xlsx grid preview */
  .xlsx-note { font-size: 0.8em; color: var(--text-muted); margin-bottom: 8px; }
  .xlsx-wrap { overflow: auto; max-width: 100%; }
  .xlsx-grid { border-collapse: collapse; font-size: 0.82em; font-variant-numeric: tabular-nums; }
  .xlsx-grid th, .xlsx-grid td { border: 1px solid var(--border); padding: 3px 8px; text-align: left; white-space: nowrap; max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  .xlsx-grid th { background: var(--bg-muted); font-weight: 600; position: sticky; top: 0; }
  .xlsx-grid tbody tr:nth-child(even) { background: color-mix(in srgb, var(--bg-muted) 40%, transparent); }

  img {
    max-width: 100%;
    max-height: 80vh;
    object-fit: contain;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: none;
  }

  .preview-code {
    background: var(--bg-muted);
    border-radius: 6px;
    padding: 16px;
    overflow: auto;
    font-family: var(--font-mono, monospace);
    font-size: 0.85em;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .preview-code code { background: none; }
  .preview-meta { display: grid; grid-template-columns: 100px 1fr; gap: 6px 12px; }
  .preview-meta dt { color: var(--text-muted); font-weight: 500; }
  .preview-meta dd { margin: 0; }
`;

/**
 * The upload panel's rules, moved with its markup (G-3).
 *
 * `.upload-panel` became `:host`, for the reason the graph extraction records: the host is the element the
 * page lays out, and a wrapper inside it would leave the host unsized.
 *
 * `.upload-zone` did not come along either, and the reason first written here was wrong: it said the class is
 * "the drop target on the page". It is not — the drop target is `.fm-main` with `[class.drag-over]`, and NO
 * element in the client carries `.upload-zone` at all. It was a dead rule, found by asking this gate about
 * this module, and it is deleted rather than moved.
 */
/**
 * The docked detail pane: its column, its header and tab strip, and the description beneath the preview.
 *
 * **`.preview-body` is DUPLICATED here rather than moved**, and the reason is the same one `.rename-form`
 * carries: two elements wear the class. The docked body is in this component; the full-screen overlay's
 * body is still on the page, where the overlay lives. Moving the rule to one of them leaves the other an
 * unstyled block — no error, no warning, just a preview that no longer scrolls.
 *
 * `:host` is not styled. The pane is a flex COLUMN of `.fm-layout`, and that geometry is on `.fm-detail`
 * inside it — a `:host` given the width and border without an explicit `display` would apply them to a
 * shrink-wrapping inline box, which still renders and looks nearly right.
 */
export const FILE_DETAIL_PANE_STYLES = `
  /* A third in-flow column of .fm-layout; the list (.fm-main) reflows to full width when it's absent. */
  .fm-detail {
    width: min(480px, 42vw);
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    max-height: calc(100vh - 180px);
  }
  /* Narrow window: the pane goes BELOW the list at full width (the page wraps its layout at the same width). */
  @media (max-width: 1100px) {
    .fm-detail { width: auto; border-left: none; border-top: 1px solid var(--border); }
  }
  .detail-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .detail-header .file-title { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Segmented [Preview & description | File meta | Extract] toggle */
  .seg-toggle { display: inline-flex; flex: 1; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .seg-toggle button {
    flex: 1; background: none; border: none; padding: 5px 10px; cursor: pointer;
    font-size: 0.82em; color: var(--text-muted); white-space: nowrap;
  }
  .seg-toggle button.active { background: var(--bg-muted); color: var(--text); font-weight: 600; }
  .seg-toggle button:not(.active):hover { background: var(--bg-hover); }
  .detail-body { flex: 1; overflow: auto; padding: 14px; }
  /* Description shown beneath the preview */
  .detail-desc { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .detail-desc h4 { margin: 0 0 6px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
  .detail-desc p { margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  /* Provenance sits inside the heading, quieter than it: it qualifies the description rather than
     announcing itself. Lower-case against the upper-case heading so it reads as an aside. */
  .detail-desc .desc-src { margin-left: 8px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 10px;
    font-size: 0.92em; text-transform: none; letter-spacing: 0; color: var(--text-muted); cursor: help; }
  /* SEE THE CLASS NOTE: the full-screen overlay's body wears this class too, and its copy is on the page. */
  .preview-body {
    position: relative;
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
  /* Full-screen toggle floats at the top-right of the preview body. */
  .preview-fs-btn { position: absolute; top: 4px; right: 4px; z-index: 1; opacity: 0.75; }
  .preview-fs-btn:hover { opacity: 1; }
`;

export const UPLOAD_QUEUE_STYLES = `
  :host {
    /*
     * The display is not decoration, it is the half a :host rewrite loses. .upload-panel was a div, which is
     * block by default; a custom element is INLINE, so every box property below — the border, the radius, the
     * margin, the overflow — was being applied to an inline box that shrink-wraps its content and ignores
     * vertical margin. The panel still rendered, which is why nothing caught it.
     *
     * NO BACKTICKS IN HERE: one ends the template literal, and the error surfaces as TS1005 in this file with
     * no hint that a comment caused it. Third time tonight.
     */
    display: block;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .upload-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
  }
  .upload-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }
  .upload-row + .upload-row { border-top: 1px solid var(--border); }
  .upload-row-icon { flex-shrink: 0; color: var(--text-secondary); }
  .upload-row.done .upload-row-icon { color: var(--success); }
  .upload-row.failed .upload-row-icon { color: var(--error); }
  .upload-row-body { flex: 1; min-width: 0; }
  .upload-row-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .upload-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .upload-state {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .upload-row.failed .upload-state { color: var(--error); }
  .upload-bar {
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    margin-top: 6px;
  }
  .upload-bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }
  .upload-row-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

`;

/**
 * The file-meta form's rules, moved with its markup (G-3).
 *
 * They stay QUALIFIED by `.detail-meta-form` rather than becoming `:host`. The form is one element inside this
 * component and the host is its wrapper in the pane, so the class is doing real work here — unlike the panel
 * and card extractions, where the class WAS the host and leaving it qualified would have matched nothing.
 */
export const FILE_META_EDITOR_STYLES = `
  .detail-meta-form .field { margin-bottom: 12px; }
  .detail-meta-form label { display: block; margin-bottom: 4px; font-size: 0.8em; color: var(--text-muted); }
  .detail-meta-form textarea { width: 100%; resize: vertical; }
  .detail-meta-actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
`;

/**
 * The extract view's rules, moved with its markup (G-3).
 *
 * Left qualified by `.detail-extract` rather than hoisted to `:host`: the wrapper is one element inside the
 * component, and several rules read `.detail-extract .muted` / `.desc-src` — scoping those to the host would
 * change which elements they reach.
 */
export const FILE_EXTRACT_STYLES = `
  /* Extract face. A diagnostic, so it is dense and legible rather than pretty: the chunk bodies are the
     thing being read, and everything else is a label on them. */
  .detail-extract section { margin-bottom: 18px; }
  .detail-extract h4 { margin: 0 0 8px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); }
  .detail-extract .muted { color: var(--text-muted); font-size: 0.9em; }
  .chunk { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: var(--bg-primary); }
  .chunk-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 5px; font-size: 0.82em; }
  .chunk-ix { font-family: var(--font-mono, monospace); color: var(--text-muted); flex: none; }
  /* Provenance can be a long heading; it truncates rather than pushing the row. */
  .chunk-prov { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chunk-warn { color: var(--warning); flex: none; }
  /* pre-wrap, because a chunk's own line breaks are part of what retrieval sees. */
  .chunk-body { margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 1.45; font-size: 0.92em; }
  .xtr-image { border-top: 1px solid var(--border); padding: 8px 0; }
  .xtr-image p { margin: 4px 0 0; line-height: 1.45; font-size: 0.92em; }
  .xtr-path { font-family: var(--font-mono, monospace); font-size: 0.82em; color: var(--text-muted); word-break: break-all; }
  .xtr-md { margin: 6px 0 0; padding: 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg-primary); max-height: 40vh; overflow: auto; white-space: pre-wrap;
    word-break: break-word; font-size: 0.85em; line-height: 1.45; }
  .detail-extract .desc-src { margin-left: 6px; padding: 1px 6px; border: 1px solid var(--border);
    border-radius: 10px; font-size: 0.86em; color: var(--text-muted); cursor: help; }
`;

/**
 * The directory listing's rules, moved with its markup (G-3's last cut).
 *
 * `.rename-form` came too, and it is the reason this block is assembled from two ranges rather than one: it
 * sat forty lines below the rest, under the upload-queue banner, because that is where somebody happened to
 * add it. The upload zone in between STAYS on the page — it is the drop target, not part of the table.
 *
 * No `:host` rewrite here: every rule is qualified by a class inside the component's own template, and the
 * host is the wrapper the page lays out.
 */
export const FILE_LISTING_STYLES = `
  .file-icon { width: 20px; text-align: center; flex-shrink: 0; }

  .file-name-btn {
    background: none;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    font-size: 13px;
    font-family: var(--font);
    text-align: left;
    padding: 0;
  }
  .file-name-btn.dir { color: var(--info); font-weight: 500; }
  .file-name-btn:hover { text-decoration: underline; }
  /*
   * The name column takes whatever width the other columns leave and ellipsizes inside it (its title carries the whole name),
   * so a long name can never be the reason the table is wider than the window (Q-471). width:100% with max-width:0 is the
   * table-cell form of "fill the rest and shrink": the other columns size to their content, and this one is the slack.
   */
  .name-cell { width: 100%; max-width: 0; min-width: 100px; }
  .name-cell .file-name-btn { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Seven columns in German: the shell's 14px of side padding per cell is what no longer fits, so this table runs at 10px. */
  th, td { padding-left: 10px; padding-right: 10px; }

  /* The actions are a flex row INSIDE the cell: a cell that is itself display:flex is no longer a table cell. */
  .row-actions { display: flex; gap: 6px; align-items: center; }
  /*
   * The last column stays reachable wherever the table has to scroll sideways (a narrow window, the detail pane open, a
   * long name): every action is on screen without scrolling to find it. Opaque, or the cells that scroll under it show
   * through. Where the table fits it changes nothing.
   */
  th.actions-cell, td.actions-cell { position: sticky; right: 0; box-shadow: -1px 0 0 var(--border-muted); }
  th.actions-cell { background: var(--bg-elevated); }
  td.actions-cell { background: var(--bg-primary); }
  tbody tr:hover td.actions-cell { background: var(--bg-elevated); }

  /* Merged metadata columns: embedding-status pill + tag chips (joined from the file's FileMeta). */
  .emb-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 500;
    padding: 1px 8px; border-radius: 20px; white-space: nowrap; border: 1px solid transparent; }
  .emb-pill .emb-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
  .emb-complete { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); border-color: color-mix(in srgb, var(--success) 30%, transparent); }
  .emb-complete .emb-dot { background: var(--success); }
  .emb-pending, .emb-processing { color: var(--info); background: color-mix(in srgb, var(--info) 14%, transparent); border-color: color-mix(in srgb, var(--info) 30%, transparent); }
  .emb-pending .emb-dot, .emb-processing .emb-dot { background: var(--info); }
  .emb-partial { color: var(--warning); background: color-mix(in srgb, var(--warning) 15%, transparent); border-color: color-mix(in srgb, var(--warning) 32%, transparent); }
  .emb-partial .emb-dot { background: var(--warning); }
  .emb-failed { color: var(--error); background: color-mix(in srgb, var(--error) 14%, transparent); border-color: color-mix(in srgb, var(--error) 30%, transparent); }
  .emb-failed .emb-dot { background: var(--error); }
  .emb-skipped, .emb-disabled { color: var(--text-muted); background: var(--bg-elevated); border-color: var(--border); }
  .emb-skipped .emb-dot, .emb-disabled .emb-dot { background: var(--text-muted); }
  .tag-list { display: inline-flex; gap: 4px; flex-wrap: wrap; }
  .tag-chip { font-size: 10.5px; padding: 1px 7px; border-radius: 20px; background: var(--bg-elevated);
    border: 1px solid var(--border); color: var(--text-secondary); white-space: nowrap; }
  .rename-form { display: flex; gap: 6px; align-items: center; }
`;
