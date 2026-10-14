import { DestroyRef, inject, signal } from '@angular/core';

/** How long the region stays empty before the sentence is put back, so the empty state is drawn and the change is a real one. */
export const EMPTY_FOR_MS = 100;

/**
 * What a polite live region speaks, and the one way to make it speak the SAME words again.
 *
 * A screen reader announces a live region when its text CHANGES. A page that sets a signal to the sentence it already holds changes
 * nothing, so the second "Deleted report.txt" (a file of that name, deleted in another folder a minute later) was never heard, and
 * nothing on the screen said so. {@link say} empties the region first and puts the sentence back after a gap, so every call is a
 * change, repeated or not. A page keeps one of these and binds `text()` in a `role="status" aria-live="polite"` element that is
 * always in the DOM (a live region that appears together with its text is not announced either).
 *
 * Construct it in an injection context (a field initialiser): the pending put-back is dropped when the owner is destroyed. A call
 * made while one is pending replaces it, so the region only ever ends on the latest sentence.
 */
export class LiveAnnouncement {
  /** The text for the live region. Empty between two announcements. */
  readonly text = signal('');
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  say(sentence: string): void {
    clearTimeout(this.timer);
    this.text.set('');
    this.timer = setTimeout(() => this.text.set(sentence), EMPTY_FOR_MS);
  }
}
