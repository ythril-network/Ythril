/**
 * Does a converge of the RDF import leave the stored record as it is: then nothing is written for it (bundle-270, fix round 4, finding R3).
 *
 * ## What it prevents
 *
 * - **A rewrite for a file that stated nothing new.** A space's own export imported into it converges every record onto itself, and the planners'
 *   converge always writes (`brain/fact.ts`: a retried create "is not a no-op", `updatedAt` and `seq` move, an embed job is queued): each record got a
 *   new position, a new modified time, an embed job and so sync traffic. That is the single-record doors' rule and their tests hold it, so the
 *   planners keep it; the import, whose file states what is and never asks for a write, hands the commit only the converges that change something.
 * - **A rewrite for a difference the file never stated.** The comparison is the planners' own result against the stored record, on the fields a
 *   write can state (`convergeChanges`), and the translator already fills every field the file does not state from the stored record. So a property
 *   the export leaves out, a tag list in the stored order, a number the file writes as `36.0` where `36` is stored, a record stored with no tag list
 *   or no property bag where the plan leaves an empty one, all read the same and are no change. Server-owned fields (`updatedAt`, `seq`, the stamp, the vector) are the write's own, never a difference.
 * - **A link the file adds called unchanged.** A fact's and a chrono entry's converge rewrites the link rows from the plan's desired set; a stored
 *   row the set leaves out is taken away and a row it adds is made, and both are a change. A record whose stored links could not be read whole
 *   is never called unchanged.
 *
 * Pure: it reads the plan and the stored record the caller handed it, and writes nothing.
 */
import { convergeChanges, type DesiredLinks, type PlanLike } from '../brain/write-plan/converge-changes.js';

/** A stored record a converge addresses, read BEFORE its plan was made (the read set holds the record as planned afterwards): its document and, for a kind that holds links, its link rows. */
export interface ConvergeBefore {
  doc: Readonly<Record<string, unknown>>;
  links?: DesiredLinks;
}

/** Whether `plan` is a converge that changes nothing `before` does not already say: no stated field, no link row. */
export function changesNothing(before: ConvergeBefore | null, plan: PlanLike): boolean {
  if (plan.op !== 'converge' || before === null) return false;
  // A record stored without tags or properties (a chrono entry, a fact, an edge written with neither) and a plan that leaves an empty list and an empty
  // bag say the same thing: an absent field is an empty one, never a difference the file stated.
  const doc = { ...before.doc, tags: before.doc['tags'] ?? [], properties: before.doc['properties'] ?? {} };
  const changes = convergeChanges(doc, plan, before.links);
  if (changes.changed.length > 0 || changes.removed.length > 0 || Object.keys(changes.linksTakenAway).length > 0) return false;
  if (plan.links === undefined) return true;
  // The plan names link classes: what it names must be known, and every end it wants must already be a row.
  if (before.links === undefined) return false;
  for (const [kind, wanted] of Object.entries(plan.links.desired)) {
    const have = new Set((before.links as Record<string, readonly string[] | undefined>)[kind] ?? []);
    if ((wanted ?? []).some(id => !have.has(id))) return false;
  }
  return true;
}
