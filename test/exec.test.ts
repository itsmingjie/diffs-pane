import { describe, expect, it } from 'vitest';

import { ExecError, execFile } from '../src/vcs/exec.js';

describe('execFile', () => {
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
