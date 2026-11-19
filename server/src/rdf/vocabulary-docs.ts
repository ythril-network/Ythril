/**
 * The published `ythril:` vocabulary, generated from its one source (Q-749, design r4 section 5.1; owner, 2026-11-18, the vocabulary address
 * and the property rule).
 *
 * ## What it prevents
 *
 * A vocabulary page written by hand drifts from the term table, and the property rule on it from the rule the decision record states. The two
 * published files, `docs/rdf/ythril.ttl` (what the redirect at the namespace address serves to a Turtle request) and
 * `docs/rdf/ythril-vocabulary.md` (what it serves to everything else), are exactly what {@link vocabularyTurtle} and {@link vocabularyPage}
 * answer from `ythril-vocabulary.ts`, and `every-ythril-term-is-declared-in-the-vocabulary.test.js` fails when a file and its source differ.
 * After a change to the table, write the two files again from these two functions.
 *
 * The Turtle is written by the one writer (`serialize.ts`), so the file is valid by the same rules every export is.
 */
import { iri, plain, stdIri, quad, type Quad } from './literals.js';
import { createRdfWriter } from './serialize.js';
import { PROPERTY_RULE_TEXT, STANDARD_PREFIXES, YTHRIL_NS, YTHRIL_TERMS, ythrilIri, type YthrilTerm } from './ythril-vocabulary.js';

/** The decision record that states the property rule, as the page links it (relative to `docs/rdf/`). */
const DECISION_RECORD_LINK = '../decisions/23-a-property-holds-one-plain-value-and-structure-is-an-edge-or-a-link.md';

/** The ontology the terms are defined by: the namespace address without its `#`. */
const ontologyAddress = (): string => YTHRIL_NS.replace(/#$/, '');

const byName = (a: YthrilTerm, b: YthrilTerm): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** `docs/rdf/ythril.ttl`: the vocabulary as Turtle, one class or property per term with its label and comment, defined by the namespace. */
export function vocabularyTurtle(): string {
  const ontology = iri(ontologyAddress());
  const quads: Quad[] = [
    quad(ontology, stdIri('rdf', 'type'), stdIri('owl', 'Ontology')),
    quad(ontology, stdIri('rdfs', 'label'), plain('Ythril vocabulary')),
    quad(ontology, stdIri('rdfs', 'comment'), plain(PROPERTY_RULE_TEXT)),
  ];
  for (const t of YTHRIL_TERMS) {
    const s = iri(ythrilIri(t.name));
    quads.push(
      quad(s, stdIri('rdf', 'type'), stdIri(t.kind === 'class' ? 'rdfs' : 'rdf', t.kind === 'class' ? 'Class' : 'Property')),
      quad(s, stdIri('rdfs', 'label'), plain(t.name)),
      quad(s, stdIri('rdfs', 'comment'), plain(t.comment)),
      quad(s, stdIri('rdfs', 'isDefinedBy'), ontology),
    );
  }
  const prefixes = { rdf: STANDARD_PREFIXES['rdf']!, rdfs: STANDARD_PREFIXES['rdfs']!, owl: STANDARD_PREFIXES['owl']!, ythril: YTHRIL_NS };
  const writer = createRdfWriter('turtle', { prefixes });
  return writer.open() + writer.write({ quads }) + writer.close();
}

function termTable(kind: YthrilTerm['kind']): string {
  const rows = YTHRIL_TERMS.filter(t => t.kind === kind).sort(byName).map(t => `| \`ythril:${t.name}\` | ${t.comment.replace(/\|/g, '\\|')} |`);
  return ['| Term | Meaning |', '|---|---|', ...rows].join('\n');
}

/** `docs/rdf/ythril-vocabulary.md`: the page, opening with the property rule. */
export function vocabularyPage(): string {
  return [
    '# Ythril vocabulary',
    '',
    PROPERTY_RULE_TEXT,
    '',
    `The rule is stated, with the owner's words and the reasons for it, in [decision record 23](${DECISION_RECORD_LINK}).`,
    '',
    '## Address',
    '',
    ['The terms Ythril defines for its own RDF export live in one namespace, `', YTHRIL_NS, '`, written `ythril:` in the export\'s Turtle, TriG and JSON-LD. '
      + 'The address redirects: a request for Turtle is sent to the file `ythril.ttl` of this folder, any other request to this page. '
      + 'Everything else an export says is stated with the standard vocabularies RDF, RDFS, OWL, SHACL, schema.org, OWL-Time, Dublin Core terms and PROV-O.'].join(''),
    '',
    'This page and `ythril.ttl` are generated from one table in the server (`server/src/rdf/ythril-vocabulary.ts`) and are not edited by hand.',
    '',
    '## Classes',
    '',
    termTable('class'),
    '',
    '## Properties',
    '',
    termTable('property'),
    '',
  ].join('\n');
}
