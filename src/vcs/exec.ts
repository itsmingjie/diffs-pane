import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Exit codes that are treated as success in addition to 0. */
  okCodes?: number[];
  maxOutputBytes?: number;
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult | null,
    readonly aborted = false,
  ) {
    super(message);
    this.name = 'ExecError';
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

/** Run a subprocess with timeout, abort, and output-size protection. */
export function execFile(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const {
    cwd,
    env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    okCodes = [],
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
  } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExecError(`${command} aborted`, null, true));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const timeoutCheckMs = Math.max(1, Math.min(1_000, Math.floor(timeoutMs / 4)));
    let activeElapsedMs = 0;
    let lastTimeoutCheck = Date.now();
    const timeoutTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = now - lastTimeoutCheck;
      lastTimeoutCheck = now;
      if (elapsed < 0 || elapsed > timeoutCheckMs * 2) {
        // The event loop was suspended. Give the child a new active-time window.
        activeElapsedMs = 0;
        return;
      }
      activeElapsedMs += elapsed;
      if (activeElapsedMs < timeoutMs) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutCheckMs);

    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (error: Error | null, result?: ExecResult) => {
      if (settled) return;
      settled = true;
      clearInterval(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new ExecError(`${command} output exceeded ${maxOutputBytes} bytes`, null));
      } else {
        chunks.push(chunk);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));

    child.on('error', (err) =>
      finish(new ExecError(`failed to run ${command}: ${err.message}`, null)),
    );
    child.on('close', (code) => {
      const result: ExecResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? -1,
      };
      if (aborted) finish(new ExecError(`${command} aborted`, result, true));
      else if (timedOut) finish(new ExecError(`${command} timed out after ${timeoutMs}ms`, result));
      else if (result.code !== 0 && !okCodes.includes(result.code)) {
        finish(
          new ExecError(
            `${command} ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`,
            result,
          ),
        );
      } else finish(null, result);
    });
  });
}
