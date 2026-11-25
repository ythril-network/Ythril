/**
 * Binds the BSBM parameters to the records Ythril holds.
 *
 * The test driver's parameters name the generator's addresses (`.../dataFromProducer6/Product272`). The RDF import
 * mints a new address per record (`<base>entity/<uuid>`) and keeps the generator's nowhere, so a query asked of Ythril
 * with the generator's address answers nothing. The variant therefore carries each subject's address as a plain string
 * (`rdfs:seeAlso "<address>"`, see prepare.mjs); after the load the harness asks Ythril which record carries each
 * parameter address, and the measured runs use those records' addresses. Oxigraph keeps the generator's.
 *
 * ## What this prevents
 *
 * - **A query about nothing timed as a query about something.** An address that maps to no record throws, naming
 *   every such address; the run stops. It is never sent as it is and recorded as a 0-row answer.
 * - **Two records for one address.** A lookup that answers two records for one address is `ambiguous` and refused.
 * - **A new placeholder that slips past.** An address under a placeholder the mapper does not know (it is neither an
 *   instance it maps nor a class it leaves) throws, so a changed query set cannot be sent with unmapped addresses.
 * - **A class mapped to a record.** A product type is a class in the data, and Ythril keeps a class's own address; it
 *   is left as it is.
 */
export { ADDRESS_PREDICATE } from './prepare.mjs';
import { ADDRESS_PREDICATE } from './prepare.mjs';

/** Placeholders that carry an instance (a record Ythril minted an address for), by the class of that instance. */
const INSTANCE_PLACEHOLDERS = [
  [/^ProductXYZ$/, 'Product'],
  [/^ProductFeature\d*$/, 'ProductFeature'],
  [/^ReviewXYZ$/, 'Review'],
  [/^OfferXYZ$/, 'Offer'],
];
/** Placeholders that carry a class: its address is the class's own and stays. */
const CLASS_PLACEHOLDERS = [/^ProductType\d*$/];

const isAddress = (value) => typeof value === 'string' && /^<[^<>\s]*>$/.test(value);
const bare = (address) => address.slice(1, -1);

/** The distinct instance addresses (without brackets) a parameters file names, in order of first appearance. */
export function parameterAddresses(paramsFile) {
  const out = new Set();
  for (const sets of Object.values(paramsFile.params)) {
    for (const set of sets) {
      for (const [name, value] of Object.entries(set)) {
        if (!isAddress(value)) continue;
        if (INSTANCE_PLACEHOLDERS.some(([re]) => re.test(name))) out.add(bare(value));
        else if (!CLASS_PLACEHOLDERS.some((re) => re.test(name))) {
          throw new Error(`parameter ${name} holds an address and the mapper knows no rule for it: say whether it is an instance or a class`);
        }
      }
    }
  }
  return [...out];
}

/** The class of an instance address, from its local name (`Product272`, `Offer1250`, ...). */
function classOf(address) {
  const m = /\/(ProductFeature|Product|Review|Offer)\d+$/.exec(address);
  if (!m) throw new Error(`cannot tell the class of ${address}: its local name is not one of Product, ProductFeature, Review, Offer`);
  return m[1];
}

const stringLiteral = (text) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/**
 * One lookup query per class: the records whose stated address is one of that class's parameter addresses, as
 * `(?o address, ?s record)`. `[{ class, query }]`. The addresses go in a FILTER, not a VALUES list: the endpoint
 * evaluates a VALUES list once per value (seconds apiece), a FILTER in one read of the stated addresses; and it
 * answers no more rows than the parameters ask for (it refuses an answer of over 10 000 rows).
 */
export function lookupQueries(addresses) {
  const byClass = new Map();
  for (const a of addresses) {
    const c = classOf(a);
    if (!byClass.has(c)) byClass.set(c, []);
    byClass.get(c).push(a);
  }
  return [...byClass].map(([klass, list]) => ({
    class: klass,
    query: `SELECT ?o ?s WHERE { ?s <${ADDRESS_PREDICATE}> ?o . FILTER(?o IN (${list.map(stringLiteral).join(', ')})) }`,
  }));
}

/** `Map(address -> minted address)` from lookup rows `{ o, s }`; one address answered by two records throws. */
export function tableFromBindings(rows) {
  const table = new Map();
  for (const { o, s } of rows) {
    if (table.has(o) && table.get(o) !== s) throw new Error(`ambiguous: ${o} is carried by two records (${table.get(o)} and ${s})`);
    table.set(o, s);
  }
  return table;
}

/**
 * The parameters with every instance address replaced by the minted one: `{ file, mapped }`, `mapped` the number of
 * distinct addresses mapped. Throws, naming each, when any address has no (or an empty) record in `table`.
 */
export function mapParameters(paramsFile, table) {
  const addresses = parameterAddresses(paramsFile);
  const missing = addresses.filter((a) => !table.get(a));
  if (missing.length > 0) throw new Error(`${missing.length} parameter address(es) map to no record: ${missing.join(', ')}`);
  const params = {};
  for (const [query, sets] of Object.entries(paramsFile.params)) {
    params[query] = sets.map((set) => Object.fromEntries(Object.entries(set).map(([name, value]) => [
      name,
      isAddress(value) && INSTANCE_PLACEHOLDERS.some(([re]) => re.test(name)) ? `<${table.get(bare(value))}>` : value,
    ])));
  }
  return { file: { ...paramsFile, params }, mapped: addresses.length };
}
