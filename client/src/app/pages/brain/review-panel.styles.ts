/**
 * The segmented control and the finding card the Review panels draw alike (bundle-285 slice S9, Q-747; handover item 6).
 *
 * ## What it prevents
 *
 * The Unconverted panel copied the control out of Forks and the card out of Contradictions so the same queue would not look like two products, and
 * the copy kept that promise only until one of them was touched: a padding changed in one panel and not the others, and no spec of a single panel
 * sees it. The rules are here once, in the theme's tokens, and a panel lists them in its `styles` array (an Emulated-encapsulated view gets the
 * rules of its own component only, so each panel that draws the control or the card lists the constant). What stays in a panel is what is its own:
 * the control's margin, a rule for something only it draws, and the card's distance from what is above it (`--rv-grid-top`, set on `:host`).
 *
 * `review-panels-share-one-style.spec.ts` refuses a second copy in any of the three panels.
 *
 * ## The control's breakpoint
 *
 * The control turns into a two-column grid on a phone, and the two panels that draw it fold at different widths (Forks at 560 px, with four cells;
 * Unconverted at the drawing's 760 px, with the rest of its phone layout), so the phone rules are {@link reviewSegmentedPhone}, asked for the width.
 *
 * `review-tab.component.ts` still carries its own copy of the card rules for the Duplicates and Suggestions cards (the origin the Contradictions copy
 * was made from); it is not one of the three panels this was extracted from.
 */

/** One radio group of cells, each with an optional count: the kind switch of Forks and the class switch of Unconverted. */
export const REVIEW_SEGMENTED_STYLES = `
    .sg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--bg-surface); }
    .sg-opt { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 7px 16px; min-height: 36px; font: inherit; font-size: 13px; font-weight: 500; color: var(--text-secondary); background: transparent; border: none; border-left: 1px solid var(--border); cursor: pointer; white-space: nowrap; }
    .sg-opt:first-child { border-left: none; }
    .sg-opt:hover { color: var(--text-primary); background: var(--bg-elevated); }
    .sg-opt[aria-checked="true"] { color: var(--text-primary); background: var(--bg-overlay); box-shadow: inset 0 -2px 0 var(--accent); }
    .sg-n { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-muted); }
    .sg-opt[aria-checked="true"] .sg-n { color: var(--text-secondary); }
    /* The app has no global focus ring, so the control draws its own. */
    .sg-opt:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
`;

/**
 * The control on a phone: a 2 x 2 grid below `maxWidthPx`.
 *
 * A function DECLARATION whose body is one `return`: a component's `styles` are evaluated at build time by Angular's static evaluator, which
 * reads such a function and refuses an expression-bodied arrow ("Failed to resolve styles ... to a string", NG1010; the production build
 * failed on it while every spec passed). `typecheck:client` runs that compiler, so a second such helper fails there.
 */
export function reviewSegmentedPhone(maxWidthPx: number): string {
  return `
    @media (max-width: ${maxWidthPx}px) {
      .sg { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
      .sg-opt { border-left: none; border-top: 1px solid var(--border); justify-content: space-between; }
      .sg-opt:nth-child(-n+2) { border-top: none; }
      .sg-opt:nth-child(even) { border-left: 1px solid var(--border); }
    }
`;
}

/** The finding card of a Review queue: the grid of cards, a card's head (the type and when), and the record boxes inside it. */
export const REVIEW_CARD_STYLES = `
    .dup-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-top: var(--rv-grid-top, 16px); }
    .dup-card { border: 1px solid var(--border); border-radius: 10px; background: var(--bg-surface); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .dup-card-h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
    .dup-type { color: var(--text-secondary); font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; }
    .dup-when { color: var(--text-muted); font-size: 11px; margin-left: auto; }
    .dup-rec { border: 1px solid var(--border-muted); border-radius: 8px; padding: 8px 9px; background: var(--bg-primary); min-width: 0; }
    .dup-rec-l { font-size: 10px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
    .dup-rec-txt { font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text-primary); }
`;
