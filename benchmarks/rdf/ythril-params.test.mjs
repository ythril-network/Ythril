/**
 * The parameter mapper (Q-759): the BSBM driver's parameters name the generator's addresses, the import minted new
 * ones, and the run must ask Ythril about the records Ythril holds. Cases give the mapper a lookup table (what the
 * lookup queries answered) and read what comes out; none needs an engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADDRESS_PREDICATE, lookupQueries, mapParameters, parameterAddresses, tableFromBindings } from './ythril-params.mjs';

const I = 'http://www4.wiwiss.fu-berlin.de/bizer/bsbm/v01/instances/';
const iri = (tail) => `${I}${tail}`;
const ang = (tail) => `<${iri(tail)}>`;
const minted = (n) => `https://ythril-bench.invalid/ld/bsbm-1000/entity/id-${n}`;

const file = () => ({
  size: 1000,
  params: {
    Q1: [{ ProductType: ang('ProductType66'), ProductFeature1: ang('ProductFeature3'), ProductFeature2: ang('ProductFeature1967'), x: '136' }],
    Q2: [{ ProductXYZ: ang('dataFromProducer6/Product272') }],
    Q7: [{ ProductXYZ: ang('dataFromProducer17/Product801'), currentDate: '"2008-06-20T00:00:00"^^<http://www.w3.org/2001/XMLSchema#dateTime>' }],
    Q9: [{ ReviewXYZ: ang('dataFromRatingSite1/Review4194') }],
    Q11: [{ OfferXYZ: ang('dataFromVendor1/Offer1250') }, { OfferXYZ: ang('dataFromVendor1/Offer1250') }],
  },
});

const tableOf = (f) => {
  let n = 0;
  return new Map(parameterAddresses(f).map((a) => [a, minted(n++)]));
};

test('the addresses to map are the instances the parameters name, each once; a class and a number or date are not among them', () => {
  const got = parameterAddresses(file());
  assert.deepEqual([...got].sort(), [
    iri('ProductFeature1967'), iri('ProductFeature3'), iri('dataFromProducer17/Product801'), iri('dataFromProducer6/Product272'),
    iri('dataFromRatingSite1/Review4194'), iri('dataFromVendor1/Offer1250'),
  ].sort());
});

test('a parameter holding an address under a placeholder the mapper does not know is refused, not passed through', () => {
  const f = file();
  f.params.Q2 = [{ ProductXYZ: ang('dataFromProducer6/Product272'), Surprise: ang('dataFromProducer6/Product5') }];
  assert.throws(() => parameterAddresses(f), /Surprise/);
});

test('mapping puts the record Ythril minted in place of every instance address and leaves classes, numbers and dates', () => {
  const f = file();
  const table = tableOf(f);
  const { file: out, mapped } = mapParameters(f, table);
  assert.equal(out.params.Q2[0].ProductXYZ, `<${table.get(iri('dataFromProducer6/Product272'))}>`);
  assert.equal(out.params.Q1[0].ProductFeature1, `<${table.get(iri('ProductFeature3'))}>`);
  assert.equal(out.params.Q1[0].ProductType, ang('ProductType66'), 'a class keeps its own address');
  assert.equal(out.params.Q1[0].x, '136');
  assert.equal(out.params.Q7[0].currentDate, f.params.Q7[0].currentDate);
  assert.equal(out.params.Q11[1].OfferXYZ, out.params.Q11[0].OfferXYZ, 'one address maps to one record wherever it is named');
  assert.equal(mapped, 6, 'every distinct instance address counts once');
  assert.equal(f.params.Q2[0].ProductXYZ, ang('dataFromProducer6/Product272'), 'the input is not changed');
});

test('an address that maps to nothing fails the whole mapping and names every such address', () => {
  const f = file();
  const table = tableOf(f);
  table.delete(iri('dataFromRatingSite1/Review4194'));
  table.delete(iri('ProductFeature3'));
  assert.throws(() => mapParameters(f, table), (err) => /Review4194/.test(err.message) && /ProductFeature3\b/.test(err.message) && /map to no record/.test(err.message));
});

test('a table entry nobody asked for is no harm, but an empty minted address is no mapping', () => {
  const f = file();
  const table = tableOf(f);
  table.set(iri('Unrelated1'), minted(99));
  assert.equal(mapParameters(f, table).mapped, 6);
  table.set(iri('dataFromProducer6/Product272'), '');
  assert.throws(() => mapParameters(f, table), /Product272/);
});

test('the lookup rows become a table; one address answered by two records is ambiguous and refused', () => {
  const rows = [{ o: iri('A'), s: minted(1) }, { o: iri('B'), s: minted(2) }];
  assert.deepEqual([...tableFromBindings(rows)], [[iri('A'), minted(1)], [iri('B'), minted(2)]]);
  assert.deepEqual([...tableFromBindings([...rows, { o: iri('A'), s: minted(1) }])], [[iri('A'), minted(1)], [iri('B'), minted(2)]], 'the same pair twice is one mapping');
  assert.throws(() => tableFromBindings([...rows, { o: iri('A'), s: minted(3) }]), /ambiguous/);
});

test('there is one lookup query per class, a single read of the stated addresses asking for that class\'s addresses only', () => {
  const qs = lookupQueries(parameterAddresses(file()));
  assert.deepEqual(qs.map((q) => q.class).sort(), ['Offer', 'Product', 'ProductFeature', 'Review']);
  const by = Object.fromEntries(qs.map((q) => [q.class, q.query]));
  assert.match(by.Product, new RegExp(ADDRESS_PREDICATE.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.ok(by.Product.includes(`"${iri('dataFromProducer6/Product272')}"`) && by.Product.includes(`"${iri('dataFromProducer17/Product801')}"`));
  assert.ok(by.ProductFeature.includes(`"${iri('ProductFeature3')}"`) && by.ProductFeature.includes(`"${iri('ProductFeature1967')}"`));
  assert.ok(!by.Product.includes('ProductFeature'), 'a feature is not looked up as a product');
  assert.ok(!by.Product.includes('Review4194'));
  assert.ok(!/VALUES/.test(by.Product), 'a VALUES list is one evaluation per value on the endpoint (seconds apiece), a filter is one read');
});
