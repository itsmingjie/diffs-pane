import { realpath } from 'node:fs/promises';

import { execFile } from './exec.js';
import { GitBackend } from './git.js';
import { JjBackend } from './jj.js';
import { VcsError, type VcsBackend } from './types.js';

/**
 * Detect the VCS for a path and return a backend rooted at the canonical
 * working-tree root. jj takes precedence in colocated (jj + git) repos.
 */
export async function detectBackend(path: string, stateDirOverride?: string): Promise<VcsBackend> {
  const jjRoot = await tryRoot('jj', ['workspace', 'root'], path);
  if (jjRoot !== null) return new JjBackend(await canonicalize(jjRoot));

  const gitRoot = await tryRoot('git', ['rev-parse', '--show-toplevel'], path);
  if (gitRoot !== null) return new GitBackend(await canonicalize(gitRoot), stateDirOverride);

  throw new VcsError(`No Git or jj working tree found at ${path}`);
}

async function tryRoot(command: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await execFile(command, args, { cwd, timeoutMs: 10_000 });
    const root = result.stdout.trim();
    return root === '' ? null : root;
  } catch {
    return null;
  }
}

async function canonicalize(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}
