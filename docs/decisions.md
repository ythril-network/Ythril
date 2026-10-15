# Decision records

Short records of the calls that are **expensive or impossible to reverse**, so the reasoning survives the people who
made it.

## Why this folder exists

The reasoning was there — it just did not ship. Ythril's code comments carry an unusual amount of *why*, and the
working trackers carry more. But `todo/` is **gitignored** (`.gitignore:51`), so `_REFERENCE.md` and
`_PARKED-DECISIONS.md` — where the rationale for the cross-cutting calls actually lived — are invisible to anyone who
clones the repository. A contributor could read every comment in the tree and still not know why PDF rasterisation
avoids the obvious library, or why a "broken" model load must not be fixed by letting it download.

That has a cost beyond onboarding: a decision nobody can see gets **accidentally reversed**. Each record below names
the reversal it exists to prevent.

## What belongs here

Only irreversible or expensive-to-reverse calls: a dependency chosen for licence reasons, a security model, a
behaviour operators build on. Not style, not anything a comment beside the code says better — a record that duplicates
a comment will rot in one of the two places.

**Retrospective by design.** These were written after the fact, from artefacts already in the tree, and each one cites
where the detail lives so nothing here becomes the second source of truth.

| # | Decision | Reversal it prevents |
|---|---|---|
| [01](decisions/01-pdfium-not-pymupdf.md) | PDF and office rasterisation uses **PDFium**, not PyMuPDF | swapping in PyMuPDF for its nicer API, and taking AGPL-3.0 into a redistributed image |
| [02](decisions/02-two-layer-ssrf-defence.md) | SSRF is checked **twice** — a string check at config time, a DNS-resolved check at use time | deleting the "redundant" second check, reopening DNS-rebinding and redirect pivots |
| [03](decisions/03-no-runtime-model-downloads.md) | The published image **may not fetch a model at runtime** | "fixing" a failed model load by letting it download, which silently sends an air-gapped operator's IP to a third party |
| [04](decisions/04-a-result-row-is-whole-or-absent.md) | A search result row is **whole or absent**, and nothing is spilled unasked | a node cap or spill threshold below the byte budget that shortens a row "to keep more matches" |
| [05](decisions/05-an-upstream-may-delete-what-it-relayed.md) | On a pub/sub network or a tree, an upstream may delete **what it delivered** to an instance, and never what that instance wrote | widening the rule to any peer, or to the instance's own records, or replacing the stored delivery stamp with an inference from authorship |
| [06](decisions/06-what-an-instance-derives-or-audits-stays-local.md) | A soft-deleted file's row and a conversion's sidecar **stay on the instance that made them**; the deletion travels as the file tombstone | putting `deletedAt` on the wire, or letting sidecars travel, which brings back a row that outranks its own tombstone and a conversion that is not the receiver's |
| [07](decisions/07-a-functional-label-is-held-by-a-local-marker-and-a-unique-index.md) | A functional label is held by a **local marker plus a unique partial index**; the marker is neither restored nor derived and always names its edge's subject | treating the marker as an ordinary record field, or an edge writer that copies a row whole without saying what it does with the marker, which leaves a lock that refuses every later write under its subject |
| [08](decisions/08-a-file-stamp-is-reported-never-repaired.md) | A file row a 4.0–5.5 receiver stamped with its own author is **reported** (`file_stamp_report`, on a peer's evidence, "likely" and never "stamped") and **never repaired** by this software | adding a `repair` option, boot migration or arrival rule because the report already lists the rows, which hands a peer authorship and deletion rights over a file that may be this instance's own and is undone by the next delivery of the old stamp |
| [09](decisions/09-a-move-the-instance-began-is-the-instances-to-finish.md) | A move the instance began is the **instance's to finish** (owed moves finished by housekeeping, identity fail-closed), and a destination the tree refuses is **`409`** | letting a marker age out or "no bytes at the old path" read as deleted, which destroys a move merely unfinished; or answering `400`/`422`, which silences a sync sender for a condition that can clear |
| [10](decisions/10-a-rule-is-saved-only-when-the-instance-can-apply-it-and-an-unknown-key-is-named-not-refused.md) | A schema **rule is saved only when this instance can apply it** (a CEL engine whose regex is linear, our own save-time checks), a receiver **names a key it does not know instead of refusing the layer**, and only a property key a write **adds** is refused as undeclared | an engine whose regex backtracks or whose checks are left to evaluation, a receiver that refuses a layer whole for an unknown key or capability negotiation that makes a write wait on every member, and judging an undeclared key by its presence, which freezes every record a schema was tightened over |
| [11](decisions/11-an-unknown-write-field-is-answered-by-the-instances-setting-for-its-space.md) | An unknown top-level field on a brain write is answered by **this instance's per-space setting** (`warn` stores it and names it, `refuse` refuses it), and the accepted keys are derived from the MCP tool's input schema, never a second list | a door that drops an unknown field without naming it, a hand-written accepted-key list beside the derived one, or a setting replicated to the members of a network, so one instance's answer decides what another stores |

## Format

Context → Decision → Consequences → Where the detail lives. No template ceremony; the point is that the *why* is
findable by someone who has just cloned the repository.
