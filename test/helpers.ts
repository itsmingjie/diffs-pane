import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function run(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function git(args: string[], cwd: string): string {
  return run('git', args, cwd, GIT_ENV);
}

/** Initialize a git repo with an initial commit on `main`. */
export function makeGitRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': 'hello\n' },
): void {
  git(['init', '--initial-branch', 'main'], dir);
  for (const [path, contents] of Object.entries(files)) {
    writeFileSyncDeep(join(dir, path), contents);
  }
  git(['add', '-A'], dir);
  git(['commit', '-m', 'initial'], dir);
}

export function writeFileSyncDeep(path: string, contents: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function hasJj(): boolean {
  return spawnSync('jj', ['--version'], { encoding: 'utf8' }).status === 0;
}

export function jj(args: string[], cwd: string): string {
  return run('jj', args, cwd, {
    JJ_USER: 'Test',
    JJ_EMAIL: 'test@example.com',
  });
}

/** Initialize a jj repo (git-backed) with one committed file on trunk. */
export function makeJjRepo(dir: string): void {
  jj(['git', 'init'], dir);
  writeFileSyncDeep(join(dir, 'README.md'), 'hello\n');
  jj(['commit', '-m', 'initial'], dir);
  jj(['bookmark', 'create', 'main', '-r', '@-'], dir);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error('waitFor timed out');
}
