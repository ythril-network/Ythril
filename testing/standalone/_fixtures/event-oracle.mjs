/**
 * A node:test reporter that writes node's OWN pass/fail events raw, one JSON object per line — the independent
 * oracle the timing-reporter gates compare the timing file against. Deliberately dumb: it knows nothing of the
 * timing schema, so what a gate derives from it is node's account of the run and not the reporter's.
 *
 * Lives in `_fixtures`, run only by explicit path from `testing/standalone/_timing-runs.mjs`.
 */
export default async function* oracle(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    yield JSON.stringify({
      type: ev.type,
      name: d.name,
      nesting: d.nesting,
      file: d.file,
      kind: d.details?.type ?? 'test',
      skip: d.skip ?? false,
      todo: d.todo ?? false,
      ms: d.details?.duration_ms,
    }) + '\n';
  }
}
