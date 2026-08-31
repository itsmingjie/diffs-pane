import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { anchorTextForRange, hunkExcerptForRange, parsePatch } from '../shared/patch.js';
import {
  isDiffFilter,
  type ApplyEditsRequest,
  type NewCommentRequest,
  type StatusExport,
  type UpdateCommentRequest,
} from '../shared/protocol.js';
import { checkMutationOrigin, checkTransport, readBody } from './security.js';
import { applyEdits, editErrorStatus, readEditableFile } from './edits.js';
import { type SessionManager, timingSafeEqualString, DEFAULT_OWNER } from './sessions.js';

const UI_DIR = fileURLToPath(new URL('../ui', import.meta.url));

const MAX_EDIT_BODY_BYTES = 24 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

export interface DaemonServer {
  server: Server;
  port: number;
  sessionUrl(token: string): string;
}

export interface ServerOptions {
  controlToken: string;
  manager: SessionManager;
  preferredPort?: number;
}

export async function startServer(options: ServerOptions): Promise<DaemonServer> {
  const { controlToken, manager } = options;
  let port = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : 'internal error' });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transportError = checkTransport(req, port);
    if (transportError) return sendJson(res, 403, { error: transportError });

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = req.method ?? 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      const originError = checkMutationOrigin(req, port);
      if (originError) return sendJson(res, 403, { error: originError });
    }

    if (url.pathname.startsWith('/control/')) return handleControl(req, res, url, method);

    const match = /^\/s\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
      const session = manager.byToken(match[1]!);
      if (!session) return sendJson(res, 404, { error: 'unknown session' });
      const subPath = match[2] ?? '';
      if (subPath === '') {
        res.writeHead(302, { location: `/s/${match[1]!}/` });
        res.end();
        return;
      }
      return handleSession(req, res, url, method, session, subPath);
    }

    sendJson(res, 404, { error: 'not found' });
  }

  type SessionType = ReturnType<SessionManager['list']>[number];

  async function handleSession(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    session: SessionType,
    subPath: string,
  ): Promise<void> {
    if (subPath === '/api/session' && method === 'GET') {
      return sendJson(res, 200, session.info());
    }

    if (subPath === '/api/patch' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      return sendJson(res, 200, await session.getPatch(filter));
    }

    if (subPath === '/api/events' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: session\ndata: ${JSON.stringify(session.info())}\n\n`);
      res.write(
        `event: comments\ndata: ${JSON.stringify({ comments: session.listComments() })}\n\n`,
      );
      session.addClient(res, filter);
      return;
    }

    if (subPath === '/api/comments' && method === 'GET') {
      return sendJson(res, 200, { comments: session.listComments() });
    }

    if (subPath === '/api/comments' && method === 'POST') {
      const body = await parseJsonBody<NewCommentRequest>(req);
      if (!body) return sendJson(res, 400, { error: 'invalid JSON body' });
      const error = validateNewComment(body);
      if (error) return sendJson(res, 422, { error });

      const patch = await session.getPatch(body.filter);
      const file = parsePatch(patch.patch).find((f) => f.path === body.path);
      if (!file)
        return sendJson(res, 422, { error: `file not in ${body.filter} diff: ${body.path}` });
      const anchorText = anchorTextForRange(file, body.side, body.startLine, body.endLine);
      const hunkExcerpt = hunkExcerptForRange(file, body.side, body.startLine);
      if (anchorText === null || hunkExcerpt === null) {
        return sendJson(res, 422, { error: 'selected lines are not part of the current diff' });
      }
      const comment = session.reviewStore.create({
        ...body,
        anchorText,
        hunkExcerpt,
        patchHash: patch.patchHash,
      });
      session.broadcastComments();
      return sendJson(res, 201, comment);
    }

    if (subPath === '/api/file' && method === 'GET') {
      const filter = url.searchParams.get('filter') ?? session.defaultFilter;
      if (!isDiffFilter(filter)) return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      const path = url.searchParams.get('path');
      if (!path) return sendJson(res, 400, { error: 'path is required' });
      try {
        return sendJson(res, 200, await readEditableFile(session, filter, path));
      } catch (error) {
        return sendJson(res, editErrorStatus(error), {
          error: error instanceof Error ? error.message : 'Unable to read file',
        });
      }
    }

    if (
      method === 'POST' &&
      (subPath === '/api/edits/commit' || subPath === '/api/edits/discard')
    ) {
      return handleEdits(req, res, session, subPath.endsWith('/commit') ? 'commit' : 'discard');
    }

    const commentMatch = /^\/api\/comments\/([A-Za-z0-9-]+)$/.exec(subPath);
    if (commentMatch) {
      const id = commentMatch[1]!;
      if (method === 'PATCH') {
        const body = await parseJsonBody<UpdateCommentRequest>(req);
        if (!body || typeof body.body !== 'string' || body.body.trim() === '') {
          return sendJson(res, 400, { error: 'body must be a non-empty string' });
        }
        const updated = session.reviewStore.update(id, body.body);
        if (!updated) return sendJson(res, 404, { error: 'unknown comment' });
        session.broadcastComments();
        return sendJson(res, 200, updated);
      }
      if (method === 'DELETE') {
        if (!session.reviewStore.delete(id))
          return sendJson(res, 404, { error: 'unknown comment' });
        session.broadcastComments();
        return sendJson(res, 200, { ok: true });
      }
    }

    if (method === 'GET' || method === 'HEAD') return serveStatic(res, subPath);
    sendJson(res, 405, { error: 'method not allowed' });
  }

  async function handleEdits(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionType,
    action: 'commit' | 'discard',
  ): Promise<void> {
    const body = await parseJsonBody<ApplyEditsRequest>(req, MAX_EDIT_BODY_BYTES);
    if (
      !body ||
      !isDiffFilter(body.filter) ||
      !Array.isArray(body.files) ||
      body.files.length === 0 ||
      body.files.some(
        (file) =>
          !file ||
          typeof file.path !== 'string' ||
          typeof file.contents !== 'string' ||
          typeof file.expectedContentsHash !== 'string' ||
          !/^[0-9a-f]{64}$/.test(file.expectedContentsHash),
      ) ||
      new Set(body.files.map((file) => file.path)).size !== body.files.length
    ) {
      return sendJson(res, 400, {
        error: 'filter and unique files with contents and expectedContentsHash are required',
      });
    }
    try {
      const result = await session.runEdit(() => applyEdits(session, body, action));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, editErrorStatus(error), {
        error: error instanceof Error ? error.message : 'Unable to apply local edits',
      });
    }
  }

  async function handleControl(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
  ): Promise<void> {
    const token = req.headers['x-dp-control-token'];
    if (typeof token !== 'string' || !timingSafeEqualString(token, controlToken)) {
      return sendJson(res, 403, { error: 'invalid control token' });
    }

    if (url.pathname === '/control/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, pid: process.pid });
    }

    if (url.pathname === '/control/status' && method === 'GET') {
      const status: StatusExport = {
        version: 1,
        running: true,
        pid: process.pid,
        port,
        sessions: manager.list().map((s) => ({
          sessionId: s.sessionId,
          root: s.root,
          vcs: s.info().vcs,
          url: sessionUrl(s.token),
          owners: [...s.owners],
          clients: s.clientCount(),
          turn: s.info().turn,
        })),
      };
      return sendJson(res, 200, status);
    }

    if (url.pathname === '/control/sessions/ensure' && method === 'POST') {
      const body = await parseJsonBody<{
        root?: string;
        owner?: string;
        filter?: string;
        base?: string;
        watch?: boolean;
      }>(req);
      if (!body?.root) return sendJson(res, 400, { error: 'root is required' });
      const filter = body.filter;
      if (filter !== undefined && !isDiffFilter(filter)) {
        return sendJson(res, 400, { error: `invalid filter: ${filter}` });
      }
      if (body.watch !== undefined && typeof body.watch !== 'boolean') {
        return sendJson(res, 400, { error: 'watch must be a boolean' });
      }
      try {
        const { session, created } = await manager.ensure(body.root, {
          owner: body.owner ?? DEFAULT_OWNER,
          filter,
          base: body.base,
          watch: body.watch,
        });
        return sendJson(res, 200, {
          url: sessionUrl(session.token),
          sessionId: session.sessionId,
          created,
        });
      } catch (error) {
        return sendJson(res, 422, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (url.pathname === '/control/turn' && method === 'POST') {
      const body = await parseJsonBody<{
        root?: string;
        action?: string;
        session?: string;
        turn?: string;
        agent?: string;
        owner?: string;
      }>(req);
      if (!body?.root || !body.turn || (body.action !== 'start' && body.action !== 'end')) {
        return sendJson(res, 400, { error: 'root, turn, and action=start|end are required' });
      }
      const turnKey = `${body.session ?? 'session'}:${body.turn}`;
      let session = await manager.findByRoot(body.root);
      if (!session && body.action === 'start') {
        session = (await manager.ensure(body.root, { owner: body.owner ?? body.agent ?? 'turn' }))
          .session;
      }
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      if (body.action === 'start') await session.startTurn(turnKey, body.agent);
      else session.endTurn(turnKey);
      return sendJson(res, 200, { ok: true, sessionId: session.sessionId });
    }

    if (url.pathname === '/control/reviews' && method === 'GET') {
      const root = url.searchParams.get('root');
      if (!root) return sendJson(res, 400, { error: 'root is required' });
      const session = await manager.findByRoot(root);
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      return sendJson(res, 200, {
        version: 1,
        root: session.root,
        comments: session.listComments(),
      });
    }

    if (url.pathname === '/control/comments/resolve' && method === 'POST') {
      const body = await parseJsonBody<{ root?: string; ids?: string[]; all?: boolean }>(req);
      if (!body?.root || (!Array.isArray(body.ids) && body.all !== true)) {
        return sendJson(res, 400, { error: 'root plus ids[] or all=true are required' });
      }
      const session = await manager.findByRoot(body.root);
      if (!session) return sendJson(res, 404, { error: 'no session for root' });
      const ids =
        body.all === true ? session.listComments().map((comment) => comment.id) : body.ids!;
      const removed = session.reviewStore.deleteMany(ids);
      if (removed > 0) session.broadcastComments();
      return sendJson(res, 200, { ok: true, removed });
    }

    if (url.pathname === '/control/stop' && method === 'POST') {
      const body = await parseJsonBody<{ root?: string; owner?: string; all?: boolean }>(req);
      const owner = body?.owner ?? DEFAULT_OWNER;
      if (body?.all && body.root === undefined) {
        if (body.owner !== undefined) {
          const stopped = await manager.removeOwnerEverywhere(owner);
          return sendJson(res, 200, { ok: true, stoppedSessions: stopped });
        }
        await manager.stopAll();
        return sendJson(res, 200, { ok: true, stoppedSessions: 'all' });
      }
      if (!body?.root) return sendJson(res, 400, { error: 'root is required unless --all' });
      const result = await manager.removeOwner(body.root, owner);
      return sendJson(res, 200, { ok: true, ...result });
    }

    sendJson(res, 404, { error: 'unknown control endpoint' });
  }

  function serveStatic(res: ServerResponse, subPath: string): void {
    const rel = subPath === '/' ? 'index.html' : subPath.replace(/^\//, '');
    const filePath = normalize(join(UI_DIR, rel));
    if (!filePath.startsWith(UI_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      // SPA fallback: unknown paths under the session serve the app shell.
      const index = join(UI_DIR, 'index.html');
      if (!existsSync(index)) {
        return sendJson(res, 404, { error: 'UI assets not built; run `pnpm run build:ui`' });
      }
      res.writeHead(200, { 'content-type': MIME['.html']! });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': rel.startsWith('assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-store',
    });
    createReadStream(filePath).pipe(res);
  }

  function sessionUrl(token: string): string {
    return `http://127.0.0.1:${port}/s/${token}/`;
  }

  try {
    await listen(server, options.preferredPort ?? 0);
  } catch (error) {
    if (options.preferredPort === undefined || !isAddressInUse(error)) throw error;
    await listen(server, 0);
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind');
  port = address.port;

  return { server, port, sessionUrl };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function parseJsonBody<T>(req: IncomingMessage, maxBytes?: number): Promise<T | null> {
  try {
    const raw = await readBody(req, maxBytes);
    if (raw.length === 0) return {} as T;
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    return null;
  }
}

function validateNewComment(body: NewCommentRequest): string | null {
  if (!isDiffFilter(body.filter)) return 'invalid filter';
  if (typeof body.path !== 'string' || body.path === '') return 'path is required';
  if (body.side !== 'additions' && body.side !== 'deletions')
    return 'side must be additions or deletions';
  if (
    !Number.isInteger(body.startLine) ||
    !Number.isInteger(body.endLine) ||
    body.startLine < 1 ||
    body.endLine < body.startLine
  ) {
    return 'invalid line range';
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') return 'comment body is required';
  return null;
}
