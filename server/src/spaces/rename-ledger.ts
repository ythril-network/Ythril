/**
 * What one attempt of a space rename moved, and the calls that move exactly that back (Q-978).
 *
 * ## What it prevents
 *
 * A rename that the store refused part-way used to stop where it was: the collections moved, the counter, the change-feed floor
 * and the files directory under either name, and every document still carrying the old `spaceId`. The answer was the store's
 * refusal and said none of it, so a space stood split across two names with nothing that showed it. Now each step of the rename
 * records, in this ledger, what it moved and how to put it back, and a rename that is refused moves back what it moved, last
 * step first, before it answers.
 *
 * ## The guard a hand-written copy drops
 *
 * **The step that is refused last.** The ledger is read by the one place that ends a rename that did not commit
 * (`renameSpaceInner`'s end), which asks it whatever failed: a step, or the config write that commits the rename. A step that is
 * not in the ledger is never undone, and a step is put in it by its own code, beside the call that moves, so a step added later
 * is in or out of the ledger by the line that adds it.
 *
 * **Undoing stops at the first step that cannot be undone.** Later steps stay as they are: undoing a step before the ones that
 * came after it can leave a counter under the new name with the collections back under the old one, and a space whose counter
 * restarts at 1 never pushes to its peers again. What stays moved is then a consistent prefix of the rename, which the same
 * rename repeated finishes.
 */
import { log, peerText } from '../util/log.js';
import { isStoreSide } from '../brain/store-failure.js';

export class RenameLedger {
  private readonly done: Array<{ label: string; back: () => Promise<void> }> = [];

  /**
   * A step moved something. `label` is what an operator reads of it; `back` moves exactly that back, and throws when it cannot.
   * Called once the step succeeded, except for a step that can stop half-way having changed part of what it covers: that one is
   * recorded before it runs.
   */
  did(label: string, back: () => Promise<void>): void {
    this.done.push({ label, back });
  }

  /**
   * Move back everything recorded, last first. Returns the labels of what stays moved, in the order the rename moved it: empty
   * when everything is back. Never throws: a step that cannot be undone ends the undoing and is said in the log, without the
   * driver's text (the door's own line is the one place that text belongs).
   */
  async moveBack(): Promise<string[]> {
    while (this.done.length > 0) {
      const step = this.done[this.done.length - 1]!;
      try {
        await step.back();
      } catch (err) {
        log.error(`A refused rename could not move back '${peerText(step.label)}': ${isStoreSide(err) ? 'the store refused it' : peerText(err)}`);
        break;
      }
      this.done.pop();
    }
    return this.done.map(s => s.label);
  }
}
