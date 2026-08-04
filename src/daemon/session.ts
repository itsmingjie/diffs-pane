import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

import { parsePatch, summarizeFiles, type ParsedFilePatch } from '../shared/patch.js';
import {
  DIFF_FILTERS,
  type DiffFilter,
  type PatchPayload,
  type ReviewComment,
  type SessionInfo,
} from '../shared/protocol.js';
import { ReviewStore } from '../store/reviews.js';
import { ExecError } from '../vcs/exec.js';
import { VcsError, type TurnBaseline, type VcsBackend } from '../vcs/types.js';
import { watchWorkTree, type WorkTreeWatcher } from './watcher.js';

const MAX_PATCH_BYTES = Number(process.env['DIFFS_PANE_MAX_PATCH_BYTES'] ?? 20 * 1024 * 1024);

export interface TurnState {
  turnId: string;
  agent?: string;
  active: boolean;
  baseline: TurnBaseline;
}

export interface SessionRecord {
  sessionId: string;
  token: string;
  root: string;
  vcs: 'git' | 'jj';
  owners: string[];
  defaultFilter: DiffFilter;
  base?: string;
  /** Defaults to true for records written before this field existed. */
  watch?: boolean;
  turn?: TurnState;
}

interface SseClient {
  res: ServerResponse;
  filter: DiffFilter;
}

interface CacheEntry {
  payload: PatchPayload;
  dirty: boolean;
}

interface ComputedPayload {
  payload: PatchPayload;
  parsedFiles?: ParsedFilePatch[];
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * One live review session for a working tree: owns the watcher, per-filter
 * patch cache, SSE clients, turn state, and the review store.
 */
export class Session {
  readonly sessionId: string;
  readonly token: string;
  readonly root: string;
  owners = new Set<string>();
  defaultFilter: DiffFilter;
  base: string | undefined;
  turn: TurnState | undefined;

  private readonly cache = new Map<DiffFilter, CacheEntry>();
  private readonly inflightPatches = new Map<DiffFilter, Promise<PatchPayload>>();
  /** Bumped on every invalidation so straddling computes stay marked stale. */
  private patchGeneration = 0;
  private readonly clients = new Set<SseClient>();
  private watcher: WorkTreeWatcher | null = null;
  private refreshAbort: AbortController | null = null;
  private refreshRunning = false;
  private refreshPending = false;
  private closed = false;

  private constructor(
    record: SessionRecord,
    private readonly backend: VcsBackend,
    private readonly reviews: ReviewStore,
    private readonly onDirty: () => void,
  ) {
    this.sessionId = record.sessionId;
    this.token = record.token;
    this.root = record.root;
    this.owners = new Set(record.owners);
    this.defaultFilter = record.defaultFilter;
    this.base = record.base;
    this.turn = record.turn;
  }

  static async start(
    record: SessionRecord,
    backend: VcsBackend,
    options: { stateDir?: string; onDirty: () => void },
  ): Promise<Session> {
    const reviews = await ReviewStore.load(record.root, options.stateDir);
    const session = new Session(record, backend, reviews, options.onDirty);
    if (record.watch !== false) {
      session.watcher = await watchWorkTree(record.root, () => session.handleFsChange());
    }
    return session;
  }

  toRecord(): SessionRecord {
    return {
      sessionId: this.sessionId,
      token: this.token,
      root: this.root,
      vcs: this.backend.kind,
      owners: [...this.owners],
      defaultFilter: this.defaultFilter,
      base: this.base,
      watch: this.isWatching(),
      turn: this.turn,
    };
  }

  info(): SessionInfo {
    return {
      sessionId: this.sessionId,
      root: this.root,
      vcs: this.backend.kind,
      defaultFilter: this.defaultFilter,
      unstagedLabel: this.backend.kind === 'jj' ? 'Working copy' : 'Unstaged',
      turn: this.turn
        ? { turnId: this.turn.turnId, agent: this.turn.agent, active: this.turn.active }
        : null,
    };
  }

  clientCount(): number {
    return this.clients.size;
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  async setWatching(enabled: boolean): Promise<void> {
    if (enabled === this.isWatching()) return;
    if (enabled) {
      if (this.closed) return;
      const watcher = await watchWorkTree(this.root, () => this.handleFsChange());
      if (this.closed) await watcher.close();
      else this.watcher = watcher;
      return;
    }

    const watcher = this.watcher;
    this.watcher = null;
    await watcher?.close();
  }

  listComments(): ReviewComment[] {
    return this.reviews.list();
  }

  // ── Patch computation ────────────────────────────────────────────────

  /** Serve the patch for a filter, recomputing only when stale. */
  async getPatch(filter: DiffFilter): Promise<PatchPayload> {
    for (;;) {
      const entry = this.cache.get(filter);
      if (entry && !entry.dirty) return entry.payload;
      try {
        return await this.computeAndCache(filter, undefined);
      } catch (error) {
        // A request may have joined an abortable refresh computation. Retry
        // against the new generation rather than surfacing a transient 500.
        if (error instanceof ExecError && error.aborted) continue;
        throw error;
      }
    }
  }

  /** Coalesce all patch computation paths into one in-flight job per filter. */
  private computeAndCache(
    filter: DiffFilter,
    signal: AbortSignal | undefined,
    snapshotKey?: object,
  ): Promise<PatchPayload> {
    const existing = this.inflightPatches.get(filter);
    if (existing) return existing;

    const startGeneration = this.patchGeneration;
    let pending: Promise<PatchPayload>;
    pending = this.computePayload(filter, signal, snapshotKey)
      .then(({ payload, parsedFiles }) => {
        // A newer concurrent job may have already stored a fresh result.
        const current = this.cache.get(filter);
        if (current && !current.dirty) return current.payload;
        // Results that straddled an invalidation stay dirty for the next pass.
        const dirty = this.patchGeneration !== startGeneration;
        this.cache.set(filter, { payload, dirty });
        if (
          !dirty &&
          parsedFiles &&
          this.reviews.reanchor(filter, parsedFiles, payload.patchHash)
        ) {
          this.broadcastComments();
        }
        return payload;
      })
      .finally(() => {
        if (this.inflightPatches.get(filter) === pending) this.inflightPatches.delete(filter);
      });
    this.inflightPatches.set(filter, pending);
    return pending;
  }

  private async computePayload(
    filter: DiffFilter,
    signal: AbortSignal | undefined,
    snapshotKey?: object,
  ): Promise<ComputedPayload> {
    const generatedAt = new Date().toISOString();
    try {
      const patch = await this.backend.computePatch(filter, {
        signal,
        base: this.base,
        turnBaseline: this.turn?.baseline,
        snapshotKey,
      });
      if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
        return {
          payload: this.errorPayload(
            filter,
            `Patch exceeds the ${Math.round(MAX_PATCH_BYTES / 1024 / 1024)}MB size limit.`,
            generatedAt,
          ),
        };
      }
      const parsedFiles = parsePatch(patch);
      const payload: PatchPayload = {
        filter,
        patchHash: sha256(patch),
        patch,
        // Per-file hashes let the UI reuse parsed and rendered state for
        // files whose section did not change in a refresh.
        files: summarizeFiles(parsedFiles).map((summary, index) =>
          Object.assign(summary, {
            sectionHash: sha256(parsedFiles[index]!.raw).slice(0, 32),
          }),
        ),
        error: null,
        generatedAt,
      };
      return { payload, parsedFiles };
    } catch (error) {
      if (error instanceof ExecError && error.aborted) throw error;
      const message =
        error instanceof VcsError
          ? error.message
          : `Failed to compute ${filter} diff: ${error instanceof Error ? error.message : String(error)}`;
      return { payload: this.errorPayload(filter, message, generatedAt) };
    }
  }

  private errorPayload(filter: DiffFilter, message: string, generatedAt: string): PatchPayload {
    return {
      filter,
      patchHash: sha256(`error:${message}`),
      patch: '',
      files: [],
      error: message,
      generatedAt,
    };
  }

  // ── Refresh scheduling ───────────────────────────────────────────────

  private handleFsChange(): void {
    if (this.closed) return;
    // Everything is stale; recompute only what connected clients view.
    this.patchGeneration++;
    this.inflightPatches.clear();
    for (const filter of DIFF_FILTERS) {
      const entry = this.cache.get(filter);
      if (entry) entry.dirty = true;
    }
    void this.scheduleRefresh();
  }

  private viewedFilters(): DiffFilter[] {
    const filters = new Set<DiffFilter>();
    for (const client of this.clients) filters.add(client.filter);
    return [...filters];
  }

  private async scheduleRefresh(): Promise<void> {
    if (this.refreshRunning) {
      // Coalesce: newer filesystem state supersedes the in-flight compute.
      this.refreshPending = true;
      this.refreshAbort?.abort();
      return;
    }
    this.refreshRunning = true;
    try {
      do {
        this.refreshPending = false;
        this.refreshAbort = new AbortController();
        await this.refreshViewed(this.refreshAbort.signal);
      } while (this.refreshPending && !this.closed);
    } finally {
      this.refreshRunning = false;
      this.refreshAbort = null;
    }
  }

  private async refreshViewed(signal: AbortSignal): Promise<void> {
    const snapshotKey = {};
    for (const filter of this.viewedFilters()) {
      const previous = this.cache.get(filter);
      if (previous && !previous.dirty) continue;

      let payload: PatchPayload;
      try {
        payload = await this.computeAndCache(filter, signal, snapshotKey);
      } catch (error) {
        if (error instanceof ExecError && error.aborted) return; // Superseded.
        throw error;
      }
      const stored = this.cache.get(filter);
      if (!stored || stored.dirty || signal.aborted) return; // Superseded.
      if (previous?.payload.patchHash !== payload.patchHash) {
        // Broadcast only real changes so clients never reparse identical patches.
        this.broadcast('patch', { filter, patchHash: payload.patchHash });
      }
    }
  }

  // ── SSE ──────────────────────────────────────────────────────────────

  addClient(res: ServerResponse, filter: DiffFilter): void {
    const client: SseClient = { res, filter };
    this.clients.add(client);
    res.on('close', () => {
      this.clients.delete(client);
    });
    // If the viewed filter went stale while nobody watched it, catch up now.
    const entry = this.cache.get(filter);
    if (!entry || entry.dirty) void this.scheduleRefresh();
  }

  private broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) client.res.write(frame);
  }

  broadcastComments(): void {
    this.broadcast('comments', { comments: this.reviews.list() });
  }

  ping(): void {
    for (const client of this.clients) client.res.write(': ping\n\n');
  }

  // ── Reviews ──────────────────────────────────────────────────────────

  get reviewStore(): ReviewStore {
    return this.reviews;
  }

  // ── Turn lifecycle ───────────────────────────────────────────────────

  /** Idempotent: repeated starts for the same turn keep the first baseline. */
  async startTurn(turnId: string, agent: string | undefined): Promise<void> {
    if (this.turn && this.turn.turnId === turnId && this.turn.active) return;
    const baseline = await this.backend.captureTurnBaseline();
    this.turn = { turnId, agent, active: true, baseline };
    this.invalidateFilter('turn');
    this.onDirty();
    this.broadcast('session', this.info());
    void this.scheduleRefresh();
  }

  endTurn(turnId: string): void {
    if (!this.turn || this.turn.turnId !== turnId || !this.turn.active) return;
    this.turn.active = false;
    this.onDirty();
    this.broadcast('session', this.info());
  }

  private invalidateFilter(filter: DiffFilter): void {
    this.patchGeneration++;
    this.inflightPatches.delete(filter);
    const entry = this.cache.get(filter);
    if (entry) entry.dirty = true;
  }

  // ── Shutdown ─────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
    this.refreshAbort?.abort();
    await this.watcher?.close();
    this.watcher = null;
    for (const client of this.clients) {
      client.res.write('event: end\ndata: {}\n\n');
      client.res.end();
    }
    this.clients.clear();
  }
}
