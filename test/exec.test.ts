import { describe, expect, it } from 'vitest';

import { ExecError, execFile } from '../src/vcs/exec.js';

describe('execFile', () => {
  it('does not count an event-loop suspension toward the timeout', async () => {
    const result = execFile(process.execPath, ['-e', 'setTimeout(() => {}, 120)'], {
      cwd: process.cwd(),
      timeoutMs: 60,
    });

    const resumeAt = Date.now() + 200;
    while (Date.now() < resumeAt) {
      // Simulate the daemon resuming after the timeout deadline.
    }

    await expect(result).resolves.toMatchObject({ code: 0 });
  });

  it('stops a subprocess after the active-time limit', async () => {
    const result = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      timeoutMs: 60,
    });

    await expect(result).rejects.toMatchObject({
      name: ExecError.name,
      message: expect.stringContaining('timed out after 60ms'),
    });
  });

  it('bounds stderr as part of subprocess output', async () => {
    const result = execFile(process.execPath, ['-e', `process.stderr.write('x'.repeat(1024))`], {
      cwd: process.cwd(),
      maxOutputBytes: 128,
    });

    await expect(result).rejects.toMatchObject({
      name: ExecError.name,
      message: expect.stringContaining('output exceeded 128 bytes'),
    });
  });
});
