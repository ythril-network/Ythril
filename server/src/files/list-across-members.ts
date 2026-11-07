import { listDir, type FileEntry } from './files.js';
import { fileReadFaultOf } from './read-fault.js';

/**
 * A directory listed across the members a read reaches, merged by NAME: the one place that merge is written.
 *
 * ## The question it answers, and what it prevents
 *
 * "What is in this directory, across the spaces this read covers?" MCP `list_dir` and both REST listing branches each carried their own copy of
 * the loop (list every member, keep the first entry of a name, swallow every error), and each swallowed a failing disk as an empty directory.
 * Here a member whose directory is absent contributes nothing (`fileReadFaultOf`: absent, a path the sandbox refused, a retired member space) and
 * a storage fault is thrown as `FileSystemFault`, answered `500 file_system_fault` on every door. The guard is inside, so no caller can drop it.
 *
 * Names are de-duplicated by the bare name, first member wins: a name that is a file in one member and a folder in another is ONE entry, the
 * first member's (stated in `list_dir`'s description).
 */
export async function listAcrossMembers(memberIds: readonly string[], dirPath: string): Promise<FileEntry[]> {
  const seen = new Set<string>();
  const allEntries: FileEntry[] = [];
  for (const mid of memberIds) {
    let entries: FileEntry[];
    try {
      entries = await listDir(mid, dirPath);
    } catch (err) {
      const fault = fileReadFaultOf(err);
      if (fault) throw fault;
      continue;
    }
    for (const e of entries) {
      if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
    }
  }
  return allEntries;
}
