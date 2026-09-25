# Ythril — project conventions

## MCP and REST are ONE API with two doors

**Every capability must exist on both surfaces, and take the same parameters.** Owner rule, 2026-08-13.

Not "eventually", not "the tool wraps the route later" — the same commit. This is the single most expensive lesson this
codebase has: five capabilities shipped REST-only because a route was written and its tool "would follow", and
the canary operator had to report all five from the outside before anyone noticed. `mcp-rest-parity.test.js` gates the
capability half and `REST_ONLY_CAPABILITIES` is EMPTY — a row added there is a regression, not a plan.

**Parameters count too, and this is the half that hides.** A capability present on both surfaces still violates the rule
if one door accepts less:

- **The example this rule was written from, and it is FIXED — kept because the shape recurs.** `recall`'s `filter`
  accepted one operator object per key, ANDed, while `query`'s took `$or`/`$and`/`$not`/`$regex`/`$elemMatch` nested to
  depth 8. Same store, same policy, two grammars — so a caller who wanted meaning-ranking *and* a real predicate had to
  make two calls. Reported by the fleet integrator 2026-08-13T1035Z §2 as a parity defect rather than a feature request,
  and `recall` now accepts either grammar (mixing them is refused rather than resolved). What to take from it: both
  doors were individually defensible and the gap was only visible from outside.
- A parameter added to one surface alone is the same defect arriving as an omission. When `/query` gained `skip`, `sort`,
  `dir` and `total`, the MCP tool gained them in the same commit.

**When they must differ, the difference is the narrowing, not the vocabulary.** REST narrows a proxy space by request
(`memberSpacesForRequest`); MCP narrows by the connection's accessible spaces (`memberSpacesWithin`). That is one rule
expressed against two different sources of scope — it is not one surface offering less.

**There are exactly two sanctioned divergences, and the second is a DEFAULT rather than a scope.** The byte budget an
answer is trimmed to defaults lower on MCP than on REST — `MCP_DEFAULT_MAX_CHARS` against `DEFAULT_MAX_CHARS` in
`brain/result-budget.ts` — because an agent pays for every byte in its own context while a REST caller does not. It is
measured, not assumed, and it earns its exception by three conditions its gate holds it to: MCP is genuinely the lower
of the two, every MCP call site resolves through it rather than one remembering to, and both doors disclose the number
they used. **So `maxChars` defaults differing is not a parity bug**, and equalising them on the strength of the rule
above breaks a decision taken from a canary report. Any THIRD divergence needs the same three conditions and a gate, or
it is the defect this section is about.

**Check both when you change either.** The parameter names, the defaults, the caps, the refusals, and the error text. A
`400` on one door and a silent default on the other is worse than either alone, because it makes the behaviour depend on
which client the caller happened to pick.

## The five places a capability lives — all of them, same commit

Owner rule, extended 2026-08-13. "MCP and REST" is not the whole list. A capability change is not done until all five
agree:

1. **the REST route**
2. **the MCP tool** — same parameters, same defaults, same caps, same refusals
3. **`docs/integration-guide/`** — the integrator's reference
4. **`docs/userguide/` — the page an operator would actually open for this capability.** Six pages, and which one it is
   follows the surface the operator uses: a search parameter is `02-brain.md` → Brain → Query → Semantic Search, a
   token control is
   `04-settings.md`, a model or media control `04a-media-and-embedding.md`, retention and audit are `05-storage-data-and-audit.md`. Do not read this row as "the Brain page" —
   that is only where it was learned, and a capability documented on the wrong page is the failure it prevents. A
   parameter that exists on both APIs and is absent from the operator's page is a capability nobody using the UI knows
   about; a control described there that no longer matches the API is worse
5. **token rights** — `ROUTE_RIGHTS` in `auth/space-rights.ts`, and `TOOL_RIGHTS` in the same file for the MCP half. A
   new route with no row is **allowed and only partly governed**: its reach is enforced, its area is not, and every
   call logs a warning naming it. **There are two right answers and picking the wrong one is the trap** — a route that
   is a view of a space's data gets a `ROUTE_RIGHTS` row with its area and lowest rung; a route that is NOT gets a
   `NOT_AREA_SCOPED` row with the reason. Adding a rights row to the second kind area-scopes a route the design says
   is not, which is the opposite of the decision recorded in each `why`. Corrected 2026-09-04: this row read
   *"either unreachable or ungoverned, and both fail silently"* and was wrong on both halves — the request is served,
   and it is the one failure here that announces itself on every call

The failure this prevents is not "documentation drift". It is that **each of these is somebody's authoritative source**,
and the one that is wrong is invisible to whoever reads it: The fleet integrator designed around a stale sentence in an MCP schema;
the canary operator could not find an env var that was documented on the wrong page; a user reading the Search page cannot
discover a `skip` that only the API has.

**Check all five when you change any one.** If one genuinely does not apply, say which and why in the commit — not in your
head.

## A schema description is the authoritative reference — treat it as code

An MCP tool's `inputSchema` description is what a caller reads *while constructing arguments*, and `help()` says so in as
many words. A stale sentence there is invisible: nobody reports a capability they were told they did not have.

The fleet integrator read *"filter applied after vector search"* on `recall`, believed it, and built a skill that deliberately avoided
filtered recall — because a post-filter behind `topK` could silently drop results. Our own `help()` said the opposite,
correctly, at the same time: two surfaces describing one behaviour, and the wrong one was the one being read.

**What the caller needed was the GUARANTEE, and the mechanism is what made the sentence rot.** `topK` is filled from
records that satisfy the filter, so a filtered recall cannot silently miss a matching record — that is the promise, and
it has held throughout. *"It is a pre-filter"* was the true-at-the-time explanation of why, and it is no longer the
whole answer: allowlisted keys with declared schema properties become a native index pre-filter, while an undeclared
property or `exists`/`ne` scores the space exhaustively and filters after. **Both paths keep the guarantee; only one is
fast.** Write the promise into a description and the performance note beside it — a description that states the
mechanism has to be revisited every time the mechanism gains a case, and nobody does.

## Reuse a module, or build one worth reusing

**Owner rule, 2026-09-07:** *"Wherever possible reuse modules or build modules to be reused and perfectly
maintainable."* Said while reading the `Q-6` sweep, whose subject is copies — and whose own output had become
the same block written ten times.

This is the rule the section below is the consequence of. *"One rule, two implementations"* describes what
goes wrong; this says what to do BEFORE it does.

**Three questions, in order, every time you are about to write something that already exists somewhere:**

1. **Is there a module for this?** Not "do I remember one" — grep for the BEHAVIOUR, because a module named
   for its first caller is invisible to everyone after it. `mergePropertiesOrKeep`, `edgeEndpointKind`,
   `wipeSpaceCollection` (now `wipeSpace` in `spaces/lifecycle.ts`) and `page-across-members.ts` were all written
   twice before they were written once.
2. **If not, should there be?** The threshold is the SECOND site, not the third. By the third the two have
   already diverged and the extraction is a merge rather than a move.
3. **Will the module be worth reaching for?** A shared thing nobody reaches for is worse than a copy: it
   carries the maintenance cost and delivers none of the benefit. See below.

### What makes a module worth reusing, and this is the half that gets skipped

**Put the FORGETTABLE part inside it.** The four lines of `git ls-files` were never the cost — the floor
assertion after them was, because an empty listing passes every loop written over it and the floor is the
line that looks like boilerplate. `trackedSources` throws instead of returning `[]`, so a caller cannot
receive the failure quietly. Ask what a hand-written copy would DROP, and make that the thing the module
does not let you drop.

**One question per module.** `trackedSources` answers *"what source files does this repo have"*. It does not
answer *"what changed against main"*, and it must not grow an option for it — a shared module that gains a
flag per caller is a switch statement with extra steps, and it makes every caller depend on every other
caller's needs.

**A difference that small is exactly what argues for keeping copies** — and is usually wrong.
`bulkDelete{Edges,Entities,Memories,Chrono}` were four functions differing in two real ways; the two became
parameters and the four became one wipe (today `wipeSpace` in `spaces/lifecycle.ts`). The instinct to say *"but mine is slightly different"*
is the instinct that produced the four.

**Name it for the QUESTION, not for the first caller.** A name that describes where it came from is a name
nobody greps for.

**Leave the reason in it.** Every one of these modules exists because something went wrong twice. A module
whose docblock says what it prevents survives a reader who thinks the indirection is unnecessary.

### Where it does NOT apply

**Do not herd unrelated callers through one module because they share a spelling.** Sixty-odd files in
`testing/` call `git ls-files`; six of them were asking the source-sweep question and were converted, and the
rest ask about history, tracking or a diff base. Merging those would be this rule's own failure mode: one
module, four questions, an option each.

**A test fixture is allowed to be literal.** A fixture that derives its expectations from the code under test
asserts that the code equals itself. The rule is about the code that RUNS, and about the derivations gates
use to find their subjects — not about the expected values they compare against.

## The defect class this repo produces most

One rule, two implementations, and the weaker one wins silently. It has shipped as: a proxy lens computed and discarded on
three routes; an empty allowlist read as "unrestricted" on three more; REST validating existence where MCP checked only
shape; a paging window inline in one route and correct in another. When you find yourself writing the same rule a second
time, extract it instead — `spaces/page-across-members.ts` exists because of this.

**It is not only a server pattern, and the count is usually higher than it looks.** An edge endpoint's shape rule had
FIVE copies — the REST route, the MCP tool, the bulk importer, sync's link-violation check, and the embed-text resolver —
each correct while every endpoint was an entity, and each about to be wrong in a different way. The one to check hardest
is the copy that RECORDS rather than refuses: sync's would have logged two link violations per legitimate edge, which an
operator reads as real damage.

**`bulkDelete{Edges,Entities,Memories,Chrono}` was the same rule four times, and became one (`R-4`) — today
`wipeSpace` in `spaces/lifecycle.ts`, which carries the face-label cascade itself.** Kept here because the SHAPE is what recurs and the extraction is the model for
it: the four were not identical, and the two real differences became parameters rather than reasons to leave them
apart — entities run an `afterDelete` for the face-label cascade, memories need a `sort`. **A difference that small is
exactly what argues for four copies and against extracting them**, which is why the count keeps climbing.

## A gate concludes about MORE than it checks, and its title is where the gap hides

Promoted to its own section by `Q-5`, 2026-09-05, after the same failure turned up **four times in one sweep,
across three unrelated subsystems**. It had been recorded once, as a footnote to a sync incident — *"a gate
scoped to one mechanism concludes about all of them"* — and being a footnote is why it kept happening.

**The shape: a gate whose TITLE is a claim about a whole set, whose BODY reads part of it.** Both halves are
written by the same person on the same day, and the title is the half everybody afterwards believes. Nothing
ever contradicts it, because a gate that passes is evidence of nothing in particular.

| the gate | what its title claimed | what it actually looked at |
|---|---|---|
| `a-receiver-embeds-by-its-own-rules` | the receiver never trusts an arriving vector | the ingest ROUTER; the second ingest site was outside it |
| the same file, a different case | *"all four ingest schemas declare the flag"* | four hard-coded names, of six |
| `sync-carries-suppressed-memories` | *"NO incoming schema declares a vector"* | the same four |
| `todo-consistency.mjs` rule 4 | the plan does not describe work that shipped | only a merged PR NUMBER — the plan that rotted named tracker ids |
| `no-matrix-reaches-nothing-not-everything` | a token with no matrix reaches NOTHING | one function, so two of four guards kept failing open |

**Three rules for writing one, and the third is the one that gets skipped.**

1. **Derive the set, never list it.** A corrected list is the same defect with a later expiry date. Read it
   out of the module, the registry, or `git ls-files` — and assert a FLOOR on what you found, because an
   empty set passes every loop written over it.
2. **Assert the rule, not the site.** *"Every guard that can be handed X answers the same way"* survives a
   fifth guard being written next year; a case that names ONE function does not — and the two read
   identically in a diff, which is why this is the part that gets talked past in review.
3. **See it red before you believe it.** A gate written after the fix has never been observed failing, and a
   gate that has never failed is a claim. Mutate the thing it guards — the NEWLY covered part, not the part
   that was already checked — and put the original string back **by hand**, never with git.

**And when the title says "every", the count belongs nowhere.** Every number written into a title, a docblock
or an assertion message is a second copy of a fact the code already holds. `Q-5` corrected *"five ingest
schemas"* to six in an assertion message that was otherwise doing everything right, and that message is the
best case: the bad case is the loop.

## A field on a replicated document is HASHED and replicated, or excluded from the hash — never neither

Found while shipping M-1 and finished by W-10, 2026-09-01. A rule rather than an incident because both halves
are invisible from both ends.

**Stripping.** `api/sync/_shared.ts` validates every PUSHED document with a bare `z.object({...})`, and **zod
strips keys the schema does not declare.** The pull path validates nothing. So a field missing from its
`Incoming*` twin is **kept when the record arrives by pull and deleted when the same record arrives by push** —
same version of the code, same document, one direction, no error, no statistic, and a 200 on the way back.

**The rule is "every `Incoming*` schema in `api/sync/_shared.ts`", and it is written that way on purpose.** This
paragraph named four documents and there are six; the two it did not name arrived after it was written. **The
gate had the identical bug and it is what the derivation cost was paid for**: its hand-written list of four
missed `LinkDoc`, so every assertion ran over the old four and reported clean about a document nobody had
checked. Never count them here — the file is the list.

**It then happened twice more to the same six schemas, in two other gates, and `Q-5` found them both**
(2026-09-05). One asserted *"all four ingest schemas declare the flag"* and the other *"NO incoming schema
declares a vector"*; both looped over the same hard-coded four. Neither could see `IncomingFileMetaDoc` —
the schema that needs the suppression flag MOST, because a file has two tiers and not three. The derivation
now lives in `testing/_shared/incoming-sync-schemas.mjs` so there is one place to be wrong instead of three.
See *A gate concludes about MORE than it checks*.

**One of the six refuses instead of stripping.** `IncomingFileMetaDoc` is `.strict()`, so an undeclared key
fails the push with a 400 rather than vanishing from it. That is the loud version of the same defect and it is
deliberate: a stripped `parentFileId` turns a chunk into a top-level file, which is worse than a rejected push.

**Hashing.** `brain/merkle.ts` hashes every field of every brain document except what it excludes, and that hash
is what tells an operator whether two instances hold the same data.

Put them together and the rule has no judgement left in it: **a field that is hashed must replicate.** If it
does not, the sender's copy has the key, the receiver's does not, and a network with `merkle: true` logs a
`MERKLE_DIVERGENCE` warning every cycle for a space where nothing is wrong. The check is advisory, so nothing
ever contradicts it — and a permanent false alarm teaches an operator to ignore the one signal that means data
really is missing.

`a-replicated-field-reaches-its-incoming-schema.test.js` derives its exemptions from `merkle.ts` rather than
keeping a list. Adding a field means declaring it on the ingest schema, or excluding it from the hash — and
**"excluding it" is THREE sites in `merkle.ts`, one of which runs the opposite way round.** Five collections are
governed by `DERIVED_FIELDS` and the `DERIVED_PROJECTION` built from it, both EXCLUSION lists: a field is hashed
unless named. `files` is governed by `FILE_HASH_PROJECTION`, an INCLUSION list of the keys it hashes, because
`FileMetaDoc` has thirty-odd fields and most of them are local machinery.

**So the polarity flips, and following this rule literally for a file field leaves it unhashed.** Add a
replicated field to a memory and do nothing else: it is hashed, correctly. Add one to a file and do nothing
else: it is silently outside the hash, which is the false NEGATIVE — two instances holding different data and
agreeing they match, for ever, with nothing to contradict. A file field must be ADDED to
`FILE_HASH_PROJECTION` to be hashed, not withheld from a list to be excluded.

- **What is legitimately excluded, and the categories are three not two.** A vector, its model name and
  `matchedText` are derived by the LOCAL embedding model — `matchedText` is the snippet a search matched, so it
  is an artefact of a query and not content at all. The two retention stamps are computed from the LOCAL space
  policy. Neither can travel: peers running different models hold different vectors for identical content, and
  shipping a retention stamp would let one instance decide when another deletes its data.
- **What a local schedule DID to a record is not local.** `contentRedacted` and `contentRedactedAt` say that an
  entry had a description and no longer has it. They replicate and they are hashed — excluded, a redacted entry
  would hash identically to one that still has its detail, which is real divergence going unreported.
- **Deriving the rule is what found the fields nobody had reported.** A hand-written list of exemptions named
  none of `FactDoc.type` (then `MemoryDoc.type`; it selects the memory's type schema, so a pushed memory was validated against
  nothing on the receiver) or the two chrono redaction marks. A reason once written is never re-read; a rule
  read out of the code that governs the behaviour cannot go stale the same way.

## What a receiver does after the write is the RECEIVER's decision

Owner's ruling, 2026-09-01: *"dont transfer embeddings... on transfer the receiver applies its rules. if the
space has supressembeddings dont embed at all. if it should embed use the receivers embedding mechanism."*

**A vector never crosses the wire, and "no ingest schema declares it" is only HALF the reason — the half
that covers one of the two ingest paths.** That sentence stood here alone and was believed; it is true of
PUSH, which zod strips because no `Incoming*` schema declares the field. **Pull validates nothing.** It
fetched `full=true` and `replaceOne`d what came back, so a pulled record carried the sender's vector and
was stored with it, for as long as the sentence had been read as covering both.

**And the vector was not the expensive half.** The same five fields are excluded from the space hash, and
two of them are the retention stamps — `_expireAt` and `_contentExpireAt`. `brain/ttl-sweep.ts` deletes
every record whose stamp has passed, across every space, through the normal delete path. **So a pulled
stamp let one instance decide when another deleted its data** — an operator who configured a year of
retention losing records after the sender's seven days, with nothing logged on either side.

**The list is `sync/local-only-fields.ts`, with two consumers and one reason.** `merkle.ts` excludes them
from the hash; the pull path strips them before the write. The equivalence that makes it ONE list is the
rule two sections above — a field that is hashed must replicate — read backwards: a field that must not
replicate must not be hashed, or every cycle reports a divergence for a space where nothing is wrong.

**What to take from it, because the shape recurs:** the gate protecting this asserted that the receiver
does not trust an arriving vector, and it was scoped to the ingest ROUTER. The second ingest site was
outside the thing it looked at, so it passed throughout. A gate scoped to one mechanism concludes about
all of them.

Whether to embed is then `embeddingSuppressedFor`, resolving `record > schema > space` against THIS instance's
configuration — **except for a file, which has two tiers and not three.** A file has no `type`, so it has no
type schema to consult; it is governed by its own record flag or by the space setting, and nothing in between.

**Two functions in `api/sync/_shared.ts` may write an arriving brain document, and neither queues
unconditionally.** This paragraph claimed one function queueing every document, and both halves have since
stopped being true:

- **`ingestBrainDoc`** takes the record type as an explicit argument, and `null` means *this kind has nothing to
  embed*. Links pass `null` — a link is a pair of ids, so there is no text. **A missing embed job on an arriving
  link is correct, not a bug.**
- **`ingestFileMeta`** is the second site, and it exists because file metadata is the one collection that cannot
  be replaced wholesale: it merges the authored keys with `$set` and never `$unset`s, or the receiver would
  publish the sender's `sizeBytes` and `sha256` for bytes it does not have. It queues **only when this instance
  holds the blob**, because metadata can arrive before the file does.

**So "a new ingest site cannot be written without the queue" is no longer structurally guaranteed** — it was a
property of there being one function, and there are two. What holds instead is the argument that made
`ingestBrainDoc` take its type explicitly: a caller that embeds nothing has to say `null` out loud, at the call,
where a reviewer sees it. A third ingest site would have to make the same decision visible the same way.

- **The record tier has to cross the wire for that to be true.** Both spellings of the suppression mark
  replicate. Stripped, a record its author retired from meaning-ranked search would re-enter it on every peer.
- **A vector from another instance is not a saving.** Ranking one model's vectors against another's does not
  fail — it returns plausible results in the wrong order, which is the kind of wrong nobody reports.
