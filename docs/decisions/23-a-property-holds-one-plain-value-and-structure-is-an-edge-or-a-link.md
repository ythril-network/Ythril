# 23 — A property holds one plain value, and structure is an edge or a link

**Status:** accepted, 2026-11-18 · **Scope:** what a property value is, how richer content is held, and how it travels in and out of RDF (bundle-269, Q-749)

## Context

A property holds a string, a number, a boolean or a date (`schema/src/vocabulary.ts`, `PropertySchema.type`). The RDF work had to say how richer content travels: several values of one relationship, a reference to another record, a nested thing. The fact, edge and chrono writes do not refuse a non-primitive value (`server/src/brain/property-values.ts`; only the entity write does), so a direct database write could have left a list or an object in a property, and an export has to say what it does with one.

## Decision

The owner, verbatim: *"i mean richer content shall travel on export and be handled, just to make sure you understand. i just dont allow for arrays in ythril."* And on old data: *"there should be no arrays - we never supported them if not pushed via mongo update directly."*

Ythril stores no array and no nested object in a property. Richer content is held as edges and links, and it travels as what it is:

- several values of one relationship are several edges or links;
- a reference to another record is an edge;
- a nested thing is its own record plus an edge.

The record states this as how Ythril holds richer content, not as a limit on what it can express.

## Why

Content held as an edge or a link is a record of its own. It is versioned, synced, governed by the schema's endpoint and functional rules, traversed, found from either end, and checked by linkage and cascades. The same content written into a property as an array, an object or an id would be invisible to all of that.

## What it means for RDF

- **Export.** Datatype properties come from properties; each is single-valued and plain (the schema export states `owl:FunctionalProperty` and `sh:maxCount 1`). Object properties come from edges and links. Several edges of one label from one record export as that predicate stated several times, each with its own reifier. A reference exports as a relation to the other record's IRI. A nested thing exports as its own subject, joined by the edge's predicate. A link exports as `dcterms:references`.
- **A property value that is a list or an object** is not a supported shape. The export leaves that one value out, counts it, and names the record and the property in its answer, so the operator can find and repair it. It never drops it silently and never fails the export. A value that does not fit the type its property declares is left out and named the same way.
- **Import** (a later plan): several values of one predicate arrive as several edges or links, never as an array in a property; an IRI in object position arrives as an edge or a link to that record; a nested node arrives as its own record plus an edge.

## What it does not forbid

- A string value that happens to contain an id or a URL: it stays a string.
- Edges and links that carry their own plain properties.
- A unit or a language on a value: a separate idea with its own brainstorm (a typed or language-tagged literal), not built here.
- A future decision that supersedes this record.

## Consequences

- **The mapper never reads a property as a relation.** A string that looks like a record id is a literal on its property's address; only an edge or a link states a relation.
- **A stray list or object value shows up in the export's answer**, as a count and the first named records, and in the export's audit row.
- **This is the reversal to prevent:** storing an array or a nested object in a property "for convenience", or exporting such a value as if it were data (a JSON literal, a joined string, an invented node). Either makes richer content invisible to the graph, which edges and links exist to carry.

## Where the detail lives

- `schema/src/vocabulary.ts` — `PropertySchema`, the plain types a property may declare.
- `server/src/brain/property-values.ts` — what a property bag may hold at the API layer.
- `server/src/rdf/literals.ts` — the one place a stored value becomes a typed literal or is left out.
- `server/src/rdf/record-triples.ts` — the record form: edges and links as relations, a left-out value named in `counts.skippedValues`.
- [`docs/rdf/ythril-vocabulary.md`](../rdf/ythril-vocabulary.md) — the published vocabulary, generated from the server's term table, which opens with this rule.
- `testing/standalone/richer-content-travels-as-edges-and-links.test.js` and `testing/standalone/every-record-kind-has-its-triples.test.js` — the gates over the rule.
