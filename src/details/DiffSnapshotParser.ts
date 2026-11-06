export interface ParsedDiffFile { path: string; added: number; removed: number; binary: boolean; text: string }
export interface ParsedDiffSnapshot { complete: boolean; files: ParsedDiffFile[] }

/** Conservative parser: malformed or unsupported snapshots are review text, not applicable patches. */
export function parseDiffSnapshot(text: string): ParsedDiffSnapshot {
  const starts: Array<{ index: number; path: string }> = [];
  let complete = true;
  for (const match of text.matchAll(/^diff --git ("(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)\r?$/gm)) {
    if (starts.length >= 2048) { complete = false; break; }
    let path = match[2]!;
    try { if (path.startsWith('"')) path = JSON.parse(path) as string; } catch { complete = false; }
    starts.push({ index: match.index!, path: path.replace(/^b\//, '') });
  }
  if (!starts.length || starts[0]!.index !== 0) return { complete: false, files: [] };
  const files: ParsedDiffFile[] = [];
  const paths = new Set<string>();
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    if (paths.has(start.path)) return { complete: false, files: [] };
    paths.add(start.path);
    const block = text.slice(start.index, starts[index + 1]?.index ?? text.length);
    let added = 0, removed = 0, oldRemaining = 0, newRemaining = 0;
    let binary = false, inHunk = false, oldHeader = false, newHeader = false, meaningfulMetadata = false;
    for (const match of block.matchAll(/[^\n]*(?:\n|$)/g)) {
      if (!match[0].length) continue;
      const line = match[0].replace(/\r?\n$/, '');
      if (line.startsWith('diff --git') && match.index !== 0) complete = false;
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true;
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunk) {
        if (!oldHeader || !newHeader) complete = false;
        if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) complete = false;
        oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
        inHunk = true;
      } else if (inHunk) {
        if (line.startsWith('+')) { added++; newRemaining--; }
        else if (line.startsWith('-')) { removed++; oldRemaining--; }
        else if (line.startsWith(' ')) { oldRemaining--; newRemaining--; }
        else if (!line.startsWith('\\ No newline at end of file')) complete = false;
        if (oldRemaining < 0 || newRemaining < 0) complete = false;
      } else if (match.index !== 0) {
        if (line.startsWith('--- ')) oldHeader = true;
        else if (line.startsWith('+++ ')) newHeader = true;
        else if (/^(?:index |(?:new file|deleted file|old|new) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) |Binary files |GIT binary patch)/.test(line)) meaningfulMetadata = true;
        else complete = false;
      }
    }
    if (inHunk && (oldRemaining !== 0 || newRemaining !== 0)) complete = false;
    if (!inHunk && (!meaningfulMetadata || oldHeader || newHeader)) complete = false;
    // Binary placeholders do not contain a complete applicable patch.
    if (binary) complete = false;
    files.push({ path: start.path, added, removed, binary, text: block });
  }
  return { complete, files };
}
