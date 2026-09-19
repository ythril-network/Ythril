/**
 * No file grows past the largest we already have, measured in CODE lines.
 *
 * ## Why not raw lines
 *
 * This codebase comments heavily and deliberately. Ranked by raw line count, its two best-documented modules
 * come second and fourth — `config/types.ts` at 1,986 lines is **62% comment**, `brain/recall.ts` at 1,299 is
 * **36%**. A gate built on raw lines would call those the worst files in the repo and the remedy it invited
 * would be deleting the explanations. That is the opposite of what this project wants, and a gate whose fix
 * makes the code worse is one people are right to ignore.
 *
 * Stripping comments and blanks changes the ranking, which is the measurement worth having: `types.ts` falls
 * from 2nd to 11th, `recall.ts` from 4th to 9th, and what rises is a handful of Angular components carrying
 * 6–12% comments and over a thousand lines of code each.
 *
 * ## Why a ratchet rather than a refactor
 *
 * "This component is large" is not a defect. It works, it is covered, and splitting it is a change with real
 * regression risk that nobody asked for. What IS worth guaranteeing is that it stops growing — the failure
 * mode of a god-file is not its size on any given day, it is that every change lands in the same place
 * because that is where the code already is.
 *
 * So: the files already over the line are frozen at their current size, everything else has a ceiling, and
 * both numbers are visible. Reducing one is welcome and only requires lowering its entry.
 *
 * Run: node --test testing/standalone/no-new-god-files.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Source files that carry behaviour. Specs are excluded — a long test file is usually a thorough one. */
function sourceFiles() {
  return trackedSources(['server/src', 'client/src'])
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'));
}

/** Lines that are neither blank nor comment. Block comments are tracked across lines. */
function codeLines(src) {
  let n = 0, inBlock = false;
  for (const raw of src.split('\n')) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (!t) continue;
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    n++;
  }
  return n;
}

/**
 * Ceiling for a file with no entry below. Set just above the largest file that is NOT already frozen, so a
 * new module has room to be substantial without becoming the next thing on this list.
 */
const CEILING = 650;

/**
 * Files already above the ceiling, frozen at their measured size (2026-08-06).
 *
 * Not an allowlist of things that are fine — a list of what is large, kept visible. Lower a number when a
 * file shrinks; raising one is a decision to make deliberately and to say why in the commit.
 */
const FROZEN = {
  // 676 -> 502. It crossed the 650 ceiling when the rights matrix was wired in, was frozen with a note
  // saying the number should go DOWN rather than up again, and the create dialog came out (Q-5).
  //
  // It is now UNDER the ceiling and stays on this list on purpose: an entry here is a ratchet, and removing
  // it would hand the file back the 148 lines of headroom the extraction just removed. The dialog it lost
  // lives in `token-create-dialog.component.ts` at 207.
  // 502 -> 526: the per-row "edit rights" action, its state, and the saved handler. The DIALOG went to
  // `token-rights-dialog.component.ts`; what landed here is the entry point, which belongs to the page that
  // owns the rows. Raised rather than worked around — hiding a row action somewhere it does not belong to
  // keep a number down is the trade this list exists to let us decline.
  // 526 -> 532: the danger zone moved into the token editor, which added the routing method the editor emits
  // into plus its two bindings. Six code lines.
  //
  // Note the direction this file COULD go instead: rotate and revoke are now in the editor, so the two row
  // icons on the list are a second way to reach the same actions and removing them would pay this back with
  // change to spare. Not done here, because dropping a familiar affordance from a page is the owner's call and
  // not a side effect of adding one elsewhere. Recorded under G-1.
  // 532 -> 341 on 2026-08-12. The own-rights panel pushed this file 8 lines past its ceiling, and the ratchet's
  // own rule is to pay that with an extraction rather than raise the number: 199 lines of CSS moved to
  // `tokens.styles.ts`, beside the `dialog.styles.ts` already there. Lowered to what it now measures and KEPT,
  // because deleting the entry is how a file quietly earns the right to grow back.
  // RAISED 341 -> 343 to move the permission pill off the removed `admin`/`readOnly` flags: one import
  // and one accessor. A template needs its callable on the component, so the accessor cannot live in the
  // shared helper — it is a one-line arrow, and the reasoning went into a TS comment because the prose
  // would otherwise sit inside the template STRING and count as code. The flags could not express a
  // per-space grant, so the pill labelled a token that can write in one space "read-only".
  // NO DECOMPOSITION: 343 code lines is not a god file, and the raise was two lines moving a permission
  // pill onto the rights matrix. Splitting a page this size costs a reader more than it saves.
  'client/src/app/pages/settings/tokens.component.ts': 275,
  // `client/src/app/pages/files/file-manager.component.ts` WAS HERE, at 1 618 code lines, and it was the
  // largest file in the repository. It came off this list on 2026-09-03 at 591 — under the ceiling, so it
  // is no longer a god file and no longer needs an entry.
  //
  // **Thirteen cuts, and the entry is DELETED rather than kept at a low number**, because this map is what
  // is large right now and not a monument to what used to be. The story of the cuts is in the CHANGELOG,
  // which is where a reader goes for what happened; what belongs here is only what is still over the line.
  //
  // Worth one sentence, because the shape will turn up again: the last four cuts were the ones that
  // mattered and they were the ones nobody had taken. Chasing "how many API calls does this page still
  // make" moved 65 lines; a THIRD of the file was its inline template and stylesheet, which no store
  // extraction could reach, and taking those out as two components is what ended it.
  'client/src/app/pages/schema-library/schema-library.component.ts': 1112,
  // RAISED 966 -> 975 for `P-32`: a sixth sync family. The push call, the pull call, both watermark
  // entries, and the two signatures widened to accept it — every line of it is the engine deciding what
  // crosses the wire, which is what this file is for. The MERGE it needs is already elsewhere:
  // `applyFileMetaPage` lives in `api/sync/_shared.ts` beside the push path's `ingestFileMeta`, so the two
  // directions share one implementation instead of this file holding a second.
  //
  // NO DECOMPOSITION: PAID. This raise owed `A-12`, and it has shipped — so the marker is the settled form
  // the three raises above use, not an annotated live one.
  //
  // The six families were written out TWICE in this file, once as `pullType` calls with their
  // result plumbing and once as `pushCollection` calls, so a seventh was six edits. The shape it asked for
  // — a table of `{ collection, payloadKey, extraFilter }` iterated by both halves — shipped as
  // `sync/replicated-families.ts`, OUTSIDE this file, because a refactor that made the engine bigger would
  // have charged the raise a second time.
  //
  // **Do not write the OPEN marker keyword here in order to retract it.** `todo-consistency.mjs` reads that
  // keyword as a claim that the task is still owed and checks its id against the queue — it cannot tell a
  // live marker from one being quoted to say it is finished, so quoting it re-arms a settled debt and then
  // fails against a task that has correctly LEFT the queue. Written the wrong way round first, and both
  // gates said so in turn: the open keyword failed `todo:check`, and dropping every marker failed the
  // "every raise is answered" case here. The settled form answers one and is invisible to the other, which
  // is why it exists; the account of what the debt cost belongs in prose beside it.
  //
  // RAISED 975 -> 979 for `Q-2`, and the four lines ARE the fix. Each direction now builds its transfer
  // set once, as a named object, because the alternative was what was there: the set inline in one
  // argument and a SECOND hand-written list of the same families in the next one. Pull's had six entries
  // and push's five, so file metadata could hold that watermark back and never advance it, and a cycle
  // whose only change was file metadata re-sent the same page for ever. A third list — the local seq bump
  // — omitted it too.
  //
  // Reclaimed seven of the eleven by formatting and by moving the whole-file transfer budget into
  // `peer-fetch.ts`, where the file that owns each budget's meaning can hold the rule. The rest was paid
  // back by the decomposition above, which deleted both enumerations rather than shortening them.
  //
  // RAISED 979 -> 984 for `N-1`, the peer version floor. Five lines: the import, one call to
  // `assertPeerAtFloor`, our version on the outbound self-record, and storing the version a peer
  // piggybacks back. The comparison, the refusal text and the config re-read all live in
  // `sync/peer-floor.ts` — this file holds only the two lines that say WHERE in the cycle the floor
  // applies, which is a fact about the cycle and cannot move out of it.
  //
  // Paid back by the decomposition above, which deleted both six-family enumerations rather than
  // shortening them.
  //
  // 984 -> 986 with the same PR, after CI refused the first rule: the two lines are the
  // `versionCheckedAt` stamp and its `changed` flag, written on the exchange whether or not a version
  // came back. That stamp is what separates 'answered and named none' from 'never exchanged with' —
  // conflating them refused every asymmetric network for ever, so this is the fix rather than growth.
  'server/src/sync/engine.ts': 986,
  // 958 -> 684: the per-type editor body moved into `schema-type-editor.component` so the Brain Overview
  // could open the same editor. Lowered rather than left — a frozen number 274 lines above the real size
  // is 274 lines this file could regrow into without the gate saying a word.
  // RAISED 684 -> 685: ONE LINE, `G-12` — the binding that hands the shared type editor the space's
  // entity type names, which is the vocabulary an edge label's ends are picked from. It belongs to the
  // host by construction: the editor has two of them and neither one's state service is injectable from
  // the other, which is why the editing operations are pure functions in the first place.
  //
  // NO DECOMPOSITION: the body of this tab already LEFT — the per-type editor is `schema-type-editor`,
  // which is what made this a one-line change instead of a fifty-line one. What remains is the tab's own
  // shell: the collection sub-tabs, the type list, the import/export toolbar and the save. 685 code lines
  // is not a god file, and splitting a page this size again costs a reader more than it saves.
  //
  // 685 -> 690 (2026-09-17, `B-18`). A type could not be RENAMED — the name is a map key, so the
  // editor offered add and delete and nothing between, and a spelling mistake cost every property on
  // the type. THE DECOMPOSITION THIS GATE ASKS FOR WAS DONE: the name and its edit affordance are
  // `schema-type-name.component.ts`, which took the edit mode, the draft, the refusal message and the
  // commit rules out of here. What is left is five lines of wiring — one element in the template and
  // the closure that tells it what a rename means to this host — and those cannot be split from the
  // thing they wire. Raised rather than worked around.
  'client/src/app/pages/settings/space-schema-tab.component.ts': 690,
  // 839 -> 843: `typeSchemasMode` on the update body and the replace branch in `mergeSpaceMeta`. Both are
  // small and belong beside the merge they qualify — splitting a two-branch decision across files would
  // make the contract harder to read, not easier.
  // 843 -> 844: one Zod line accepting `faceDescriptorDims` on the CREATE body. It is on the UPDATE body too
  // now — refused by state rather than by surface, see `face-width-refused-by-state-not-surface.test.js` —
  // which is a second Zod line in the same file, and both schemas are `.strict()` so there is nowhere smaller
  // to put either.
  // RAISED 844 -> 847 for `suppressEmbeddings`: the field on `SpaceMetaBody`, the field on `TypeSchemaZ`, and the
  // `!== undefined` merge guard. Both schemas are `.strict()`, so an unlisted field is REJECTED rather than
  // ignored — there is no "put it beside this file" for a field the API must accept. Raised rather than split
  // because this is its FIRST raise; `config/types.ts` is the cautionary case, and the rule stands: a fourth
  // raise of one file is the signal to split it instead of raising a fifth time.
  // RAISED 847 -> 849 for the re-embed route: an import and a registration call, nothing else. Inline it was
  // +28 (route body plus its Zod schema), which would have been the SECOND double-digit raise of this file in two
  // PRs — so the route moved to `api/spaces-reembed.ts` instead and only its mount point stayed. That is what the
  // ratchet is for: not to forbid growth, but to make the second raise in two PRs visible enough to answer.
  // RAISED 849 -> 851 for the usage-reset route: an import and a registration call, nothing else. The route
  // body itself is +47 lines and lives in `api/spaces-activity.ts`, the same shape `spaces-reembed.ts` took and
  // for the reason written above it — this file has been raised four times, and the answer to the fifth is to
  // put the route beside its mount point rather than inside it.
  //
  // 851 -> 656, and this is the raise being PAID rather than taken. Four of the five raises above were Zod lines,
  // because `SpaceMetaBody` and `TypeSchemaZ` are `.strict()` and an unlisted field is REJECTED — so there was no
  // "put it beside the feature" for a field the API must accept. The schemas were what kept pulling this file up,
  // so the schemas left: `spaces/body-schemas.ts`. The PATCH decision chain went to `spaces/meta-update.ts` in the
  // same change, because an MCP tool has to reach the same refusals rather than a weaker copy of them (B-2).
  // Lowered to what it now measures and KEPT on this list — deleting the entry is how a file quietly earns the
  // right to grow back into 195 lines of headroom it did not ask for.
  //
  // 656 -> 589 in the follow-up: `applySpaceMetaUpdate` took the writes as well, so `PATCH /:id` is now the two
  // jobs a route should have — read the header, turn an outcome into a status. The 67 lines are the vote round and
  // the peer notify, which moved because the MCP tool needs them and a tool that skipped the vote would be a
  // governance bypass rather than a missing feature.
  // NO DECOMPOSITION: already PAID, 851 -> 656 -> 589, by moving two route bodies out to `spaces-reembed.ts`
  // and `spaces-activity.ts` and keeping only their mount points. This is the answer the rule asks for,
  // done rather than queued.
  'server/src/api/spaces.ts': 589,
  // 769 -> 773: `openBrainDrawer` gained two overload signatures and its `lastSaved` effect reads the
  // record inside each branch so the discriminant narrows it. Four lines of TYPES, no new behaviour —
  // raised deliberately rather than worked around, which is what this list is for.
  // RAISED 773 -> 774 for one import. `canEdit` moved off `me.readOnly` onto the rights matrix, and the
  // import is the whole cost — the alternative is inlining the predicate, which is a second copy of a
  // rule the server already owns.
  // RAISED 774 -> 793 for L-12: tapping a chrono/memory/file node or a synthetic edge opened an empty panel,
  // because every tap fetched an entity. The DECISION — which collection, or why none — was extracted to
  // `graph-record-lookup.ts` first, where it is a pure function with its own spec; what remains here is the
  // wiring and one template block, and there is no version of the fix that adds nothing to this file.
  //
  // This is the largest raise on the list by an order of magnitude, and it is the signal the list exists to
  // give: the component cannot absorb behaviour any more.
  //
  // NO DECOMPOSITION: PAID, twice over. This raise owed G-2, which took the two record cards out (793 -> 688),
  // and then G-7, which took the panel headers and the toolbar and deleted six members nothing read
  // (690 -> 641). The file is now UNDER the 650 ceiling.
  //
  // The marker was CHANGED rather than deleted: a closed task cannot stay named on a raise, because the
  // tracker rule checks that every id named this way is actually in the queue — and an id that is not is
  // indistinguishable from one that was never filed.
  //
  // Note for whoever edits this next: that rule matches the marker pattern anywhere in this file, prose
  // included, so a sentence merely QUOTING a retired marker fails the check. Write the id and the word apart.
  //
  // 793 -> 688. G-2 PAID. It was TWO cards, not one, and ~115 lines rather than ~87: the node card and its
  // near-twin for edges, now `app-graph-node-record-card` and `app-graph-edge-record-card`. Their style rules
  // moved with them — a parent's styles do not reach a child's template, and `.record-card`'s `flex: 0 0 50%`
  // is what makes the panel two columns.
  //
  // The entry STAYS, lowered rather than deleted, for the reason written above `brain.component.ts`: an entry
  // here is a ratchet, and removing it would hand this file back the 105 lines the extraction just took away.
  // It is still over the 650 ceiling, so the next reader can see there is more to take out.
  // 688 -> 689: ONE line, and it is the G-5 fix reaching the card — the `[kind]` binding, without which the
  // branch on kind is inert and a memory still renders a blank name. Raised without argument, for the reason
  // written above `brain.component.ts`: a ratchet that made a one-line bug fix negotiable would be a gate
  // encouraging the wrong outcome. G-7 stood at the time and has since been paid.
  // 689 -> 690: ONE line again, the `[unavailable]` binding that lets the EDGE card say why a synthetic edge
  // has no record. Without it the branch exists and nothing feeds it — the same inert-wiring shape as G-5's
  // `[kind]`, which is why both are pinned by a rendering test rather than a method call.
  // 690 -> 641, and UNDER the 650 ceiling for the first time since it went on this list (G-7 paid).
  //
  // Three things, not one. The two panel headers became `graph-panel-header.component.ts` — one bar rendered
  // twice, differing in a title, a badge and whether the eye button shows. The toolbar became
  // `graph-toolbar.component.ts`, the largest self-contained block left. And six members were deleted because
  // nothing read them: `panelTitle` was computed for exactly this extraction and never wired in, while both
  // headers hand-wrote the same expression; `toggleSort` and `sortArrow` were left behind when the detail
  // table moved to a child that does not sort, and were still covered by four passing specs.
  //
  // The entry STAYS at the real number rather than being deleted, for the reason written above
  // `tokens.component.ts`: removing it would hand the file back the 49 lines the extraction just took.
  // RAISED 641 -> 642: ONE LINE, and it DELETES a copy. The popup's type was the four knowledge kinds
  // written out locally; it now imports the union. The import line is the whole raise.
  // NO DECOMPOSITION: this is the opposite of the growth this list exists to catch — a local duplicate of a
  // shared vocabulary became a reference to it, and the file is 8 lines over a ceiling it was already over.
  // Splitting a page for one import would cost a reader more than it saves.
  'client/src/app/pages/graph/graph.component.ts': 642,
  // 753 -> 764: `backfillTokenRights`. This file is where config migrations already live — the media
  // master-switch and space-description ones are both here — so a fourth belongs beside them rather than in
  // a module only the loader would ever call.
  'server/src/config/loader.ts': 764,
  'client/src/app/pages/brain/review-tab.component.ts': 748,
  // 744 -> 689, and this one is PAID rather than raised.
  //
  // The history matters because the pattern is what goes wrong: 739 -> 744 was a raise, taken deliberately to
  // ship a 5x embedding fix an operator was already paying for, with the debt recorded instead of forgotten.
  // The four pure functions — merge, rank, and the two text projections — then moved to `recall-shape.ts`,
  // which took 124 lines out and left the part that genuinely needs a database.
  //
  // Frozen at what the file now IS, not at the old ceiling. A freeze left above the real number is a budget
  // for the next 55 lines nobody argued for.
  // 689 -> 690: ONE line, and the reduction from four is the point.
  //
  // Widening recall's filter to accept raw MongoDB first threaded a second `mongoFilter` parameter through three
  // signatures — four added lines, and this gate objected. It was right to: the behaviour belonged beside this file, not
  // inside it. It lives in `recall-filter.ts` now, and the two grammars travel in ONE parameter, which is a smaller design
  // than two mutually-exclusive channels a reader has to know about.
  //
  // What is left is the import of `isRawFilter` and its type. A file cannot use a guard without importing it, so this line
  // is the irreducible cost of the feature reaching the code that runs it.
  // 690 -> 683. `DupeCheckOpts` moved to `write-options.ts`, and it is a WRITE type: five writers and the
  // write routes' shared helper import it, while this file only declared it. Adding one optional field —
  // the record tier of `suppressEmbeddings`, which no create could state — pushed this file past its
  // freeze, and that was the gate working: every addition to what a CREATE accepts had been landing in the
  // recall module because that is where the type already was.
  //
  // Lowered rather than raised, which is the outcome this list is for.
  // RAISED 683 -> 684: ONE LINE, and it deletes a copy. `RecallKnowledgeType` was the five record kinds
  // written out here; it is now an alias of the one tuple, and the import line is the whole raise.
  // NO DECOMPOSITION: this is the opposite of the growth this list catches — a local duplicate of a shared
  // vocabulary became a reference to it. `recall.ts` is 34 over a ceiling it was already over, and the
  // seed traversal already moved out to its own module.
  // RAISED 684 -> 686 for `P-34`: TWO LINES, and each one closes a defect rather than adding behaviour.
  // `MAX_PER_TYPE_CANDIDATES` is the absolute bound the per-type over-fetch never had — the owner's
  // ruling removed the ceiling on `topK`, and a fetch that scales off it without a limit of its own is an
  // oversized request becoming an oversized query. `includeFreshWrites?: boolean` on `recallGlobal`'s
  // options is the other: the MCP tool's cross-space branch had nowhere to put that flag, so the one
  // parameter whose purpose is "find what I just wrote" was silently inert on the idiomatic call.
  // NO DECOMPOSITION: two declarations, one a constant with its reasoning attached. Splitting a file to
  // house a number is the make-work this list's own rule warns against, and the real decomposition of this
  // module already happened — the seed traversal is its own module and the create-shape vocabulary moved
  // out, which is what took it from 718 down.
  // RAISED 686 -> 689 for `F-26`: TWO IMPORTS AND A CONTINUATION, and there is no smaller form.
  // A chrono hit's status is now resolved per TYPE, and the one thing this file must not do is resolve it
  // itself — a `?? 'overdue'` here would be the second implementation, and the symptom is a recall hit
  // disagreeing with a direct read of the SAME record, which is the defect the owner's ruling was made to
  // end. So it imports the resolver and the existing `getSpaceMeta`, and the reasoning that would otherwise
  // sit here as a comment lives in `brain/chrono-date-policy.ts` beside the function.
  // NO DECOMPOSITION: the alternative to these three lines is not a smaller file, it is a duplicate policy.
  // The real decomposition of this module already happened — the seed traversal and the create-shape
  // vocabulary are their own modules, which is what took it down from 718.
  // 689 -> 690: one parameter. The rerank step could only increment a counter, so a reranker that was
  // unreachable or refusing the batch size reached a dashboard and never the caller — against a
  // `degraded` reason the integration guide already documents. Routing it through the helper that
  // reports both is the whole change; there is no new behaviour here to put beside the file.
  // 690 -> 691: one IMPORT line. `A-5` routes every collection name through `spaceCollection`, which
  // carries the space-id charset check a template string cannot. No behaviour moved into this file —
  // the change is that a name it used to build itself is now asked for.
  'server/src/brain/recall.ts': 691,
  // 678 -> 687: two conditional notices on the face card — the enable pin stating what it does NOT reach, and
  // "configured but not in use" for a stored endpoint awaiting acknowledgement. Nine lines of markup, and the
  // first attempt wanted THIRTY because the reasoning was written as HTML comments inside the template. That
  // was the signal: prose in an Angular template is counted as code AND lexed as markup, and the lexing part
  // had just blinded `infra-managed-locks-every-field` to two enclosing guards. The reasoning moved to a JS
  // doc comment above the class (`FACE_CARD_NOTES`), which is where it was always safer, and what is left is
  // the two blocks a reader has to see to know the notices exist.
  // LOWERED 687 -> 666. Three document cards needed a Save each, which is 27 lines past the freeze — and
  // that is this gate doing its job rather than an inconvenience: the Save block was the SAME FIVE LINES in
  // ten places, differing only in the card id. It is `card-save.component.ts` now, so the tab shrank by more
  // than the three cards added. `display: contents` on that component keeps the button a flex item of the
  // footer row, so every ordering rule that was already there still matches.
  'client/src/app/pages/settings/media-processing/models-tab.component.ts': 666,
  // 675 -> 677: `rights` on TokenRecord, plus its import. FOURTH raise of this file in one session, and the
  // first attempt wanted SIX lines because the shape was written inline. That was the signal, so the shape
  // moved to `config/rights-shape.ts` — a leaf both this file and `auth/` can import without a cycle — and
  // what is left here is one field and one import. The answer to a file that keeps growing is to stop
  // putting things in it, not to raise the number again. The domain split is filed in ARCHITECTURE-TODO.
  // 674 -> 675: `spaceOrigins` on NetworkConfig. **THIRD raise of this file in one session** (672 -> 673 ->
  // 674 -> 675), and that is the signal this list exists to send rather than a run of bad luck. Each was one
  // honest line of type whose behaviour lives elsewhere, and each was individually correct — which is
  // precisely how a god-file grows. Filed as work in ARCHITECTURE-TODO: this file is the config CONTRACT for
  // every subsystem, and it wants splitting by domain, not another line.
  // 673 -> 674: `faceDescriptorDims` on SpaceConfig. One line of type again, and the behaviour it names is
  // in `vector-index.ts` and `lifecycle.ts`. A space's shape belongs in the space's type; the alternative is
  // a side-table of per-space settings, which is a worse trade than one line.
  // 672 -> 673: `allowInProcessFallback` on `faceRecognition.externalModel`. ONE line of type, and the
  // behaviour it names lives in `face-external.ts` and `face-embedder.ts`, not here. The alternative —
  // a face-only config module re-exported from this file — would split the config contract across two
  // places to save a single field, which is the trade this list exists to let us decline.
  // LOWERED 677 -> 645 (Q-3, slice 1). The knowledge-schema vocabulary — merge functions, `PropertySchema`,
  // `TypeSchema`, `ValidationMode`, `KnowledgeType`, `SpaceMeta` — moved to `config/types-knowledge.ts`, a leaf
  // that imports nothing. This entry took FOUR raises in two days and the comment below said the fifth should
  // be a split instead; that is this. The number matters less than where the growth now goes: per-type schema
  // fields land in the leaf, so Q-2's `suppressEmbeddings` is not a fifth raise of this file.
  // LOWERED 645 -> 578 (Q-3, slice 2). The network types moved to `config/types-networks.ts`, which imports
  // `SpaceMeta` from the slice-1 leaf rather than back from `types.ts`. 677 -> 645 -> 578 across the two slices,
  // and the first attempt at this move — before the leaf existed — reached 609 while silently degrading
  // `NetworkConfig` to `any` in a caller. The number was never the point; where the growth goes is.
  // RAISED 578 -> 579 for `FileMetaDoc.sha256`: one optional field, and there is nowhere else a field on a
  // document type can live. It is what lets the media dispatcher tell identical bytes from new ones, so a
  // re-upload stops re-running vision and speech-to-text over content already embedded. Optional on purpose:
  // absent means "unknown", which processes rather than assumes, and it fills itself on the next write —
  // file records SYNC, so a boot migration would have been the wrong shape.
  // NO DECOMPOSITION: a type file grows with the domain it types, and the raise was ONE optional field on a
  // doc type. Splitting shared interfaces by size would put a record's fields in a different file from the
  // record, which is worse to read and worse to keep correct.
  // RAISED 579 -> 580 for `LinkDoc`, twelve lines of one new record type. The file was at 568 when this was
  // measured, so the recorded ceiling had eleven lines of slack in it and the true growth is twelve.
  // NO DECOMPOSITION: the argument above still applies and this is the case it was written for — a record's
  // fields belong in the same file as the records it is deliberately not. `LinkDoc` exists to say what an
  // `EdgeDoc` is not, and reading the two apart is how they drift back together.
  // RAISED 580 -> 581 for `SpaceConfig.completeLinkage`, one optional field. Same answer as `sha256` above and
  // for a sharper reason: WHICH interface a flag sits on IS the behaviour here. `SpaceMeta` is voted and
  // applied network-wide, `SpaceConfig` is local — so moving this field to save a line would arm one
  // instance's conversion marker on peers that had converted nothing. There is no smaller place for it.
  // RAISED 581 -> 582 by ONE line: `CHRONO_STATUSES` becomes a TUPLE and `ChronoStatus` derives from it.
  // The five status names were written out FIVE times across the server — the REST route, the batch
  // importer and three MCP schemas — and a sixth copy in the shared write-shape table had `ongoing` and
  // `unknown` where the product has `active` and `overdue`. Every unit test passed, because they assert
  // that a BAD status is refused and a wrong list still refuses bad ones; a Docker suite asking for
  // `status=overdue` is what found it.
  // NO DECOMPOSITION: a union type cannot be iterated at run time, which is WHY every door built its own
  // list. The tuple has to live beside the type it derives, and that is here.
  // RAISED 582 -> 583 for `FileMetaDoc.seq`, one optional field, and it is the same answer as `sha256` and
  // `LinkDoc` above: a record's fields belong in the file that declares the record.
  // NO DECOMPOSITION: splitting shared interfaces by size would put a record's fields in a different file
  // from the record, which is worse to read and worse to keep correct.
  //
  // It is the ordering primitive `P-32` needed. A file's metadata did not replicate, so it had no place in
  // the seq order — and its absence was also the only lost-update race in the brain collections, since two
  // writers appending to a file's `entityIds` had nothing to order them.
  'server/src/config/types.ts': 583,
  'client/src/app/pages/settings/data.component.ts': 644,
  // RAISED 646 -> 647 by ONE line: the Q-6 narrowing swapped `resolveMemberSpaces` for `memberSpacesForRequest`,
  // and this file no longer needed the old import, so it gained an import line and lost none. Not growth in any
  // meaningful sense — but the ratchet cannot tell a net line from a meaningful one, and quietly special-casing
  // "it was only an import" is how a ceiling stops meaning anything.
  // NO DECOMPOSITION: PAID. This raise owed G-4 — 882 lines total, a router with several route bodies inline,
  // the exact shape `spaces.ts` paid down — and the entry below records what paid it.
  //
  // The marker was CHANGED rather than deleted, as G-7's was: an id named this way must still be in the queue,
  // and one that is not is indistinguishable from one nobody ever filed. Whoever edits this next should write
  // the id and the word apart, because the tracker rule matches the pattern anywhere in this file, prose
  // included.
  // 647 -> 455, and UNDER the 650 ceiling. G-4: the upload route — 196 code lines, by far the largest body
  // here — moved to `files-upload.ts`, and the four request-shape helpers it SHARES with the routes that
  // stayed went sideways into `files-request.ts` rather than travelling with it.
  //
  // Lowered rather than deleted, for the reason written above `tokens.component.ts`: an entry here is a
  // ratchet, and removing it would hand the file back the 192 lines the extraction just took.
  // 455 -> 456: the same single `spaceCollection` import as `recall.ts` above, for the same reason.
  'server/src/api/files.ts': 456,
  // 645 -> 660: the data-model panel’s mount and its card header. The panel ITSELF is a separate
  // component (er-model-panel) and its geometry a separate module (er-layout) — which is what this
  // ratchet asks for. What landed here is the 13 lines that place it in the grid, plus the two inputs
  // it needs. Raised deliberately: refusing would have meant hiding a panel mount somewhere it does not
  // belong purely to keep a number down.
  // 660 -> 601: the statistics strip and the Instance card were deleted (owner, 2026-08-08) — the ER
  // diagram supersedes the counts, and instance identity belongs to the About page, not a space overview.
  // Ratcheted DOWN to what the file now measures, which is what makes this a ratchet: leaving 660 would
  // have handed the file 59 lines of free headroom it did not earn.
  // 601 -> 634 for the usage reset: the button, its confirmation handler, the two inputs and the inline result.
  // The confirmation lives HERE rather than in the shell because this panel already owns the dialog for reindex
  // and retry-failed, and a third destructive action confirming somewhere else would be a second pattern for one
  // decision. Raised rather than split: the alternative was a component wrapping one button.
  'client/src/app/pages/brain/overview-tab.component.ts': 634,
  // FIRST entry for this file: 659, over the 650 ceiling, for the usage-reset handler (request, in-flight flag,
  // result string, reload) and its bindings.
  //
  // It crossed on a ~25-line addition, which is the honest reading: this file was already at 634 and the ceiling
  // was one small feature away. It is the Brain SHELL — it owns the tab strip, the space list, every panel's
  // inputs and eight tabs' worth of load orchestration — so the split that helps is moving a tab's
  // orchestration out, not shaving a handler. That is its own change with its own tests; recorded here rather
  // than done badly in a PR about a button.
  // 659 -> 660: ONE line, and it is a bug fix. The activity loader set its zeroed "nothing was asked" row and
  // returned before clearing its pending flag, so every space with no traffic — and every space just after the
  // usage reset — showed that card spinning for ever. The added line is the settle.
  //
  // Raised without argument. A ratchet that made a one-line fix negotiable would be a gate encouraging the wrong
  // outcome, which is the opposite of what this list is for.
  // 660 -> 571. The Overview panel's five loaders, their signals and the pending flags moved to
  // `overview-data.service.ts` — 136 lines out of the shell, which is now well under the 650 ceiling.
  //
  // The entry STAYS, lowered rather than deleted, for the reason written above `tokens.component.ts`: an entry
  // here is a ratchet, and removing it would hand this file back the 89 lines of headroom the extraction just
  // took away. G-2's own note said to delete it; the precedent in this file is better and wins.
  // RAISED 571 -> 572: one field, `lastAppliedSpaceParam`, so the query-parameter handler can tell a value it
  // has already acted on from a fresh one. The whole fix is that field plus two lines using it.
  // NO DECOMPOSITION: 572 code lines is 78 UNDER the 650 ceiling — this entry is a ratchet on a file that was
  // decomposed to well below the line (G-2, 660 -> 571), not a god file. Queueing a split for one field would
  // make the ratchet argue against the very extraction it is here to protect.
  'client/src/app/pages/brain/brain.component.ts': 572,
  //
  // RAISED 643 -> 650 for `N-1`: the member row now shows WHY a peer is refused on version grounds.
  // Seven lines, and they are the difference between a diagnosable state and an invisible one — a
  // refused peer has no failure streak (nothing was dialled) and no sync timestamp, which is exactly
  // what a brand-new member looks like, so without this row an operator cannot tell them apart from
  // this page at all.
  //
  // DECOMPOSED: the member row left as `network-member-row.component.ts`,
  // taking the failure badge, the endpoint link and its four style rules with it. The page keeps the
  // network-level state it actually owns.
  //
  // Three things in this template are still really their own components — the network card, the vote
  // list and the invite panel. None of them is owed by a raise, so none is queued; the next raise here
  // has three obvious candidates rather than needing one found.
  //
  // 650 -> 598 with `N-2`, which is the raise PAID BACK rather than merely fitted under. The member row
  // is its own component now, and it was the right thing to take out: every new per-member FACT lands in
  // that markup — the peer-floor badge was the second in a year — so the growth was structural.
  //
  // LOWERED rather than left at 650. A frozen number above the real size is that many lines the file can
  // regrow into with the gate saying nothing, which is how a decomposition gets spent twice.
  'client/src/app/pages/settings/networks.component.ts': 598,
  // FIRST entry for this file: RAISED 650 -> 662 for the re-key branch in `updateEdgeById` — the If-Match
  // check that `writeFilterFor` cannot make on a path with no `findOneAndUpdate`, the call, the deleteFields
  // replay onto the moved document, and the metric.
  //
  // The re-key ITSELF is not in this number: it went to `edge-rekey.ts` as its own module, both because this
  // file was at the ceiling and because `merge.ts` is the other caller — importing it from here would put the
  // two largest brain modules in a runtime dependency for one function.
  //
  // The cut this entry called for — filed as A-4 — was MADE; see the 688 -> 487 entry below. It is written
  // without the DECOMPOSE marker on purpose: that marker is a promise of work still owed, and the gate reads
  // it as one, so leaving it here would keep demanding a queue row for something finished.
  //
  // What was left at the time was genuinely two files. `edges.ts` held the edge CRUD and, appended to it,
  // the whole recall seed traversal — `SeedTraverseNeighbor`, `frontierEdgeQuery`, `traverseFromSeeds`,
  // `traverseRecallSeeds`, `stampTruncation` and the two hop types. That second half has one consumer
  // (`graph-spill.ts` → recall) and no edge-write path touches it, which is what makes it a clean cut rather
  // than a shuffle. It is queued rather than done here because a PR that re-keys edges and moves 150 lines of
  // traversal in the same diff is two reviews wearing one hat.
  // 662 -> 672, and RAISED for a correctness fix found in review before this shipped. The re-key on the PATCH
  // path is a delete and an insert, and it ran outside any transaction — a failure between them left the
  // caller's relationship in NEITHER id. `merge.ts` already wrapped its re-keys; this path had nothing. The
  // added lines are the session, the `withTransaction` and its `finally`.
  //
  // Raised without argument, for the reason written above `brain.component.ts`: a ratchet that made a
  // correctness fix negotiable would be a gate encouraging the wrong outcome. The decomposition it was
  // waiting on landed two entries below.
  // 672 -> 675: THREE LINES, and they are a bound. Each traversal now passes its own node cap into the shared
  // link scan, which had none — one hub entity returned its whole mention set per class, per member space,
  // per hop, and on the recall path since 3.6. Raised without argument, for the reason written above
  // `brain.component.ts`. The decomposition it was waiting on landed one entry below.
  // RAISED 675 -> 688: the same bound now says when it stopped reading. Thirteen lines across four functions
  // — a per-hop flag in `traverseGraph`, a walk-level one in `traverseFromSeeds`, its merge in
  // `traverseRecallSeeds`, and the destructures at three call sites. The alternative was a module-level
  // mutable that every one of them writes, which is smaller and much worse to read.
  // The decomposition it was waiting on is the very next entry.
  // 688 -> 487, and UNDER the 650 ceiling. A-4 PAID: the recall-augmenting traversal became
  // `recall-seed-traversal.ts` (192 lines) — a different subject from the walk that stayed, which starts at ONE
  // node where this one starts at the records a search matched.
  //
  // `frontierEdgeQuery` and `TraverseNarrowing` went sideways into `frontier-query.ts` because BOTH traversals
  // apply them. That helper exists because the rule was once written twice with the copies disagreeing, so
  // duplicating it during the extraction that separates its two callers would have been the same defect again.
  //
  // Lowered rather than deleted: an entry here is a ratchet.
  // RAISED 487 -> 490: THREE LINES, for the record tier of `suppressEmbeddings` reaching the edge create.
  // One declares the option, and two hoist the suppression answer out of the inline-embed condition so the
  // ENQUEUE below can consult the same one — computing the vector inline and queueing a job anyway stores
  // exactly what the flag forbids, moments later, with nothing to come back and remove it.
  //
  // Raised without argument, for the reason written above `brain.component.ts`: this is the write path
  // honouring a documented field it silently dropped on create, on all four record types, and a ratchet
  // that made THAT negotiable would be a gate encouraging the wrong outcome.
  //
  // NO DECOMPOSITION: already PAID, 688 -> 487 -> 490, and the entry above says how. 490 code lines is not a
  // god file — it is 160 under the ceiling — and the SECOND SUBJECT is what made this file worth splitting
  // rather than its size: the recall-augmenting traversal is gone, and what remains is the edge CRUD, which
  // is one subject. Splitting a module this size again costs a reader more than it saves, which is the same
  // answer `tokens.component.ts` and `spaces.ts` give at 343 and 589.
  //
  // **The four raises above it kept saying A-4 still stood, three of them written BEFORE the payment and one
  // after.** An append-only comment block contradicting itself is how a finished task keeps being owed — and
  // `todo:check` was satisfied the whole time by the id appearing in a tracker's PROSE rather than in a row.
  // Stripping that prose is what surfaced it.
  // RAISED 490 -> 491 by ONE line: `ALL_LINK_LABELS`, the six synthetic link labels as a set.
  // The three named constants beside it are the ENTITY classes and keep their names because `edgeLabels`
  // callers and four test suites already spell them — but they stopped being the whole set when `M-2` gave
  // readers to `chrono.memoryIds`, `file.memoryIds` and `file.chronoIds`, and a caller building a filter
  // from the three would silently exclude half the graph. Derived from `LINK_CLASSES`, so a seventh class
  // joins it on the commit that declares it.
  // NO DECOMPOSITION: one derived export beside the three it completes. Moving it would separate a set from
  // its members.
  'server/src/brain/edges.ts': 491,
  /*
   * A BARREL of API response shapes, and the one entry here that is not a decomposition debt.
   *
   * It crossed the ceiling by two lines when `TypeSchema` gained the two edge-endpoint fields. The gate's own
   * message asks for a split responsibility or a note, and the honest answer is the note: this file declares
   * no behaviour. There is no logic to tangle and no path where "every change lands here because this is where
   * the code already is" produces a defect — which is the failure the ceiling exists to prevent.
   *
   * It is the client's mirror of the API's shapes, and its consumers import one module deliberately: splitting
   * it by domain would mean a component that touches two domains importing from two barrels, and the drift
   * would be between the halves rather than inside one file.
   *
   * **Frozen rather than exempt.** It cannot grow from here without this line being edited, which is the point:
   * if it reaches a size where a split is genuinely better, the argument happens in a diff.
   */
  // RAISED 652 -> 654: TWO LINES, the two response fields B-1 added. The budget reported one figure that
  // claimed to be bytes and counted characters; it reports both units now, so a recall envelope carries
  // `budgetChars` and `charsReturned` beside the two that existed.
  //
  // NO DECOMPOSITION: this is the entry above's own argument — a barrel of response shapes grows with the
  // API it describes, and splitting it would scatter one import into several for no reader's benefit.
  // RAISED 654 -> 655: ONE LINE. The knowledge types are now a TUPLE with the union derived from it, which
  // is two declarations where there was one — a union cannot be iterated, and four consumers in this client
  // were each writing the list out because of that.
  // NO DECOMPOSITION: the file's own note below already argues this case, and it is the one that applies —
  // this is the client's single mirror of the API's shapes, and its consumers import one module on purpose.
  // A second module holding one tuple would be the split this file exists to avoid.
  // RAISED 655 -> 657: TWO LINES, the second record-kind tuple and its derived union. Four sites in this
  // client were writing that list out because a union cannot be iterated and there was nothing to import.
  // NO DECOMPOSITION: this file's own note below is the argument that applies — it is the client's single
  // mirror of the API's shapes, and its consumers import one module deliberately. A second module holding
  // one tuple would be the split this file exists to avoid.
  // RAISED 657 -> 659: TWO LINES, the collection tuple and its derived type. Three types in this file were
  // each writing that list out; they are one word now.
  // NO DECOMPOSITION: the note below is the argument that applies — this is the client's single mirror of
  // the API's shapes and its consumers import one module deliberately. A third file holding one tuple
  // would be the split this one exists to avoid.
  // RAISED 659 -> 660: ONE LINE, `WipeResult.links`. The wipe response gained a key on the server and this
  // is the mirror of it; a mirror that is a field short is the shape that makes a client silently ignore
  // part of a response. There is nowhere else a field of a response type can live.
  //
  // RAISED 660 -> 662 for `N-1`: two fields on `NetworkMember`, `version` and `belowFloor`. This file
  // is the mirror of the server response shapes, so it grows by exactly what the API grew by — there
  // is no version of this change that adds a field to a response and not to its type.
  //
  // NO DECOMPOSITION for these two lines. The file is one interface per response shape and nothing
  // else, which is the shape a mirror should have; splitting it by domain would put the halves of a
  // request/response pair in different files. If it is ever split, the axis is the API section it
  // mirrors, and that is a move rather than a decomposition.
  //
  // RAISED 662 -> 666 for `Q-36`: `superseded` on `Fact`, `Entity`, `Edge` and `ChronoEntry`. The server
  // declares it on all four record documents and returns it on all four, so the mirror grows by exactly
  // what the API grew by — a mirror that carries the field on three of four is the shape that makes one
  // list silently stop badging. There is nowhere beside this file a field of a response type can live.
  //
  // NO DECOMPOSITION: same reason as the raise above it, and the same axis if it is ever split.
  'client/src/app/core/api.types.ts': 666,
};

describe('no file grows past what we already carry', () => {
  const files = sourceFiles();
  const sized = files.map(f => ({ f: f.replaceAll('\\', '/'), code: codeLines(readFileSync(join(ROOT, f), 'utf8')) }));

  it('walked a real tree', () => {
    // Floors the enumeration — an empty walk would make every check below pass over nothing.
    assert.ok(files.length >= 200, `only found ${files.length} source files`);
    assert.ok(sized.some(s => s.code > 500), 'no large file found at all — the counter is probably broken');
  });

  it('nothing new crosses the ceiling', () => {
    const over = sized
      .filter(s => !(s.f in FROZEN) && s.code > CEILING)
      .map(s => `${s.f}: ${s.code} code lines (ceiling ${CEILING})`);
    assert.deepEqual(over, [],
      'these are now larger than any unfrozen file was when this gate was written. Either split the new '
      + 'responsibility out, or add an entry with a note saying why this one belongs in a single place.');
  });

  it('no frozen file grows', () => {
    const grown = [];
    for (const [f, max] of Object.entries(FROZEN)) {
      const found = sized.find(s => s.f === f);
      if (!found) continue;                     // deleted or renamed — the entry is stale, not a failure
      if (found.code > max) grown.push(`${f}: ${found.code} code lines, frozen at ${max}`);
    }
    assert.deepEqual(grown, [],
      'a file already among the largest grew further. The failure mode of a god-file is not its size on any '
      + 'given day — it is that every change lands in the same place because that is where the code already '
      + 'is. Put the new behaviour beside it rather than inside it.');
  });

  it('reports frozen entries that have shrunk, so the list cannot drift upward silently', () => {
    // A frozen number that is far above reality stops being a ratchet and becomes headroom.
    const slack = [];
    for (const [f, max] of Object.entries(FROZEN)) {
      const found = sized.find(s => s.f === f);
      if (found && found.code < max - 50) slack.push(`${f}: now ${found.code}, frozen at ${max}`);
    }
    if (slack.length > 0) console.log(`  note: lower these entries —\n    ${slack.join('\n    ')}`);
    // Not an assertion: shrinking a file should never fail a build. It is reported so the list stays honest.
    assert.ok(true);
  });

  it('the measurement ignores comments — or it would punish the documented files', () => {
    // The property that makes this gate safe to have. `config/types.ts` is 1,986 raw lines and 62% comment;
    // if this counted raw lines it would be the second-largest file in the repo and the fix would be
    // deleting the documentation that makes it usable.
    const types = sized.find(s => s.f === 'server/src/config/types.ts');
    assert.ok(types, 'config/types.ts not found — update this test');
    const raw = readFileSync(join(ROOT, 'server/src/config/types.ts'), 'utf8').split('\n').length;
    assert.ok(types.code < raw * 0.5,
      `expected config/types.ts to be mostly comment (${types.code} code of ${raw} lines); if that is no longer `
      + 'true this assertion is measuring the wrong thing and should be re-aimed at whatever is');
  });
});

describe('a raise owes a decomposition task', () => {
  /*
   * Owner's rule, 2026-08-30: *"raising is okay but raising means you also have to queue a task to decompose
   * and modularize."*
   *
   * The ratchet already made growth visible; it did not make anybody answer for it. A raise with a good
   * reason and no follow-up is how a file reaches 1 618 lines one defensible increment at a time — every step
   * justified, the total justified by nobody.
   *
   * `server/src/api/spaces.ts` is the shape this asks for and the proof it is affordable: raised four times,
   * then PAID from 851 to 656 by moving two route bodies into `spaces-reembed.ts` and `spaces-activity.ts`,
   * leaving only their mount points. The discipline existed; it was optional.
   *
   * ## The marker, and why a reason is allowed
   *
   * Every `RAISED a -> b` must be answered in its own comment block by one of:
   *
   *   - `DECOMPOSE: <ID>` — a queued task. `todo:check` verifies that id is actually open in the ordered
   *     queue; this gate cannot, because `todo/` is gitignored and absent in CI.
   *   - `NO DECOMPOSITION: <reason>` — for a file where splitting is not the answer. A type file grows with
   *     the domain and a `.strict()` schema grows with its own contract; demanding a refactor task there
   *     would be make-work, and make-work in a queue is what stops a queue being read.
   *   - `DECOMPOSED: <what left>` — the raise is PAID: the split happened and the frozen number is back at or
   *     below where the file stood before the raise. This is the state the first two could not express, and
   *     writing `NO DECOMPOSITION` here instead would record the opposite of what happened.
   *
   * **The third one is CHECKED, which the other two cannot be.** `DECOMPOSED` names a number, so the gate
   * verifies it against the frozen size rather than believing the word — claimed while the file is still
   * above its pre-raise size, it is a raise wearing the marker that retires raises, and that is the one way
   * this convention could be used to launder a permanent increase.
   *
   * The reason costs something: it lands in a diff a person reads, next to the number it excuses.
   */
  const SRC = readFileSync('testing/standalone/no-new-god-files.test.js', 'utf8');

  it('every raise is answered by a task or a reason', () => {
    const lines = SRC.split(/\r?\n/);
    const unanswered = [];
    let block = [];
    for (const line of lines) {
      if (/^\s*\/\//.test(line)) { block.push(line); continue; }
      const entry = /^\s*'([^']+)':\s*(\d+),/.exec(line);
      if (entry) {
        const text = block.join('\n');
        const raises = [...text.matchAll(/RAISED\s+(\d+)\s*->\s*\d+/g)].map((m) => Number(m[1]));
        const paid = /DECOMPOSED:\s*\S/.test(text);
        if (raises.length > 0 && !paid && !/DECOMPOSE:\s*\S|NO DECOMPOSITION:\s*\S/.test(text)) {
          unanswered.push(`${entry[1]} — ${raises.length} raise(s), no DECOMPOSE, DECOMPOSED or NO DECOMPOSITION marker`);
        }
        // A paid raise is the only marker with a number behind it, so it is the only one that can be false.
        if (paid && raises.length > 0) {
          const before = Math.min(...raises);
          if (Number(entry[2]) > before) {
            unanswered.push(`${entry[1]} — DECOMPOSED claimed, but it is frozen at ${entry[2]}, above the `
              + `${before} it stood at before the raise. The split did not pay the raise back.`);
          }
        }
      }
      block = [];
    }
    assert.deepEqual(unanswered, [],
      'these files were raised and nothing was queued to shrink them. A raise with a good reason and no '
      + 'follow-up is how a file reaches four figures one defensible increment at a time:\n  '
      + unanswered.join('\n  '));
  });

  it('the check can see the raises at all', () => {
    // Without this the parser could silently match nothing and report every file as answered — the vacuity
    // every coverage gate in this repo has had at least once.
    assert.ok((SRC.match(/RAISED\s+\d+\s*->\s*\d+/g) ?? []).length >= 5,
      'no raises found — the comment convention changed and this gate is measuring nothing');
  });
});
