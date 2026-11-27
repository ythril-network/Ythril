/**
 * Bring an element into view inside the container that scrolls it, and focus it without a second scroll.
 *
 * ## What it prevents
 *
 * - **A card left out of view by the dialog it sits in.** A link that opens the Settings dialog on one card (the Overview's "Open RDF names")
 *   needs the dialog's own body scrolled, not the page: the card sat 1272 px down a 1280 px window under a dialog that ends near 1248, and
 *   at 390 px 1713 px down a 1700 px one, focused and not seen. The scrolling ancestor is found and scrolled to the element's top.
 * - **A smooth scroll cut short by the focus that follows.** `focus()` scrolls too, and starts over; the scroll here is instant and the
 *   focus asks for none.
 */

/** The margin kept above the element, in pixels. */
const TOP_MARGIN = 8;

/** The nearest ancestor that scrolls vertically, or null when only the page does. */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

/** Scroll `el` to the top of its scrolling container and focus `focusTarget` (default `el`) there. */
export function showAndFocus(el: HTMLElement, focusTarget: HTMLElement = el): void {
  const box = scrollParentOf(el);
  if (box) {
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - TOP_MARGIN;
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    else box.scrollTop = Math.max(0, top);
  } else {
    el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
  }
  focusTarget.focus({ preventScroll: true });
}
