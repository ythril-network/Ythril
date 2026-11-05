/**
 * The names a built declaration file exports, told apart as values and types: the ONE reader, for the gates that hold a package entry to a list.
 *
 * ## The question it answers
 *
 * *"Which values and which types does this `.d.ts` export, `export *` followed?"* `Object.keys` of the built module cannot see a type, and `export *`
 * hands types on as silently as values, so the answer comes from the TypeScript checker. Two gates ask it of two entries of `@ythril/schema` (the app
 * entry's surface test and the from-typescript entry's); a copy in the second would read a type as a value on the day one of them was fixed.
 */
import assert from 'node:assert/strict';
import ts from 'typescript';

/** Every name `dts` (an absolute path) exports, as `{ values, types }`, each sorted. Throws when the checker cannot read the file. */
export function declaredExports(dts) {
  const program = ts.createProgram([dts], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(dts);
  assert.ok(source, `the checker cannot read ${dts}: build the package first`);
  const values = [];
  const types = [];
  for (const s of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) {
    const target = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    (target.flags & ts.SymbolFlags.Value ? values : types).push(s.name);
  }
  return { values: values.sort(), types: types.sort() };
}
