import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Session, type SessionRecord } from '../src/daemon/session.js';
import { parsePatch } from '../src/shared/patch.js';
import type { DiffFilter } from '../src/shared/protocol.js';
import { ExecError } from '../src/vcs/exec.js';
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
  let computeDelays: number[] = [];

  class FakeBackend implements VcsBackend {
    readonly kind = 'git' as const;
    constructor(readonly root: string) {}
    metadataDirs(): string[] {
      return [];
    }
    async commitFiles(): Promise<void> {
      throw new Error('not used');
    }
    async discardFiles(): Promise<void> {
      throw new Error('not used');
    }
    async captureTurnBaseline(): Promise<TurnBaseline> {
      return { ref: 'fake', capturedAt: new Date().toISOString() };
    }
    async computePatch(_filter: DiffFilter, options: ComputeOptions): Promise<string> {
      const call = ++computeCalls;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        let remainingMs = computeDelays[call - 1] ?? 100;
        while (remainingMs > 0) {
          if (options.signal?.aborted) throw new ExecError('aborted', null, true);
          const waitMs = Math.min(remainingMs, 10);
          await sleep(waitMs);
          remainingMs -= waitMs;
        }
        return `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b${call}\n`;
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
    computeDelays = [];
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

  it('shares an SSE-started refresh with a concurrent patch request', async () => {
    const writes: string[] = [];
    const fakeRes = {
      write: (chunk: string) => {
        writes.push(chunk);
        return true;
      },
      on: () => fakeRes,
      end: () => {},
    };

    // The two HTTP connections may reach the daemon in either order.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.addClient(fakeRes as any, 'branch');
    const payload = await session.getPatch('branch');

    await waitFor(() => writes.some((w) => w.includes('event: patch')));
    expect(computeCalls).toBe(1);
    expect(writes.join('')).toContain(payload.patchHash);
  });

  it('does not apply review anchors from a superseded compute', async () => {
    computeDelays = [200, 20];
    const comment = session.reviewStore.create({
      filter: 'branch',
      path: 'x',
      side: 'additions',
      startLine: 1,
      endLine: 1,
      body: 'review',
      anchorText: 'b2',
      hunkExcerpt: '@@ -1 +1 @@\n-a\n+b2',
      patchHash: 'initial',
    });

    const superseded = session.getPatch('branch');
    (session as unknown as { handleFsChange(): void }).handleFsChange();
    const current = session.getPatch('branch');
    await current;
    await superseded;

    expect(session.reviewStore.get(comment.id)?.outdated).toBe(false);
    expect(session.reviewStore.get(comment.id)?.patchHash).not.toBe('initial');
  });

  it('retries a request that joined a superseded refresh', async () => {
    const fakeRes = {
      write: () => true,
      on: () => fakeRes,
      end: () => {},
    };

    // Start an abortable refresh, then join it from an on-demand request.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    session.addClient(fakeRes as any, 'branch');
    const requested = session.getPatch('branch');
    await sleep(20);
    await session.startTurn('turn-1', undefined);

    const payload = await requested;
    expect(payload.error).toBeNull();
    expect(computeCalls).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
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
