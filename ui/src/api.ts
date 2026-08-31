import type {
  ApplyEditsRequest,
  DiffFilter,
  FileContentsPayload,
  NewCommentRequest,
  PatchChangedEvent,
  PatchPayload,
  ReviewComment,
  SessionInfo,
} from '../../src/shared/protocol';

/** Base path of the session, e.g. `/s/<token>/`. */
function sessionBase(): string {
  const match = /^\/s\/[^/]+\//.exec(window.location.pathname);
  if (!match) throw new Error('not inside a session URL');
  return match[0];
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(sessionBase() + input, init);
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // keep status text
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function fetchSession(): Promise<SessionInfo> {
  return json<SessionInfo>('api/session');
}

export function fetchPatch(filter: DiffFilter): Promise<PatchPayload> {
  return json<PatchPayload>(`api/patch?filter=${filter}`);
}

/** Full old/new contents for one diffed file (edit-mode hydration). */
export function fetchFileContents(filter: DiffFilter, path: string): Promise<FileContentsPayload> {
  return json<FileContentsPayload>(`api/file?filter=${filter}&path=${encodeURIComponent(path)}`);
}

export function applyEdits(
  action: 'commit' | 'discard',
  request: ApplyEditsRequest,
): Promise<{ ok: true; warning?: string }> {
  return json(`api/edits/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export function createComment(request: NewCommentRequest): Promise<ReviewComment> {
  return json<ReviewComment>('api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

export function updateComment(id: string, body: string): Promise<ReviewComment> {
  return json<ReviewComment>(`api/comments/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

export function deleteComment(id: string): Promise<{ ok: boolean }> {
  return json<{ ok: boolean }>(`api/comments/${id}`, { method: 'DELETE' });
}

export interface EventHandlers {
  onSession(session: SessionInfo): void;
  onPatch(event: PatchChangedEvent): void;
  onComments(comments: ReviewComment[]): void;
  onOpen(): void;
  onDisconnect(): void;
  onEnd(): void;
}

/** Open the live SSE stream for one filter. Returns a close function. */
export function openEvents(filter: DiffFilter, handlers: EventHandlers): () => void {
  const source = new EventSource(`${sessionBase()}api/events?filter=${filter}`);
  source.addEventListener('open', () => handlers.onOpen());
  source.addEventListener('error', () => handlers.onDisconnect());
  source.addEventListener('session', (e) =>
    handlers.onSession(JSON.parse((e as MessageEvent<string>).data) as SessionInfo),
  );
  source.addEventListener('patch', (e) =>
    handlers.onPatch(JSON.parse((e as MessageEvent<string>).data) as PatchChangedEvent),
  );
  source.addEventListener('comments', (e) =>
    handlers.onComments(
      (JSON.parse((e as MessageEvent<string>).data) as { comments: ReviewComment[] }).comments,
    ),
  );
  source.addEventListener('end', () => {
    handlers.onEnd();
    source.close();
  });
  return () => source.close();
}
