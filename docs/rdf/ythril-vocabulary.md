# Ythril vocabulary

Ythril stores no array and no nested object in a property: a property holds one plain value — a string, a number, a boolean or a date. Richer content is held as edges and links, and it travels in this export as what it is. Several values of one relationship are several edges or links and appear here as the same predicate stated several times. A reference to another record is an edge and appears as a relation to that record's IRI. A nested thing is a record of its own, joined by an edge. Edges appear as their label's property, with a reifier for the edge's own details; links appear as `dcterms:references`. Every datatype property in this vocabulary is therefore single-valued.

The rule is stated, with the owner's words and the reasons for it, in [decision record 23](../decisions/23-a-property-holds-one-plain-value-and-structure-is-an-edge-or-a-link.md).

## Address

The terms Ythril defines for its own RDF export live in one namespace, `https://w3id.org/ythril/ns#`, written `ythril:` in the export's Turtle, TriG and JSON-LD. The address redirects: a request for Turtle is sent to the file `ythril.ttl` of this folder, any other request to this page. Everything else an export says is stated with the standard vocabularies RDF, RDFS, OWL, SHACL, schema.org, OWL-Time, Dublin Core terms and PROV-O.

This page and `ythril.ttl` are generated from one table in the server (`server/src/rdf/ythril-vocabulary.ts`) and are not edited by hand.

## Classes

| Term | Meaning |
|---|---|
| `ythril:Entity` | A Ythril entity record. |
| `ythril:ExportReport` | One page of an RDF export of Ythril records: how many records it holds, whether it is the last, and what it left out. |
| `ythril:Fact` | A Ythril fact record. |
| `ythril:Untyped` | The class of an entity that declares no type. |

## Properties

| Term | Meaning |
|---|---|
| `ythril:complete` | Whether nothing of the export's scope is left after this page: true on its last page. |
| `ythril:confidence` | A chrono record's confidence. |
| `ythril:contentRedacted` | The record's content was removed by a retention schedule. |
| `ythril:edgeType` | An edge's type, stated on its reifier. |
| `ythril:endpointFrom` | A kind of record an edge type may start at. |
| `ythril:endpointTo` | A kind of record an edge type may end at. |
| `ythril:fileTriplesWithheld` | The export holds no file statements of some space it covers, because its caller may not read files there. |
| `ythril:leftOutCount` | How many property values a page of an export left out because none is one plain value that fits its property. |
| `ythril:leftOutKey` | The property key of a left-out value. |
| `ythril:leftOutReason` | Why a value was left out, in words. |
| `ythril:leftOutRecord` | The record a left-out value belongs to. |
| `ythril:leftOutValue` | A property value a page of an export left out, as a node naming its record, its key and why. |
| `ythril:mergeFn` | The function that merges two values of a property when two members change it at once. |
| `ythril:namingPattern` | A pattern every entity name of a type must match. |
| `ythril:nextAfter` | The cursor that continues an export after this page, passed back as its after parameter. |
| `ythril:path` | A file's path within its space. |
| `ythril:pattern` | A pattern every text value of a property must match, as Ythril checks it: an ECMAScript regular expression, unanchored. It is also sh:pattern only where SPARQL regular expressions read it alike. |
| `ythril:recordCount` | How many records a page of an export holds. |
| `ythril:recurrenceFreq` | How often a chrono record recurs: daily, weekly, monthly or yearly. |
| `ythril:recurrenceInterval` | Every how many periods of its frequency a chrono record recurs. |
| `ythril:recurrenceUntil` | The date or time after which a chrono record no longer recurs. |
| `ythril:requiredEdgeProperty` | A property every edge of a type must carry. |
| `ythril:retentionContentDays` | How many days the content of a record of a type is kept before it is removed and the record stays. |
| `ythril:retentionDays` | How many days a record of a type is kept before it is deleted. |
| `ythril:rule` | A rule a record of a type or the space must satisfy, written as a node with a name, an expression and a message. |
| `ythril:ruleExpression` | The expression of a rule, as the space states it. |
| `ythril:ruleKinds` | The kinds of record a space rule applies to. |
| `ythril:ruleMessage` | The message a rule gives when a record breaks it. |
| `ythril:ruleName` | The name of a rule. |
| `ythril:sizeBytes` | A file's size in bytes. |
| `ythril:status` | A chrono record's status. |
| `ythril:strictLinkage` | Whether the space refuses an edge whose endpoints do not exist. |
| `ythril:superseded` | The record has been superseded by a later one. |
| `ythril:suppressEmbeddings` | Records of a type are stored but not embedded for similarity search. |
| `ythril:unresolvedRef` | A type refers to a schema library entry this export could not resolve. |
| `ythril:validationMode` | How strictly the space checks records against its schema. |
| `ythril:weight` | An edge's weight, stated on its reifier. |
| `ythril:whenDuePasses` | What happens to a chrono record of a type when its time has passed. |
