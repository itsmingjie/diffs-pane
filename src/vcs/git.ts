import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import type { DiffFilter } from '../shared/protocol.js';
import { gitObjectsPath } from '../store/paths.js';
import { ExecError, execFile } from './exec.js';
import { VcsError, type ComputeOptions, type TurnBaseline, type VcsBackend } from './types.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master', 'trunk'];

export class GitBackend implements VcsBackend {
  readonly kind = 'git' as const;
  private snapshotEnvironment: Record<string, string> | undefined;
  private readonly workTreeSnapshots = new WeakMap<object, Promise<string>>();

  constructor(
    readonly root: string,
    private readonly stateDirOverride?: string,
  ) {}

  metadataDirs(): string[] {
    return ['.git'];
  }

  private git(
    args: string[],
    options: { signal?: AbortSignal; env?: Record<string, string>; okCodes?: number[] } = {},
  ) {
    return execFile('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: this.root,
      signal: options.signal,
      env: options.env,
      okCodes: options.okCodes,
    });
  }

  private async revParse(ref: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      signal,
      okCodes: [1],
    });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /**
   * Git needs an object database for temporary snapshot trees. Keep it in the
   * private diffs-pane state directory and read repository objects as alternates.
   */
  private async snapshotEnv(signal?: AbortSignal): Promise<Record<string, string>> {
    if (this.snapshotEnvironment) return this.snapshotEnvironment;

    const commonDirResult = await this.git(['rev-parse', '--git-common-dir'], { signal });
    const commonDir = commonDirResult.stdout.trim();
    const repositoryObjects = join(
      isAbsolute(commonDir) ? commonDir : resolve(this.root, commonDir),
      'objects',
    );
    const snapshotObjects = gitObjectsPath(this.root, this.stateDirOverride);
    mkdirSync(snapshotObjects, { recursive: true, mode: 0o700 });
    this.snapshotEnvironment = {
      GIT_OBJECT_DIRECTORY: snapshotObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [
        repositoryObjects,
        process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'],
      ]
        .filter((path): path is string => path !== undefined && path !== '')
        .join(delimiter),
    };
    return this.snapshotEnvironment;
  }

  /** Snapshot tracked and untracked-but-unignored files through a temporary index. */
  private async snapshotWorkTree(
    signal: AbortSignal | undefined,
    objectEnv: Record<string, string>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'diffs-pane-git-'));
    const indexFile = join(dir, `index-${randomBytes(4).toString('hex')}`);
    const env = { ...objectEnv, GIT_INDEX_FILE: indexFile };
    try {
      const head = await this.revParse('HEAD', signal);
      if (head !== null) {
        // Seed from HEAD so tracked-but-ignored files are not misread as deleted.
        await this.git(['read-tree', 'HEAD'], { signal, env });
      } else {
        await this.git(['read-tree', '--empty'], { signal, env });
      }
      await this.git(['add', '-A', '.'], { signal, env });
      const tree = await this.git(['write-tree'], { signal, env });
      return tree.stdout.trim();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Reuse one immutable current tree when multiple filters refresh together. */
  private snapshotWorkTreeForCompute(
    options: ComputeOptions,
    objectEnv: Record<string, string>,
  ): Promise<string> {
    const token = options.snapshotKey;
    if (!token) return this.snapshotWorkTree(options.signal, objectEnv);

    let snapshot = this.workTreeSnapshots.get(token);
    if (!snapshot) {
      snapshot = this.snapshotWorkTree(options.signal, objectEnv);
      this.workTreeSnapshots.set(token, snapshot);
    }
    return snapshot;
  }

  /** Tree of the current index, computed from a copy so nothing is mutated. */
  private async indexTree(
    signal: AbortSignal | undefined,
    objectEnv: Record<string, string>,
  ): Promise<string> {
    const gitDirResult = await this.git(['rev-parse', '--absolute-git-dir'], { signal });
    const indexPath = join(gitDirResult.stdout.trim(), 'index');
    const dir = await mkdtemp(join(tmpdir(), 'diffs-pane-git-'));
    const indexCopy = join(dir, 'index');
    const env = { ...objectEnv, GIT_INDEX_FILE: indexCopy };
    try {
      try {
        await copyFile(indexPath, indexCopy);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        await this.git(['read-tree', '--empty'], { signal, env });
      }
      const tree = await this.git(['write-tree'], { signal, env });
      return tree.stdout.trim();
    } catch (error) {
      if (error instanceof ExecError && /unmerged/i.test(error.message)) {
        throw new VcsError('Cannot diff against the index while merge conflicts are unresolved.');
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async resolveBaseTree(base: string | undefined, signal?: AbortSignal): Promise<string> {
    const head = await this.revParse('HEAD', signal);
    if (head === null) return EMPTY_TREE;

    let baseCommit: string | null = null;
    if (base !== undefined) {
      baseCommit = await this.revParse(base, signal);
      if (baseCommit === null) throw new VcsError(`Base revision not found: ${base}`);
    } else {
      const originHead = await this.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
        signal,
        okCodes: [1],
      });
      if (originHead.code === 0) {
        baseCommit = await this.revParse(originHead.stdout.trim(), signal);
      }
      if (baseCommit === null) {
        for (const candidate of BASE_CANDIDATES) {
          baseCommit = await this.revParse(candidate, signal);
          if (baseCommit !== null) break;
        }
      }
      if (baseCommit === null) baseCommit = head;
    }

    const mergeBase = await this.git(['merge-base', head, baseCommit], { signal, okCodes: [1] });
    if (mergeBase.code !== 0) return EMPTY_TREE; // Unrelated histories.
    return `${mergeBase.stdout.trim()}^{tree}`;
  }

  async captureTurnBaseline(signal?: AbortSignal): Promise<TurnBaseline> {
    const objectEnv = await this.snapshotEnv(signal);
    return {
      ref: await this.snapshotWorkTree(signal, objectEnv),
      capturedAt: new Date().toISOString(),
    };
  }

  async computePatch(filter: DiffFilter, options: ComputeOptions): Promise<string> {
    const { signal } = options;
    let baseTree: string;
    let objectEnv: Record<string, string> | undefined;
    switch (filter) {
      case 'unstaged':
        objectEnv = await this.snapshotEnv(signal);
        baseTree = await this.indexTree(signal, objectEnv);
        break;
      case 'branch':
        baseTree = await this.resolveBaseTree(options.base, signal);
        break;
      case 'turn': {
        if (!options.turnBaseline) return '';
        baseTree = options.turnBaseline.ref;
        break;
      }
    }
    objectEnv ??= await this.snapshotEnv(signal);
    const currentTree = await this.snapshotWorkTreeForCompute(options, objectEnv);
    const diff = await this.git(
      ['diff-tree', '-r', '-p', '--find-renames', '--no-color', baseTree, currentTree],
      { signal, env: objectEnv },
    );
    return diff.stdout;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
