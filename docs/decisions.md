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

## Format

Context → Decision → Consequences → Where the detail lives. No template ceremony; the point is that the *why* is
findable by someone who has just cloned the repository.
