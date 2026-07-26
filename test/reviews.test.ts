import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ReviewStore, readReviews } from '../src/store/reviews.js';
import { cleanup, makeTempDir } from './helpers.js';

const ROOT = '/fake/worktree';

const PATCH_V1 = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 tail
`;

// Same content shifted down by two added lines at the top.
const PATCH_V2 = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,6 @@
+// header
+// more header
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 tail
`;

// The anchored line no longer exists.
const PATCH_V3 = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 9;
 tail
`;

describe('ReviewStore', () => {
  let stateDir: string;
  let store: ReviewStore;

  beforeEach(async () => {
    stateDir = makeTempDir('dp-reviews-');
    store = await ReviewStore.load(ROOT, stateDir);
  });

  afterEach(() => cleanup(stateDir));

  function createComment(overrides: Partial<Parameters<ReviewStore['create']>[0]> = {}) {
    return store.create({
      filter: 'branch',
      path: 'src/app.ts',
      side: 'additions',
      startLine: 2,
      endLine: 3,
      body: 'consider naming',
      anchorText: 'const b = 3;\nconst c = 4;',
      hunkExcerpt:
        '@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n tail',
      patchHash: 'hash-v1',
      ...overrides,
    });
  }

  it('creates, edits, and deletes comments on both sides', () => {
    const add = createComment();
    const del = createComment({
      side: 'deletions',
      startLine: 2,
      endLine: 2,
      anchorText: 'const b = 2;',
    });
    expect(store.list()).toHaveLength(2);

    store.update(add.id, 'updated body');
    expect(store.get(add.id)?.body).toBe('updated body');
    expect(store.get(add.id)?.updatedAt >= add.createdAt).toBe(true);

    expect(store.deleteMany([del.id, 'missing'])).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.delete('missing')).toBe(false);
  });

  it('persists across restart', async () => {
    const comment = createComment();
    const reloaded = await ReviewStore.load(ROOT, stateDir);
    expect(reloaded.get(comment.id)?.body).toBe('consider naming');
    expect(await readReviews(ROOT, stateDir)).toHaveLength(1);
  });

  it('re-anchors uniquely matched comments to new line numbers', () => {
    const comment = createComment();
    store.reanchor('branch', PATCH_V2, 'hash-v2');
    const updated = store.get(comment.id)!;
    expect(updated.outdated).toBe(false);
    expect(updated.startLine).toBe(4);
    expect(updated.endLine).toBe(5);
    expect(updated.patchHash).toBe('hash-v2');
    // The saved excerpt never changes.
    expect(updated.hunkExcerpt).toContain('@@ -1,3 +1,4 @@');
  });

  it('marks comments outdated when the anchor disappears, and recovers', () => {
    const comment = createComment();
    store.reanchor('branch', PATCH_V3, 'hash-v3');
    expect(store.get(comment.id)?.outdated).toBe(true);
    // Anchor returns: comment recovers.
    store.reanchor('branch', PATCH_V1, 'hash-v1b');
    expect(store.get(comment.id)?.outdated).toBe(false);
    expect(store.get(comment.id)?.startLine).toBe(2);
  });

  it('only re-anchors within the same source filter', () => {
    const comment = createComment({ filter: 'unstaged' });
    const changed = store.reanchor('branch', PATCH_V3, 'hash-v3');
    expect(changed).toBe(false);
    expect(store.get(comment.id)?.outdated).toBe(false);
    expect(store.get(comment.id)?.startLine).toBe(2);
  });
});
