/**
 * The z-index of every full-screen layer a dialog or a drawer paints, in one place.
 *
 * What it prevents: a dialog opened from inside a drawer or a popup painting UNDER it. The history dialog (Q-744) is a page-level
 * `.dialog-backdrop` (level `dialog`, 100); the record drawer's overlay and the space settings popup are level 200. Opened from the
 * drawer's Compare or from the settings popup's Schema tab, the dialog sat beneath the layer that hosts it: that layer covered its
 * Close button and its Open links, and only Escape worked. Each level used to be a number written in a stylesheet of its own, so
 * nothing said they were ordered; `stacking.spec.ts` now fails when a dialog hosted in a drawer or popup is not above it.
 *
 * - `dialog`: a dialog opened from a page.
 * - `drawer`, `popup`: a layer that hosts other components (the record drawer, the space settings popup).
 * - `hostedDialog`: a dialog opened from inside a `drawer` or a `popup`. Above both, and above the popup's own confirmation layers (320).
 *
 * The CDK overlay (confirmations, 1000) and toasts sit above all of these.
 */
export const STACK = {
  dialog: 100,
  drawer: 200,
  popup: 200,
  hostedDialog: 330,
} as const;
