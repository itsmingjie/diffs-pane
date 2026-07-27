import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Session, type SessionRecord } from '../src/daemon/session.js';
import { parsePatch } from '../src/shared/patch.js';
import type { DiffFilter } from '../src/shared/protocol.js';
import type { ComputeOptions, TurnBaseline, VcsBackend } from '../src/vcs/types.js';
import { cleanup, makeTempDir, sleep, waitFor, writeFileSyncDeep } from './helpers.js';

function makeLargePatch(files: number, hunksPerFile: number): string {
  const parts: string[] = [];
  for (let f = 0; f < files; f++) {
    parts.push(
      `diff --git a/src/file-${f}.ts b/src/file-${f}.ts`,
      `--- a/src/file-${f}.ts`,
      `+++ b/src/file-${f}.ts`,
    );
    for (let h = 0; h < hunksPerFile; h++) {
      const start = h * 20 + 1;
      parts.push(
        `@@ -${start},4 +${start},5 @@`,
        ' context a',
        `-old line ${h}`,
        `+new line ${h}`,
        '+extra line',
        ' context b',
        ' context c',
      );
    }
  }
  return `${parts.join('\n')}\n`;
}

describe('performance', () => {
  it('parses large patches quickly', () => {
    const patch = makeLargePatch(500, 40); // 500 files × 40 hunks ≈ 120k lines
    const started = performance.now();
    const files = parsePatch(patch);
    const elapsed = performance.now() - started;
    expect(files).toHaveLength(500);
    expect(files[0]!.additions).toBe(80);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('refresh coalescing', () => {
  let dir: string;
  let session: Session;
  let concurrent = 0;
  let maxConcurrent = 0;
  let computeCalls = 0;

  class FakeBackend implements VcsBackend {
    readonly kind = 'git' as const;
    constructor(readonly root: string) {}
    metadataDirs(): string[] {
      return [];
    }
    async captureTurnBaseline(): Promise<TurnBaseline> {
      return { ref: 'fake', capturedAt: new Date().toISOString() };
    }
    async computePatch(_filter: DiffFilter, options: ComputeOptions): Promise<string> {
      computeCalls++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        for (let i = 0; i < 10; i++) {
          if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
          await sleep(10);
        }
        return `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b${computeCalls}\n`;
      } finally {
        concurrent--;
      }
    }
  }

  beforeEach(async () => {
    dir = makeTempDir('dp-coalesce-');
    concurrent = 0;
    maxConcurrent = 0;
    computeCalls = 0;
    const record: SessionRecord = {
      sessionId: 's',
      token: 't',
      root: dir,
      vcs: 'git',
      owners: ['test'],
      defaultFilter: 'branch',
    };
    session = await Session.start(record, new FakeBackend(dir), {
      stateDir: dir,
      onDirty: () => {},
    });
  });

  afterEach(async () => {
    await session.close();
    cleanup(dir);
  });

  it('coalesces concurrent patch requests into one compute', async () => {
    const [a, b] = await Promise.all([session.getPatch('branch'), session.getPatch('branch')]);
    expect(a).toBe(b);
    expect(computeCalls).toBe(1);
    // A later request is served from cache without recomputing.
    expect(await session.getPatch('branch')).toBe(a);
    expect(computeCalls).toBe(1);
  });

  it('shares an in-flight patch request with the SSE catch-up refresh', async () => {
    const writes: string[] = [];
    const fakeRes = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      on: () => fakeRes,
      end: () => {},
    };

    // Page load: the patch fetch and the SSE catch-up race for the same filter.
    const fetched = session.getPatch('branch');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.addClient(fakeRes as any, 'branch');

    const payload = await fetched;
    await waitFor(() => writes.some((w) => w.includes('event: patch')));
    expect(computeCalls).toBe(1);
    expect(writes.join('')).toContain(payload.patchHash);
  });

  it('bounds refresh concurrency to one under rapid edit bursts', async () => {
    const writes: string[] = [];
    const fakeRes = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      on: () => fakeRes,
      end: () => {},
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.addClient(fakeRes as any, 'branch');

    for (let burst = 0; burst < 4; burst++) {
      for (let i = 0; i < 5; i++) {
        writeFileSyncDeep(join(dir, `f-${i}.txt`), `${burst}-${i}\n`);
      }
      await sleep(60);
    }
    await waitFor(() => concurrent === 0 && writes.some((w) => w.includes('event: patch')));
    await sleep(400);

    expect(maxConcurrent).toBe(1);
    // 20 writes coalesced into far fewer compute passes.
    expect(computeCalls).toBeLessThan(10);
  });
});
