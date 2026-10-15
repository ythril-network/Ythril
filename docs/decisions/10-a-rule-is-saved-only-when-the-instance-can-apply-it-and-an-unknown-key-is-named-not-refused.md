# 10 — A schema rule is saved only when this instance can apply it, and a key a release does not know is named, not refused

**Status:** accepted, 2026-10-14 · **Scope:** the `rules` a type and a space carry (CEL expressions with a message), the
rule that a schema is stored only once it is parsed, how a receiver reads a schema a peer sent, and the undeclared-key
rule of strict spaces

## Context

Custom rules are text an operator writes, stored in a space's schema, **replicated to every member of every network
that carries the space**, and evaluated on every write of a strict space — including a record a peer sent. That
combination makes four things expensive to get wrong and impossible to take back once an operator has built on them.

- **An engine that evaluates and does no more.** `@bufbuild/cel` parses and runs an expression and exports no type
  checker and no cost estimate. The other pure-JavaScript evaluator (`cel-js`) runs `matches()` on the host's own
  backtracking regex, so one pattern in one rule can stall a write. A rule that stalls writes is a denial of service
  the operator wrote by accident and every peer then inherits.
- **A rule that can never apply fails late and loudly, or never.** Stored without a check, a rule that reads a property
  its type does not declare, or calls a function the engine lacks, refuses every write of its type (fail closed) or is
  silently never enforced (fail open), and the author finds out on request 340.
- **A newer key breaks an older network.** A release before this one reads a schema with a strict body: a layer
  carrying a key it has never heard of is refused whole, once per cycle, and the writer — whose own write answered
  success — is told nothing. Capability negotiation (a member announces which keys it accepts, and a write that sets
  another is refused until they all do) was the first answer and was withdrawn: it cannot reach a member beyond the
  direct peers, a member that never reports deadlocks every write, and an announcement can be forged.
- **A key looks declared and is not.** A type that declares properties reads as a closed list in the schema editor,
  while the validator judged only the declared keys' values and stored `statuz: 'x'` beside them without a word.

## Decision

- **The engine is `@bufbuild/cel`, pinned exactly, with RE2 behind `matches()`** (linear: `(a+)+$` is only a pattern).
  It is loaded in one module, `schema-rules.ts`, and nowhere else. Because it has no checker, **the save-time checks are
  ours**: the expression parses; it reads only `self` and only the fields the record's view has (never an edge's ends,
  because an edge is judged before they exist); a type's rule reads only the properties its type declares; it calls
  only functions the engine has; `matches()` takes a string literal, compiled at save; it has a bounded size and no loop
  inside a loop; it answers true or false on a set of records that is linear in the paths it reads; and the rules that
  apply to one record are priced together and refused above a fixed budget — a function of the rules alone, never of a
  clock.
- **The wire shape is a map of name to `{ rule, message }`.** A type's own `rules` are part of the type and replaced
  with it; the space's `rules` (with an optional `kinds`) are a top-level field replaced whole, so a rule is deleted by
  sending the map without it. In a network layer the network's fields for a type win. One table says how each meta key
  merges and every merge reads it.
- **A schema is stored only once it is parsed.** The brand a store takes is minted in one module, so no door can store
  a body another door would refuse.
- **A rule's outcome is a violation like any other**, classified *introduced* or *pre-existing* by whether the write
  changed what the rule reads. Could-not-evaluate and too-large-to-check are violations too, value-free, and block a
  strict write only when introduced. A property the rule reads that a record lacks makes it not apply.
- **A stored rule that goes bad is skipped and named; a dead engine fails closed.** A property removed from its type, a
  hand-edited file, a layer from another release: the rule is skipped, listed by name on `space_meta`
  (`invalidRules`), counted and said once. If the engine itself cannot load or fails its self-test, every rule reports
  that it could not be evaluated and the security posture fails.
- **The receiver is a tolerant reader; the writer says what an older member will do.** A receiver keeps every meta key and
  type field it knows and names the ones it does not (bounded) instead of refusing the layer; a known field with a wrong
  value still refuses the whole meta, and a vote round is applied whole or not at all. A write that sets a key an
  earlier release refuses answers success plus a `warnings` row naming the members whose recorded version is older or
  unknown, labels only for a caller who may see the network.
- **A type that declares at least one property is a closed list, and only a key a write *adds* is refused.** A key
  already stored is the record's own history, so tightening a schema never freezes the records written before it. The one
  exemption — the keys the conversation extractor writes — is an argument its writer passes in-process, never a
  parameter of a request.

## Consequences

- **An upgrade is per network.** Members on the release before this one refuse a layer carrying `rules` or `stampSkew`
  until they upgrade; the write says so and the operator decides. A rollback to that release drops such a layer whole
  and does not enforce the rules this release stored (they stay in `config.json`).
- **A rule is a bounded language, not a program.** An operator who wants a loop in a loop, a regex chosen at run time or a
  read of an edge's ends is refused at save, naming the rule. That is the price of a rule that cannot stall a write.
- **The first strict sweep is priced.** A strict space whose records carry keys their type never declared refuses an
  *edit that adds another*, never the records themselves; the stored-data check lists them.
- **This is the reversal to prevent:** swapping in an engine whose regex backtracks, or whose checks are "left to
  evaluation" so a rule that can never apply is saved and fails on a write; making a receiver refuse a layer whole for a key
  it does not know, or bringing back capability negotiation so a write waits on every member; judging an undeclared key by
  its presence instead of by whether the write added it, which freezes every record a schema was tightened over; and
  running the engine anywhere but its one module, so that a door evaluates a rule the others would have refused.

## Where the detail lives

- `server/src/spaces/schema-rules.ts` — the engine, the save-time checks, the limits the client shows, the outcomes and
  the stored-rule report.
- `server/src/spaces/body-schemas.ts` — the one parse of a schema body, the brand, the tolerant reader.
- `server/src/spaces/meta-fields.ts` — how each meta key merges.
- `server/src/sync/meta-skew.ts` — which members may refuse a new key, and the release table a gate holds to the previous
  release's own body.
- `docs/integration-guide/06a-schema-api.md` — the contract: rules, limits, outcomes, undeclared keys.
- `docs/dependencies.md` and `NOTICE` — the engine's licences and what ships with it.
- `testing/standalone/a-cel-rule-is-checked-when-the-schema-is-saved.test.js` and
  `testing/standalone/the-since-table-names-every-key-new-since-the-previous-release.test.js` — the save-time check, and
  the table that names the keys an older member refuses.
