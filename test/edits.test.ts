import { chmodSync, existsSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type DaemonServer } from '../src/daemon/server.js';
import { SessionManager } from '../src/daemon/sessions.js';
import type { FileContentsPayload } from '../src/shared/protocol.js';
import {
  cleanup,
  git,
  hasJj,
  jj,
  makeGitRepo,
  makeJjRepo,
  makeTempDir,
  writeFileSyncDeep,
} from './helpers.js';

for (const vcs of ['git', 'jj'] as const) {
  describe.skipIf(vcs === 'jj' && !hasJj())(`${vcs} local edits`, () => {
    let root: string;
    let state: string;
    let manager: SessionManager;
    let daemon: DaemonServer;
    let url: string;

    beforeEach(async () => {
      root = makeTempDir('dp-edit-repo-');
      state = makeTempDir('dp-edit-state-');
      if (vcs === 'git') {
        makeGitRepo(root);
        git(['config', 'user.name', 'Test'], root);
        git(['config', 'user.email', 'test@example.com'], root);
        git(['config', 'commit.gpgsign', 'false'], root);
      } else {
        makeJjRepo(root);
        jj(['config', 'set', '--repo', 'user.name', 'Test'], root);
        jj(['config', 'set', '--repo', 'user.email', 'test@example.com'], root);
      }
      writeFileSyncDeep(join(root, 'README.md'), 'hello\nexisting work\n');
      writeFileSyncDeep(join(root, 'unrelated.txt'), 'leave me alone\n');
      manager = new SessionManager(state, () => {});
      daemon = await startServer({ controlToken: 'test-token', manager });
      const response = await fetch(`http://127.0.0.1:${daemon.port}/control/sessions/ensure`, {
        method: 'POST',
        headers: { 'x-dp-control-token': 'test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ root, owner: 'test', filter: 'unstaged', watch: false }),
      });
      expect(response.ok).toBe(true);
      url = ((await response.json()) as { url: string }).url;
    });

    afterEach(async () => {
      await manager.stopAll();
      await new Promise<void>((resolve) => daemon.server.close(() => resolve()));
      cleanup(root);
      cleanup(state);
    });

    async function draft(path = 'README.md', contents = 'hello\nexisting work\ndp edit\n') {
      const response = await fetch(
        `${url}api/file?filter=unstaged&path=${encodeURIComponent(path)}`,
      );
      expect(response.ok).toBe(true);
      const file = (await response.json()) as FileContentsPayload;
      return { path, contents, expectedContentsHash: file.newContentsHash };
    }

    async function apply(action: 'commit' | 'discard', files: unknown[]) {
      return fetch(`${url}api/edits/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filter: 'unstaged', files }),
      });
    }

    function committed(path: string) {
      return vcs === 'git'
        ? git(['show', `HEAD:${path}`], root)
        : jj(['file', 'show', '-r', '@-', `root-file:${path}`], root);
    }

    it('commits only dp-edited files and leaves other local changes intact', async () => {
      if (vcs === 'git') git(['add', 'unrelated.txt'], root);
      const edit = await draft();
      const result = await apply('commit', [edit]);
      expect(await result.json()).toEqual({ ok: true });
      expect(committed('README.md')).toBe(edit.contents);
      const message =
        vcs === 'git'
          ? git(['log', '-1', '--format=%s'], root)
          : jj(['log', '--no-graph', '-r', '@-', '-T', 'description'], root);
      expect(message.trim()).toBe('dp: apply local edits');
      expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('leave me alone\n');
      if (vcs === 'git') {
        expect(git(['diff', '--cached', '--name-only'], root).trim()).toBe('unrelated.txt');
        expect(git(['ls-tree', '--name-only', 'HEAD'], root)).not.toContain('unrelated.txt');
      } else {
        expect(jj(['diff', '--summary'], root)).toContain('unrelated.txt');
        expect(jj(['diff', '--summary'], root)).not.toContain('README.md');
      }
    });

    it('commits an added file with a literal metacharacter path', async () => {
      const path = 'literal[1].txt';
      writeFileSyncDeep(join(root, path), 'new\n');
      const edit = await draft(path, 'new\ndp edit\n');
      const result = await apply('commit', [edit]);
      expect(await result.json()).toEqual({ ok: true });
      expect(committed(path)).toBe(edit.contents);
    });

    it('discards to the committed version, removes added files, and preserves unrelated files', async () => {
      writeFileSyncDeep(join(root, 'new.txt'), 'new\n');
      const edits = [await draft(), await draft('new.txt')];
      const result = await apply('discard', edits);
      expect(await result.json()).toEqual({ ok: true });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
      expect(existsSync(join(root, 'new.txt'))).toBe(false);
      expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('leave me alone\n');
    });

    it('rejects an entire stale batch before modifying any files', async () => {
      const edits = [await draft(), await draft('unrelated.txt')];
      writeFileSyncDeep(join(root, 'unrelated.txt'), 'external edit\n');
      for (const action of ['commit', 'discard'] as const) {
        const result = await apply(action, edits);
        expect(result.status).toBe(409);
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\nexisting work\n');
        expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('external edit\n');
      }
    });

    it('restores both paths of a discarded rename', async () => {
      writeFileSyncDeep(join(root, 'README.md'), 'hello\n');
      renameSync(join(root, 'README.md'), join(root, 'renamed.md'));
      const edit = await draft('renamed.md');
      const response = await apply('discard', [edit]);
      expect(await response.json()).toEqual({ ok: true });
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
      expect(existsSync(join(root, 'renamed.md'))).toBe(false);
    });

    it('rejects duplicate paths and paths outside the diff', async () => {
      const edit = await draft();
      expect((await apply('commit', [edit, edit])).status).toBe(400);
      expect((await apply('discard', [{ ...edit, path: '../outside' }])).status).toBe(422);
    });

    it('rejects files replaced with symlinks after hydration', async () => {
      const edit = await draft();
      cleanup(join(root, 'README.md'));
      symlinkSync(join(root, 'unrelated.txt'), join(root, 'README.md'));
      expect((await apply('commit', [edit])).status).toBe(422);
      expect(readFileSync(join(root, 'unrelated.txt'), 'utf8')).toBe('leave me alone\n');
    });

    if (vcs === 'git') {
      it('discards staging for edited files but preserves unrelated staged work', async () => {
        git(['add', 'README.md', 'unrelated.txt'], root);
        writeFileSyncDeep(join(root, 'README.md'), 'hello\nmore local work\n');
        const response = await apply('discard', [await draft()]);
        expect(await response.json()).toEqual({ ok: true });
        expect(git(['diff', '--cached', '--name-only'], root).trim()).toBe('unrelated.txt');
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\n');
      });

      it('keeps committed contents when synchronizing a locked index fails', async () => {
        const edit = await draft();
        writeFileSyncDeep(join(root, '.git', 'index.lock'), '');
        const response = await apply('commit', [edit]);
        expect(await response.json()).toEqual({
          ok: true,
          warning: expect.stringContaining('Commit created'),
        });
        expect(committed('README.md')).toBe(edit.contents);
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(edit.contents);
      });

      it('rolls back disk writes after a rejected commit and allows retrying the same drafts', async () => {
        const hooks = join(root, '.git', 'test-hooks');
        git(['config', 'core.hooksPath', hooks], root);
        const hook = join(hooks, 'pre-commit');
        writeFileSyncDeep(hook, '#!/bin/sh\nexit 1\n');
        chmodSync(hook, 0o755);
        const edit = await draft();
        expect((await apply('commit', [edit])).ok).toBe(false);
        expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('hello\nexisting work\n');
        expect(git(['diff', '--cached'], root)).toBe('');
        cleanup(hook);
        expect((await apply('commit', [edit])).ok).toBe(true);
      });
    }
  });
}
