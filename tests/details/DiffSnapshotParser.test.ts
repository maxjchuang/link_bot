import { describe, expect, it } from 'vitest';
import { parseDiffSnapshot } from '../../src/details/DiffSnapshotParser.js';

describe('diff snapshot parser', () => {
  it('preserves headers and per-file hunks without counting header markers as additions', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+next\n';
    expect(parseDiffSnapshot(diff)).toEqual({ complete: true, files: [
      { path: 'a.ts', added: 2, removed: 1, binary: false, text: diff },
    ] });
  });

  it('handles quoted paths, renames and binary files, downgrading unknown or malformed input', () => {
    const diff = 'diff --git "a/old name" "b/new name"\nsimilarity index 100%\nrename from old name\nrename to new name\n'
      + 'diff --git a/p.png b/p.png\nBinary files a/p.png and b/p.png differ\n';
    expect(parseDiffSnapshot(diff)).toMatchObject({ complete: false, files: [
      { path: 'new name', added: 0, removed: 0 }, { path: 'p.png', binary: true },
    ] });
    expect(parseDiffSnapshot('+unframed output').complete).toBe(false);
    expect(parseDiffSnapshot('diff --git a/a b/a\ngarbage\n').complete).toBe(false);
    expect(parseDiffSnapshot('diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n').complete).toBe(false);
    expect(parseDiffSnapshot('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n').complete).toBe(false);
  });
});
