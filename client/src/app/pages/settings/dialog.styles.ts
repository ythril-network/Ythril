import { STACK } from '../../shared/stacking';

/**
 * The modal shell: backdrop, panel, header.
 *
 * ## Why this is a shared constant and not six copies
 *
 * Angular component styles are SCOPED. `tokens.component.ts` defined `.dialog-backdrop` and `.dialog`, and
 * for as long as the create-token markup lived inside that component it was styled by them. Extracting the
 * dialog into its own component moved the markup and left the CSS behind — so the "dialog" rendered as a
 * plain block at the top of the page: full width, no backdrop, no centring, pushing the token list down.
 *
 * Nothing failed. The template compiled, the component rendered, every test passed, and the page was simply
 * wrong to look at. The owner found it, not the build: *"its also no pop-up"*.
 *
 * That is the failure mode of a per-component copy of shared CSS — it is invisible at the moment the markup
 * moves, which is exactly when it breaks. A constant both files import cannot be left behind by a move, and
 * `dialogs-carry-their-own-shell.test.js` fails any component that writes `.dialog-backdrop` in a template
 * without taking these rules with it.
 *
 * Sizing stays with the caller: dialogs legitimately differ in width (a confirm is not a schema editor), so
 * `--dialog-max-width` is a variable the host sets rather than a value baked in here.
 */
export const DIALOG_STYLES = `
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-scrim);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: ${STACK.dialog};
    padding: 16px;
  }
  .dialog {
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 24px;
    width: 100%;
    max-width: var(--dialog-max-width, 600px);
    max-height: 90vh;
    overflow-y: auto;
  }
  /* The third card surface, decorated on the same terms as .card and .modal in styles.scss — see the comment
     there for the whole argument.

     It has to be repeated here rather than covered by that rule, and that is the point of this file existing:
     these styles live in component style arrays, so Angular's emulated encapsulation scopes .dialog to the
     components that import THIS constant. A rule in the global sheet would never match it. Writing it here is
     what makes "three places, all global, none per-view" true of the decoration too.

     --bg-primary, not --bg-surface: a dialog's own base differs from a card's, and mixing the wrong one would
     make a decorated dialog a different shade from a decorated card.

     NOTE: no backticks anywhere in this file, including comments. It is one template literal, so a backtick ends
     the string and the error surfaces as "Failed to resolve styles at position 0", never here. */
  :root.ythril-decorated .dialog {
    background: color-mix(in srgb, var(--bg-primary) 74%, transparent);
    border-color: var(--tr-mid, var(--border));
    box-shadow:
      inset 0 1px 0 var(--tr-hot, transparent),
      0 10px 30px rgb(0 0 0 / 28%);
  }
  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
  }

  /*
   * THE SET-APART BLOCK, shared because two dialogs now need it and a copy would drift.
   *
   * It lived inline in token-rights-dialog alone. When the create dialog gained the same instance-level
   * flags, its markup used these class names and rendered COMPLETELY UNSTYLED — the create dialog imports
   * DIALOG_STYLES only, and Angular's per-component style encapsulation meant the other dialog's copy could
   * not reach it. That is the same defect as the schema property editor's lost stylesheet (#915): markup that
   * looks right in the diff and renders as unstyled text in the product.
   *
   * Only the CONTAINER and its heading move here. .danger-row/.danger-label/.danger-hint stay inline in
   * the rights dialog, because rotate and revoke exist nowhere else — a create form has nothing to rotate.
   *
   * Visually separated, and last. A destructive control beside Save is a mis-click; the reader should have to
   * travel to reach it. The border is the boundary, not decoration.
   */
  .danger-zone {
    margin-top: 20px;
    border: 1px solid var(--danger-border, var(--border));
    border-radius: var(--radius-md);
    padding: 12px 14px;
  }
  .danger-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--danger, var(--text-secondary));
    margin-bottom: 10px;
  }
  /* The inline hint beside a flag: an icon and a sentence on one line, muted. */
  .permission-help {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
    margin: 0;
  }
`;
