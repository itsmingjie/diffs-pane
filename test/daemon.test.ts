import { readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { request, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer, type DaemonServer } from '../src/daemon/server.js';
import { SessionManager } from '../src/daemon/sessions.js';
import type {
  FileContentsPayload,
  PatchPayload,
  ReviewComment,
  SessionInfo,
} from '../src/shared/protocol.js';
import { cleanup, makeGitRepo, makeTempDir, waitFor, writeFileSyncDeep } from './helpers.js';

const CONTROL_TOKEN = 'test-control-token';

interface HttpResult {
  status: number;
  body: string;
}

function closeServer(server: DaemonServer['server']): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function rawRequest(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

class SseCollector {
  events: Array<{ event: string; data: unknown }> = [];
  private res: IncomingMessage | null = null;

  async connect(port: number, path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
        this.res = res;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (eventLine && dataLine) {
              this.events.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) });
            }
          }
        });
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  close(): void {
    this.res?.destroy();
  }
}

describe('daemon server', () => {
  let stateDir: string;
  let repo: string;
  let manager: SessionManager;
  let daemon: DaemonServer;
  let emptied = false;

  const control = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    rawRequest(daemon.port, method, path, {
      headers: {
        'x-dp-control-token': CONTROL_TOKEN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  beforeAll(async () => {
    stateDir = makeTempDir('dp-daemon-state-');
    repo = makeTempDir('dp-daemon-repo-');
    makeGitRepo(repo, { 'README.md': 'hello\n', 'src/app.ts': 'const a = 1;\n' });
    manager = new SessionManager(stateDir, () => {
      emptied = true;
    });
    daemon = await startServer({ controlToken: CONTROL_TOKEN, manager });
  });

  afterAll(async () => {
    await manager.stopAll();
    daemon.server.close();
    cleanup(stateDir);
    cleanup(repo);
  });

  let sessionUrl: string;
  let token: string;

  it('ensures a session and returns only a live URL', async () => {
    const res = await control('POST', '/control/sessions/ensure', {
      root: repo,
      owner: 'm',
      filter: 'unstaged',
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { url: string; created: boolean };
    expect(body.created).toBe(true);
    expect(body.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]+\/$/);
    sessionUrl = body.url;
    token = /\/s\/([^/]+)\//.exec(sessionUrl)![1]!;

    // Repeated calls reuse the session (and its URL).
    const again = await control('POST', '/control/sessions/ensure', { root: repo, owner: 'other' });
    const againBody = JSON.parse(again.body) as { url: string; created: boolean };
    expect(againBody.created).toBe(false);
    expect(againBody.url).toBe(sessionUrl);
  });

  it('uses the preferred port when available and another port when occupied', async () => {
    const first = await startServer({
      controlToken: CONTROL_TOKEN,
      manager: new SessionManager(stateDir, () => {}),
    });
    const preferredPort = first.port;
    await closeServer(first.server);

    const reused = await startServer({
      controlToken: CONTROL_TOKEN,
      manager: new SessionManager(stateDir, () => {}),
      preferredPort,
    });
    try {
      expect(reused.port).toBe(preferredPort);

      const fallback = await startServer({
        controlToken: CONTROL_TOKEN,
        manager: new SessionManager(stateDir, () => {}),
        preferredPort,
      });
      try {
        expect(fallback.port).not.toBe(preferredPort);
      } finally {
        await closeServer(fallback.server);
      }
    } finally {
      await closeServer(reused.server);
    }
  });

  it('can disable and re-enable filesystem watching', async () => {
    const disabled = await control('POST', '/control/sessions/ensure', {
      root: repo,
      owner: 'm',
      watch: false,
    });
    expect(disabled.status).toBe(200);
    expect((await manager.findByRoot(repo))?.isWatching()).toBe(false);

    const enabled = await control('POST', '/control/sessions/ensure', {
      root: repo,
      owner: 'm',
      watch: true,
    });
    expect(enabled.status).toBe(200);
    expect((await manager.findByRoot(repo))?.isWatching()).toBe(true);
  });

  it('rejects requests without a valid control token', async () => {
    const res = await rawRequest(daemon.port, 'GET', '/control/status', {
      headers: { 'x-dp-control-token': 'wrong' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects unknown capability tokens and unexpected hosts', async () => {
    const bad = await rawRequest(daemon.port, 'GET', '/s/not-a-real-token/api/session');
    expect(bad.status).toBe(404);

    const forgedHost = await rawRequest(daemon.port, 'GET', `/s/${token}/api/session`, {
      headers: { host: 'evil.example.com' },
    });
    expect(forgedHost.status).toBe(403);
  });

  it('rejects cross-origin mutations and oversized bodies', async () => {
    const crossOrigin = await rawRequest(daemon.port, 'POST', `/s/${token}/api/comments`, {
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: '{}',
    });
    expect(crossOrigin.status).toBe(403);

    const huge = await rawRequest(daemon.port, 'POST', `/s/${token}/api/comments`, {
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${daemon.port}` },
      body: JSON.stringify({ body: 'x'.repeat(2 * 1024 * 1024) }),
    }).catch(() => ({ status: 0, body: '' }));
    // Connection may be destroyed mid-request or answered with an error.
    expect(huge.status === 0 || huge.status >= 400).toBe(true);
  });

  it('serves session info and patches over the capability URL', async () => {
    const info = await rawRequest(daemon.port, 'GET', `/s/${token}/api/session`);
    expect(info.status).toBe(200);
    const session = JSON.parse(info.body) as SessionInfo;
    expect(session.vcs).toBe('git');
    expect(session.defaultFilter).toBe('unstaged');

    writeFileSyncDeep(join(repo, 'src/app.ts'), 'const a = 2;\n');
    const patchRes = await rawRequest(daemon.port, 'GET', `/s/${token}/api/patch?filter=unstaged`);
    const patch = JSON.parse(patchRes.body) as PatchPayload;
    expect(patch.error).toBeNull();
    expect(patch.files.map((f) => f.path)).toContain('src/app.ts');
    // Section hashes let the UI reuse parsed state for unchanged files.
    expect(patch.files.every((f) => /^[0-9a-f]{32}$/.test(f.sectionHash))).toBe(true);
  });

  it('hydrates regular files for editing', async () => {
    const filePath = join(repo, 'edit.txt');
    writeFileSyncDeep(filePath, 'one\n');
    await waitFor(async () => {
      const result = await rawRequest(daemon.port, 'GET', `/s/${token}/api/patch?filter=unstaged`);
      return (JSON.parse(result.body) as PatchPayload).files.some(
        (file) => file.path === 'edit.txt',
      );
    });

    const hydrated = await rawRequest(
      daemon.port,
      'GET',
      `/s/${token}/api/file?filter=unstaged&path=edit.txt`,
    );
    expect(hydrated.status).toBe(200);
    const contents = JSON.parse(hydrated.body) as FileContentsPayload;
    expect(contents.oldContents).toBeNull();
    expect(contents.newContents).toBe('one\n');
    expect(contents.newContentsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects symlinked files in edit endpoints', async () => {
    const outside = join(stateDir, 'outside.txt');
    const link = join(repo, 'outside-link.txt');
    writeFileSyncDeep(outside, 'private\n');
    symlinkSync(outside, link);
    try {
      await waitFor(async () => {
        const result = await rawRequest(
          daemon.port,
          'GET',
          `/s/${token}/api/patch?filter=unstaged`,
        );
        return (JSON.parse(result.body) as PatchPayload).files.some(
          (file) => file.path === 'outside-link.txt',
        );
      });
      const result = await rawRequest(
        daemon.port,
        'GET',
        `/s/${token}/api/file?filter=unstaged&path=outside-link.txt`,
      );
      expect(result.status).toBe(422);
      expect(readFileSync(outside, 'utf8')).toBe('private\n');
    } finally {
      unlinkSync(link);
    }
  });

  it('supports the full comment lifecycle with saved hunk excerpts', async () => {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const create = await rawRequest(daemon.port, 'POST', `/s/${token}/api/comments`, {
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        filter: 'unstaged',
        path: 'src/app.ts',
        side: 'additions',
        startLine: 1,
        endLine: 1,
        body: 'why 2?',
      }),
    });
    expect(create.status).toBe(201);
    const comment = JSON.parse(create.body) as ReviewComment;
    expect(comment.anchorText).toBe('const a = 2;');
    expect(comment.hunkExcerpt).toContain('@@');
    expect(comment.hunkExcerpt).toContain('+const a = 2;');

    const update = await rawRequest(
      daemon.port,
      'PATCH',
      `/s/${token}/api/comments/${comment.id}`,
      {
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ body: 'edited' }),
      },
    );
    expect(update.status).toBe(200);

    const reviews = await control('GET', `/control/reviews?root=${encodeURIComponent(repo)}`);
    const exported = JSON.parse(reviews.body) as { version: number; comments: ReviewComment[] };
    expect(exported.version).toBe(1);
    expect(exported.comments[0]?.body).toBe('edited');

    const del = await rawRequest(daemon.port, 'DELETE', `/s/${token}/api/comments/${comment.id}`, {
      headers: { origin },
    });
    expect(del.status).toBe(200);
  });

  it('resolves comments through the control API (dp resolve)', async () => {
    const origin = `http://127.0.0.1:${daemon.port}`;
    const create = await rawRequest(daemon.port, 'POST', `/s/${token}/api/comments`, {
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        filter: 'unstaged',
        path: 'src/app.ts',
        side: 'additions',
        startLine: 1,
        endLine: 1,
        body: 'to be resolved',
      }),
    });
    expect(create.status).toBe(201);
    const comment = JSON.parse(create.body) as ReviewComment;

    const resolve = await control('POST', '/control/comments/resolve', {
      root: repo,
      ids: [comment.id],
    });
    expect(resolve.status).toBe(200);
    expect((JSON.parse(resolve.body) as { removed: number }).removed).toBe(1);

    const reviews = await control('GET', `/control/reviews?root=${encodeURIComponent(repo)}`);
    expect((JSON.parse(reviews.body) as { comments: ReviewComment[] }).comments).toHaveLength(0);
  });

  it('streams patch updates over SSE, without broadcasts for unchanged hashes', async () => {
    const sse = new SseCollector();
    await sse.connect(daemon.port, `/s/${token}/api/events?filter=unstaged`);
    await waitFor(() => sse.events.some((e) => e.event === 'comments'));

    // A burst of writes coalesces into (at least) one patch broadcast.
    const countBefore = sse.events.filter((e) => e.event === 'patch').length;
    for (let i = 0; i < 5; i++) {
      writeFileSyncDeep(join(repo, 'src/app.ts'), `const a = ${i + 10};\n`);
    }
    await waitFor(() => sse.events.filter((e) => e.event === 'patch').length > countBefore);
    await new Promise((r) => setTimeout(r, 600));

    // Rewriting identical content changes mtime but not the patch hash:
    // no new broadcast may be emitted.
    const countAfterBurst = sse.events.filter((e) => e.event === 'patch').length;
    writeFileSyncDeep(join(repo, 'src/app.ts'), 'const a = 14;\n');
    await new Promise((r) => setTimeout(r, 800));
    expect(sse.events.filter((e) => e.event === 'patch').length).toBe(countAfterBurst);
    sse.close();
  });

  it('records turn lifecycle through the control API idempotently', async () => {
    const start = await control('POST', '/control/turn', {
      root: repo,
      action: 'start',
      session: 'sess-1',
      turn: 'turn-1',
      agent: 'pi',
    });
    expect(start.status).toBe(200);
    // Duplicate start for the same turn is idempotent.
    await control('POST', '/control/turn', {
      root: repo,
      action: 'start',
      session: 'sess-1',
      turn: 'turn-1',
    });

    writeFileSyncDeep(join(repo, 'turn-file.txt'), 'made during turn\n');
    const patchRes = await rawRequest(daemon.port, 'GET', `/s/${token}/api/patch?filter=turn`);
    const patch = JSON.parse(patchRes.body) as PatchPayload;
    expect(patch.files.map((f) => f.path)).toEqual(['turn-file.txt']);

    const end = await control('POST', '/control/turn', {
      root: repo,
      action: 'end',
      session: 'sess-1',
      turn: 'turn-1',
    });
    expect(end.status).toBe(200);
    const info = JSON.parse(
      (await rawRequest(daemon.port, 'GET', `/s/${token}/api/session`)).body,
    ) as SessionInfo;
    expect(info.turn).toEqual({ turnId: 'sess-1:turn-1', agent: 'pi', active: false });
  });

  it('keeps sessions alive while any owner lease remains', async () => {
    // Owners so far: m, other, plus turn handling never removed any.
    const stop1 = await control('POST', '/control/stop', { root: repo, owner: 'm' });
    expect((JSON.parse(stop1.body) as { sessionStopped: boolean }).sessionStopped).toBe(false);
    expect(manager.list()).toHaveLength(1);

    const stop2 = await control('POST', '/control/stop', { root: repo, owner: 'other' });
    expect((JSON.parse(stop2.body) as { sessionStopped: boolean }).sessionStopped).toBe(true);
    expect(manager.list()).toHaveLength(0);
    expect(emptied).toBe(true);

    // The capability URL is gone once the session stops.
    const after = await rawRequest(daemon.port, 'GET', `/s/${token}/api/session`);
    expect(after.status).toBe(404);
  });
});
