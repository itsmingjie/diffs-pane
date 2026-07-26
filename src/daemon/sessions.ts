import { randomBytes, randomUUID } from 'node:crypto';

import type { DiffFilter } from '../shared/protocol.js';
import { readJson, writeJsonAtomic } from '../store/fsutil.js';
import { sessionsPath } from '../store/paths.js';
import { detectBackend } from '../vcs/detect.js';
import { Session, type SessionRecord } from './session.js';

interface SessionsFile {
  version: 1;
  sessions: SessionRecord[];
}

export interface EnsureOptions {
  owner: string;
  filter?: DiffFilter;
  base?: string;
  watch?: boolean;
}

export const DEFAULT_OWNER = 'default';

/**
 * Manages the daemon's sessions: one shared session per canonical working
 * tree, with generic owner leases. Metadata persists in the user-state dir so
 * capability URLs stay stable across daemon restarts.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>(); // canonical root → session
  /** Records for stopped sessions, kept so capability URLs stay stable. */
  private readonly dormant = new Map<string, SessionRecord>();

  constructor(
    private readonly stateDir: string,
    private readonly onEmpty: () => void,
  ) {}

  /** Restore sessions that still hold owner leases from a previous run. */
  async restore(): Promise<void> {
    const file = await readJson<SessionsFile>(sessionsPath(this.stateDir));
    if (file?.version !== 1) return;
    for (const record of file.sessions) {
      if (record.owners.length === 0) {
        this.dormant.set(record.root, record);
        continue;
      }
      try {
        const backend = await detectBackend(record.root, this.stateDir);
        if (backend.root !== record.root) continue;
        const session = await Session.start(record, backend, {
          stateDir: this.stateDir,
          onDirty: () => this.persist(),
        });
        this.sessions.set(record.root, session);
      } catch {
        // Working tree disappeared; drop the record.
      }
    }
    this.persist();
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  byToken(token: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (timingSafeEqualString(session.token, token)) return session;
    }
    return undefined;
  }

  async findByRoot(root: string): Promise<Session | undefined> {
    const direct = this.sessions.get(root);
    if (direct) return direct;
    try {
      const backend = await detectBackend(root, this.stateDir);
      return this.sessions.get(backend.root);
    } catch {
      return undefined;
    }
  }

  /** Create or reuse the shared session for a working tree and add a lease. */
  async ensure(
    root: string,
    options: EnsureOptions,
  ): Promise<{ session: Session; created: boolean }> {
    const backend = await detectBackend(root, this.stateDir);
    const existing = this.sessions.get(backend.root);
    if (existing) {
      if (options.watch !== undefined) await existing.setWatching(options.watch);
      existing.owners.add(options.owner);
      if (options.filter) existing.defaultFilter = options.filter;
      if (options.base !== undefined) existing.base = options.base;
      this.persist();
      return { session: existing, created: false };
    }

    // Reuse the persisted token for this root so the URL stays stable.
    const persisted = this.dormant.get(backend.root);
    this.dormant.delete(backend.root);
    const record: SessionRecord = {
      sessionId: persisted?.sessionId ?? randomUUID(),
      token: persisted?.token ?? randomBytes(24).toString('base64url'),
      root: backend.root,
      vcs: backend.kind,
      owners: [options.owner],
      defaultFilter: options.filter ?? 'branch',
      base: options.base ?? persisted?.base,
      watch: options.watch ?? persisted?.watch ?? true,
      turn: persisted?.turn,
    };
    const session = await Session.start(record, backend, {
      stateDir: this.stateDir,
      onDirty: () => this.persist(),
    });
    this.sessions.set(backend.root, session);
    this.persist();
    return { session, created: true };
  }

  /**
   * Release an owner lease. The session stops only when no leases remain;
   * the daemon exits when no sessions remain.
   */
  async removeOwner(
    root: string,
    owner: string,
  ): Promise<{ removed: boolean; sessionStopped: boolean }> {
    const session = await this.findByRoot(root);
    if (!session) return { removed: false, sessionStopped: false };
    const removed = session.owners.delete(owner);
    let sessionStopped = false;
    if (session.owners.size === 0) {
      await this.stopSession(session);
      sessionStopped = true;
    } else if (removed) {
      this.persist();
    }
    return { removed, sessionStopped };
  }

  /** Remove one owner's leases everywhere (e.g. `dp stop --owner m --all`). */
  async removeOwnerEverywhere(owner: string): Promise<number> {
    let stopped = 0;
    for (const session of this.list()) {
      if (!session.owners.delete(owner)) continue;
      if (session.owners.size === 0) {
        await this.stopSession(session);
        stopped++;
      }
    }
    this.persist();
    return stopped;
  }

  async stopAll(): Promise<void> {
    for (const session of this.list()) {
      await this.stopSession(session);
    }
  }

  private async stopSession(session: Session): Promise<void> {
    this.sessions.delete(session.root);
    session.owners.clear();
    this.dormant.set(session.root, session.toRecord());
    await session.close();
    this.persist();
    if (this.sessions.size === 0) this.onEmpty();
  }

  pingAll(): void {
    for (const session of this.sessions.values()) session.ping();
  }

  private persist(): void {
    const file: SessionsFile = {
      version: 1,
      sessions: [...this.list().map((s) => s.toRecord()), ...this.dormant.values()],
    };
    writeJsonAtomic(sessionsPath(this.stateDir), file);
  }
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) diff |= bufA[i]! ^ bufB[i]!;
  return diff === 0;
}
