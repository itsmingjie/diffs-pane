import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePatch } from '../src/shared/patch.js';
import { detectBackend } from '../src/vcs/detect.js';
import { type GitBackend } from '../src/vcs/git.js';
import { cleanup, git, makeGitRepo, makeTempDir, writeFileSyncDeep } from './helpers.js';

describe('GitBackend', () => {
  let dir: string;
  let stateDir: string;
  let backend: GitBackend;

  beforeEach(async () => {
    dir = makeTempDir('dp-git-');
    stateDir = makeTempDir('dp-git-state-');
    makeGitRepo(dir, { 'README.md': 'hello\n', 'src/app.ts': 'const a = 1;\n' });
    backend = (await detectBackend(dir, stateDir)) as GitBackend;
    expect(backend.kind).toBe('git');
  });

  afterEach(() => {
    cleanup(dir);
    cleanup(stateDir);
  });

  it('unstaged: working tree vs index, plus untracked unignored files', async () => {
    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 2;\n');
    writeFileSyncDeep(join(dir, 'untracked.txt'), 'new\n');
    writeFileSyncDeep(join(dir, '.gitignore'), 'ignored.txt\n');
    writeFileSyncDeep(join(dir, 'ignored.txt'), 'should not appear\n');

    const files = parsePatch(await backend.computePatch('unstaged', {}));
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('untracked.txt');
    expect(paths).not.toContain('ignored.txt');
    expect(files.find((f) => f.path === 'untracked.txt')?.kind).toBe('added');

    // Staged-only changes must not appear in unstaged.
    git(['add', 'src/app.ts'], dir);
    const after = parsePatch(await backend.computePatch('unstaged', {}));
    expect(after.map((f) => f.path)).not.toContain('src/app.ts');
  });

  it('does not mutate the index or worktree', async () => {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], dir).trim();
    writeFileSyncDeep(join(dir, 'untracked.txt'), 'new\n');
    const before = readFileSync(join(gitDir, 'index'));
    const objectsBefore = git(['count-objects', '-v'], dir);
    await backend.computePatch('unstaged', {});
    await backend.computePatch('branch', {});
    const statusAfter = git(['status', '--porcelain'], dir);
    expect(statusAfter).toContain('?? untracked.txt');
    expect(readFileSync(join(gitDir, 'index')).equals(before)).toBe(true);
    expect(git(['count-objects', '-v'], dir)).toBe(objectsBefore);
  });

  it('branch: merge base through index and working tree, plus untracked', async () => {
    git(['checkout', '-b', 'feature'], dir);
    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 1;\nconst b = 2;\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'feature work'], dir);
    writeFileSyncDeep(join(dir, 'wip.txt'), 'uncommitted\n');

    const files = parsePatch(await backend.computePatch('branch', { base: 'main' }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('src/app.ts')?.additions).toBe(1);
    expect(byPath.get('wip.txt')?.kind).toBe('added');
  });

  it('branch: auto-resolves the base and reports empty diff on main', async () => {
    const patch = await backend.computePatch('branch', {});
    expect(patch).toBe('');
  });

  it('shares the current work-tree snapshot within one refresh pass', async () => {
    const snapshotKey = {};
    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 2;\n');
    const first = await backend.computePatch('branch', { base: 'main', snapshotKey });

    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 3;\n');
    expect(await backend.computePatch('branch', { base: 'main', snapshotKey })).toBe(first);
    expect(await backend.computePatch('branch', { base: 'main' })).not.toBe(first);
  });

  it('turn: includes changes made during the turn even on pre-dirty files', async () => {
    // File is dirty before the turn starts.
    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 1;\npre-dirty\n');
    const baseline = await backend.captureTurnBaseline();
    // Baselines survive daemon/backend restarts in diffs-pane's private object store.
    backend = (await detectBackend(dir, stateDir)) as GitBackend;

    // No changes yet: turn diff is empty even though the file is dirty.
    expect(await backend.computePatch('turn', { turnBaseline: baseline })).toBe('');

    // Turn edits the pre-dirty file and adds a new one.
    writeFileSyncDeep(join(dir, 'src/app.ts'), 'const a = 1;\npre-dirty\nturn-edit\n');
    writeFileSyncDeep(join(dir, 'turn-new.txt'), 'made in turn\n');

    const files = parsePatch(await backend.computePatch('turn', { turnBaseline: baseline }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('src/app.ts')?.additions).toBe(1);
    expect(byPath.get('turn-new.txt')?.kind).toBe('added');
    // The pre-turn edit itself is not part of the turn diff.
    const appPatch = byPath.get('src/app.ts')!.raw;
    expect(appPatch).not.toContain('+pre-dirty');
  });

  it('handles renames, deletions, binary files, and unusual paths', async () => {
    const baseline = await backend.captureTurnBaseline();
    git(['mv', 'README.md', 'README.markdown'], dir);
    git(['rm', 'src/app.ts'], dir);
    writeFileSyncDeep(join(dir, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSyncDeep(join(dir, 'path with spaces/weird (file).txt'), 'x\n');

    const files = parsePatch(await backend.computePatch('turn', { turnBaseline: baseline }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('README.markdown')?.kind).toBe('renamed');
    expect(byPath.get('README.markdown')?.prevPath).toBe('README.md');
    expect(byPath.get('src/app.ts')?.kind).toBe('deleted');
    expect(byPath.get('img.bin')?.binary).toBe(true);
    expect(byPath.get('path with spaces/weird (file).txt')?.kind).toBe('added');
  });

  it('handles an empty repository with no commits', async () => {
    const empty = makeTempDir('dp-git-empty-');
    try {
      git(['init', '--initial-branch', 'main'], empty);
      const emptyBackend = (await detectBackend(empty, stateDir)) as GitBackend;
      writeFileSyncDeep(join(empty, 'first.txt'), 'content\n');
      for (const filter of ['unstaged', 'branch'] as const) {
        const files = parsePatch(await emptyBackend.computePatch(filter, {}));
        expect(files.map((f) => f.path)).toContain('first.txt');
      }
    } finally {
      cleanup(empty);
    }
  });

  it('turn filter without a baseline yields an empty diff', async () => {
    expect(await backend.computePatch('turn', {})).toBe('');
  });
});
