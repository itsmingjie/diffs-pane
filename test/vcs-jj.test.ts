import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePatch } from '../src/shared/patch.js';
import { detectBackend } from '../src/vcs/detect.js';
import type { ExecError } from '../src/vcs/exec.js';
import { type JjBackend } from '../src/vcs/jj.js';
import {
  cleanup,
  hasJj,
  jj,
  makeJjRepo,
  makeTempDir,
  sleep,
  writeFileSyncDeep,
} from './helpers.js';

describe.skipIf(!hasJj())('JjBackend', () => {
  let dir: string;
  let backend: JjBackend;

  beforeEach(async () => {
    dir = makeTempDir('dp-jj-');
    makeJjRepo(dir);
    backend = (await detectBackend(dir)) as JjBackend;
    expect(backend.kind).toBe('jj');
  });

  afterEach(() => cleanup(dir));

  it('unstaged: shows the current working-copy change (@)', async () => {
    writeFileSyncDeep(join(dir, 'README.md'), 'hello\nworld\n');
    writeFileSyncDeep(join(dir, 'new.txt'), 'fresh\n');

    const files = parsePatch(await backend.computePatch('unstaged', {}));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')?.additions).toBe(1);
    expect(byPath.get('new.txt')?.kind).toBe('added');
  });

  it('branch: diffs from the fork point of trunk() and @', async () => {
    writeFileSyncDeep(join(dir, 'feature.txt'), 'feature work\n');
    jj(['commit', '-m', 'feature commit'], dir);
    writeFileSyncDeep(join(dir, 'wip.txt'), 'in progress\n');

    const files = parsePatch(await backend.computePatch('branch', {}));
    const paths = files.map((f) => f.path);
    expect(paths).toContain('feature.txt');
    expect(paths).toContain('wip.txt');
  });

  it('turn: compares the snapshot commit with the current @', async () => {
    writeFileSyncDeep(join(dir, 'README.md'), 'hello\npre-dirty\n');
    const baseline = await backend.captureTurnBaseline();
    expect(baseline.ref).toMatch(/^[0-9a-f]+$/);

    writeFileSyncDeep(join(dir, 'README.md'), 'hello\npre-dirty\nturn-edit\n');
    writeFileSyncDeep(join(dir, 'turn.txt'), 'new in turn\n');

    const files = parsePatch(await backend.computePatch('turn', { turnBaseline: baseline }));
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')?.raw).toContain('+turn-edit');
    expect(byPath.get('README.md')?.raw).not.toContain('+pre-dirty');
    expect(byPath.get('turn.txt')?.kind).toBe('added');
  });

  it('reports empty diff for a clean working copy', async () => {
    const patch = await backend.computePatch('unstaged', {});
    expect(parsePatch(patch)).toEqual([]);
  });

  it('waits out a transient stale-working-copy state', async () => {
    const otherParent = makeTempDir('dp-jj-workspace-');
    const other = join(otherParent, 'other');
    try {
      writeFileSyncDeep(join(dir, 'transient.txt'), 'content\n');
      jj(['status'], dir); // Snapshot the file before another workspace rewrites @.
      jj(['workspace', 'add', other, '--name', 'other'], dir);
      jj(['restore', '--into', 'default@', '--from', 'root()'], other);

      const recovery = (async () => {
        await sleep(150);
        jj(['workspace', 'update-stale'], dir);
      })();
      const [patch] = await Promise.all([backend.computePatch('unstaged', {}), recovery]);
      expect(typeof patch).toBe('string');
    } finally {
      cleanup(otherParent);
    }
  });

  it('skips an obsolete queued command without poisoning the queue', async () => {
    writeFileSyncDeep(join(dir, 'queued.txt'), 'content\n');
    const running = backend.computePatch('unstaged', {});
    const controller = new AbortController();
    const obsolete = backend.computePatch('branch', { signal: controller.signal });
    controller.abort();

    await running;
    await expect(obsolete).rejects.toEqual(
      expect.objectContaining<Partial<ExecError>>({ aborted: true }),
    );
    await expect(backend.computePatch('unstaged', {})).resolves.toEqual(expect.any(String));
  });
});
