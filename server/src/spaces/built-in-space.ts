/**
 * May this space be renamed or deleted at all: the one answer to "is it built in".
 *
 * ## What it prevents
 *
 * The built-in check was written in four places — the rename's pre-check and its body, the deletion's pre-check and its body — each
 * a `space.builtIn` read and a sentence of its own. A built-in space is the instance's own (`general`, the flows spaces): losing one
 * is not an operator's choice, and a body that reads the flag differently from its door lets the door say no and a resumed act say yes.
 *
 * It answers with the error the doors map to a `400` ("built-in" in the sentence), or `null`, so a caller that forgot to read the
 * answer cannot proceed by accident: the refusal is a value it has to throw or return. A space that does not exist is not built in —
 * "not found" is the caller's own refusal, asked first.
 */
export function builtInRefusal(space: { readonly id: string; readonly builtIn?: boolean } | undefined, verb: 'rename' | 'delete'): Error | null {
  return space?.builtIn ? new Error(`Cannot ${verb} built-in space '${space.id}'`) : null;
}
