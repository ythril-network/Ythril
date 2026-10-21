/**
 * Styles shared between the brain shell's create/edit forms and the extracted record drawer
 * (A17.9b-5). Angular's Emulated encapsulation scopes styles per component, so the chip/flyout rules
 * the forms use and the drawer reuses must be available in BOTH components — sourcing them from one
 * const keeps them from drifting. `BRAIN_DRAWER_STYLES` is drawer-only (the shell no longer renders
 * the drawer, so it does not import it).
 */

/** Entity-chip + inline reference-picker styling, used by every form, the ref-field components, and
 *  the drawer. (The old click-to-open flyout was retired once file-meta moved to the inline pickers.) */
export const BRAIN_CHIP_STYLES = `
    .chip-list { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; min-height: 24px; }
    .chip {
      display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px;
      border-radius: 10px; background: var(--accent-dim); border: 1px solid var(--accent);
      color: var(--accent); font-size: 11px; font-weight: 500; max-width: 200px;
    }
    .chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip-remove {
      background: none; border: none; color: var(--accent); cursor: pointer;
      font-size: 13px; line-height: 1; padding: 0 1px; flex-shrink: 0;
    }
    .entity-multi { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-height: 28px; padding: 2px 0; }
    .chip-add { font-size: 11px; padding: 2px 8px; background: transparent;
      border: 1px dashed var(--border); border-radius: 10px;
      color: var(--text-muted); cursor: pointer;
    }
    .chip-add:hover { border-color: var(--accent); color: var(--accent); }
    /* Inline memory picker (chrono form + drawer, slice 3c): input + absolute results dropdown. */
    .mem-pick { position: relative; }
    .mem-pick-menu {
      position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 60;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: var(--radius-md); box-shadow: var(--shadow-lg);
      max-height: 200px; overflow-y: auto;
    }
    .mem-pick-item {
      display: block; width: 100%; text-align: left; padding: 6px 10px;
      background: transparent; border: none; border-bottom: 1px solid var(--border-muted);
      color: var(--text-primary); font-size: 12px; cursor: pointer;
    }
    .mem-pick-item:last-child { border-bottom: none; }
    .mem-pick-item:hover { background: var(--bg-elevated); }
`;

/** The detail drawer's own layout (overlay, panel, header, fields, read-only rows). Drawer-only. */
export const BRAIN_DRAWER_STYLES = `
    .drawer-overlay {
      position: fixed; inset: 0; background: var(--bg-scrim);
      z-index: 200; display: flex; justify-content: flex-end;
    }
    .drawer {
      width: min(480px, 100vw); background: var(--bg-primary); height: 100%;
      overflow-y: auto; padding: 20px 24px;
      box-shadow: var(--shadow-drawer);
      display: flex; flex-direction: column;
      animation: drawer-in .18s ease;
    }
    @keyframes drawer-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
    .drawer-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      margin-bottom: 20px; padding-bottom: 14px;
      border-bottom: 1px solid var(--border); gap: 12px;
    }
    .drawer-title { font-size: 16px; font-weight: 600; color: var(--text-primary); word-break: break-word; }
    .drawer-field { margin-bottom: 16px; }
    .drawer-label {
      font-size: 10px; font-weight: 600; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
    }
    .drawer-value { font-size: 13px; color: var(--text-primary); white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
    .drawer-muted { color: var(--text-muted); }
    .drawer-view-notice { margin: 0 0 12px; font-size: 12px; color: var(--text-muted); }
    .drawer fieldset:disabled { opacity: 0.65; cursor: not-allowed; }
    .drawer-hr { border: none; border-top: 1px solid var(--border-muted); margin: 16px 0; }
    .drawer-readonly-value {
      font-size: 13px; color: var(--text-muted); padding: 5px 8px;
      border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
      background: var(--bg-surface); word-break: break-all; line-height: 1.4;
    }
    .drawer input[type=text], .drawer input[type=number], .drawer input[type=datetime-local],
    .drawer textarea, .drawer select {
      width: 100%; padding: 5px 8px; border: 1px solid var(--border);
      border-radius: var(--radius-sm); font-size: 13px;
      background: var(--bg-primary); color: var(--text-primary); box-sizing: border-box;
    }
    .drawer textarea { resize: vertical; }
    .drawer select { cursor: pointer; }
`;
