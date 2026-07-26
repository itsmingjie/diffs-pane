import { describe, expect, it } from 'vitest';

import {
  anchorTextForRange,
  findUniqueAnchor,
  hunkExcerptForRange,
  parsePatch,
  sideLines,
  unquoteGitPath,
} from '../src/shared/patch.js';

const SIMPLE = `diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
 const d = 5;
`;

describe('parsePatch', () => {
  it('parses a simple modification with line numbers', () => {
    const files = parsePatch(SIMPLE);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.path).toBe('src/app.ts');
    expect(file.kind).toBe('modified');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks).toHaveLength(1);

    const adds = sideLines(file, 'additions');
    expect(adds.map((l) => [l.line, l.text])).toEqual([
      [1, 'const a = 1;'],
      [2, 'const b = 3;'],
      [3, 'const c = 4;'],
      [4, 'const d = 5;'],
    ]);
    const dels = sideLines(file, 'deletions');
    expect(dels.find((l) => l.text === 'const b = 2;')?.line).toBe(2);
  });

  it('parses added and deleted files', () => {
    const patch = `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
    const files = parsePatch(patch);
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      ['new.txt', 'added'],
      ['gone.txt', 'deleted'],
    ]);
  });

  it('parses renames with and without content changes', () => {
    const patch = `diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
--- a/old name.txt
+++ b/new name.txt
@@ -1,2 +1,2 @@
 keep
-x
+y
`;
    const files = parsePatch(patch);
    expect(files[0]!.kind).toBe('renamed');
    expect(files[0]!.path).toBe('new name.txt');
    expect(files[0]!.prevPath).toBe('old name.txt');
  });

  it('parses binary changes', () => {
    const patch = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`;
    const files = parsePatch(patch);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toHaveLength(0);
  });

  it('handles quoted unusual paths', () => {
    const patch = `diff --git "a/we\\"ird\\ttab.txt" "b/we\\"ird\\ttab.txt"
index 111..222 100644
--- "a/we\\"ird\\ttab.txt"
+++ "b/we\\"ird\\ttab.txt"
@@ -1 +1 @@
-a
+b
`;
    const files = parsePatch(patch);
    expect(files[0]!.path).toBe('we"ird\ttab.txt');
  });

  it('handles empty patches', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('unquoteGitPath', () => {
  it('handles escapes and octal sequences', () => {
    expect(unquoteGitPath('"a\\"b"')).toBe('a"b');
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there');
    expect(unquoteGitPath('plain')).toBe('plain');
  });
});

describe('anchoring', () => {
  const file = parsePatch(SIMPLE)[0]!;

  it('extracts anchor text and hunk excerpts', () => {
    expect(anchorTextForRange(file, 'additions', 2, 3)).toBe('const b = 3;\nconst c = 4;');
    const excerpt = hunkExcerptForRange(file, 'additions', 2);
    expect(excerpt).toContain('@@ -1,4 +1,4 @@');
    expect(excerpt).toContain('+const b = 3;');
    expect(anchorTextForRange(file, 'additions', 99, 99)).toBeNull();
  });

  it('finds unique anchors and rejects ambiguity', () => {
    expect(findUniqueAnchor(file, 'additions', 'const b = 3;')).toBe(2);
    const ambiguous = `diff --git a/x b/x
--- a/x
+++ b/x
@@ -1,2 +1,4 @@
 same
+same
+other
 tail
`;
    const ambFile = parsePatch(ambiguous)[0]!;
    expect(findUniqueAnchor(ambFile, 'additions', 'same')).toBeNull();
    expect(findUniqueAnchor(ambFile, 'additions', 'other')).toBe(3);
    expect(findUniqueAnchor(ambFile, 'additions', 'missing')).toBeNull();
  });
});
