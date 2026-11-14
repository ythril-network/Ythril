/**
 * The app's "?" help: a small round button (`.area-info`) that opens an explanation box (`.explain`) beneath its owner, closed by
 * default. First written in the rights matrix; a type's history (Q-744) uses it in its dialog, the drawer's Type definition row and
 * the "Not defined in this space" pane, so the look is one constant the five sites import rather than five copies that drift.
 *
 * NOTE: no backticks anywhere in this file, comments included. It is one template literal.
 */
export const HELP_TOGGLE_STYLES = `
  .area-info {
    /* Flex-centred, not left to text metrics. A bare ? has left side bearing, so in a 15px circle at
       10px it sits visibly left of centre - reported as the help question-marks being off. A button's
       default text centring works on the ADVANCE width, which is not where the ink is. */
    display: inline-flex; align-items: center; justify-content: center;
    margin-left: 5px; width: 15px; height: 15px; padding: 0; line-height: 1;
    border: 1px solid var(--border); border-radius: 50%;
    background: var(--bg-surface); color: var(--text-muted);
    font-size: 10px; font-weight: 700; cursor: pointer; vertical-align: middle;
  }
  .area-info:hover { border-color: var(--accent); color: var(--accent); }
  .area-info[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }
  .explain {
    margin: 10px 0 2px; padding: 10px 12px; text-align: left;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated);
  }
`;
