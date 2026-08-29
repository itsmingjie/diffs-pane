import { ChevronDownIcon } from '@radix-ui/react-icons';
import {
  parsePatchFiles,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs';
import {
  CodeView,
  useStableCallback,
  useWorkerPool,
  type CodeViewHandle,
} from '@pierre/diffs/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type {
  DiffFilter,
  PatchFileSummary,
  PatchPayload,
  ReviewComment,
  SessionInfo,
} from '../../src/shared/protocol';
import * as api from './api';
import {
  annotationsKey,
  buildAnnotations,
  type AnnotationMeta,
  type DraftComment,
} from './annotations';
import { CommentCard } from './components/CommentCard';
import { Sidebar } from './components/Sidebar';
import { Toolbar, type ViewSettings } from './components/Toolbar';
import { parseLineHash, syncLineHash } from './lineHash';
import { codeViewTheme, fontSettingsFromSearch, syncTheme, themeFromSearch } from './themes';

type Connection = 'connected' | 'connecting' | 'reconnecting' | 'ended';

const NARROW_VIEW_QUERY = '(max-width: 767px)';
const CODE_VIEW_LAYOUT = { paddingTop: 4, gap: 1, paddingBottom: 16 };
const CODE_VIEW_UNSAFE_CSS = `
  [data-diffs-header][data-sticky] {
    top: 4px;
  }

  [data-diffs-header][data-sticky]::before {
    content: '';
    position: absolute;
    inset: -4px 0 100%;
    background: var(--diffs-bg);
    pointer-events: none;
  }
`;

const KIND_BADGE: Record<PatchFileSummary['kind'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

interface ParsedFile {
  path: string;
  fileDiff: FileDiffMetadata;
}

export function App() {
  const workerPool = useWorkerPool();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DiffFilter | null>(null);
  const [patch, setPatch] = useState<PatchPayload | null>(null);
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [view, setView] = useState<ViewSettings>(() => ({
    diffStyle: 'split',
    overflow: 'scroll',
    theme: themeFromSearch(window.location.search),
    ...fontSettingsFromSearch(window.location.search),
  }));
  const [narrowView, setNarrowView] = useState(() => window.matchMedia(NARROW_VIEW_QUERY).matches);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia(NARROW_VIEW_QUERY).matches,
  );
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);

  const viewerRef = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const patchHashRef = useRef<string | null>(null);
  const pendingHashTargetRef = useRef<CodeViewLineSelection | null>(
    parseLineHash(window.location.hash),
  );
  const activeFilter = filter ?? session?.defaultFilter ?? 'branch';
  const effectiveDiffStyle = narrowView ? 'unified' : view.diffStyle;

  useEffect(() => syncTheme(view.theme), [view.theme]);

  useEffect(() => {
    void workerPool?.setRenderOptions({ theme: codeViewTheme(view.theme) });
  }, [view.theme, workerPool]);

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEW_QUERY);
    const update = (matches: boolean) => {
      setNarrowView(matches);
      if (matches) setSidebarOpen(false);
    };
    const handleChange = (event: MediaQueryListEvent) => update(event.matches);
    update(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    if (!narrowView || !sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [narrowView, sidebarOpen]);

  // ── Initial load ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.fetchSession();
        if (cancelled) return;
        setSession(info);
        setFilter((current) => current ?? info.defaultFilter);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadPatch = useCallback(async (target: DiffFilter) => {
    try {
      const payload = await api.fetchPatch(target);
      patchHashRef.current = payload.patchHash;
      setPatch(payload);
    } catch (error) {
      setPatch({
        filter: target,
        patchHash: 'load-error',
        patch: '',
        files: [],
        error: error instanceof Error ? error.message : String(error),
        generatedAt: new Date().toISOString(),
      });
    }
  }, []);

  // ── Live events (per viewed filter) ──────────────────────────────────
  const sessionReady = session !== null;
  useEffect(() => {
    if (!sessionReady || filter === null) return;
    let opened = false;
    setConnection('connecting');
    patchHashRef.current = null;
    void loadPatch(filter);

    const close = api.openEvents(filter, {
      onOpen: () => {
        setConnection('connected');
        if (opened) {
          // Reconnected: catch up on anything missed while offline.
          void loadPatch(filter);
        }
        opened = true;
      },
      onDisconnect: () => setConnection('reconnecting'),
      onEnd: () => setConnection('ended'),
      onSession: setSession,
      onComments: setComments,
      onPatch: (event) => {
        if (event.filter === filter && event.patchHash !== patchHashRef.current) {
          void loadPatch(filter);
        }
      },
    });
    return close;
  }, [sessionReady, filter, loadPatch]);

  // Drafts and selections don't carry across diff sources.
  useEffect(() => {
    setDraft(null);
    setSelectedLines(null);
  }, [activeFilter]);

  // ── Parse the patch with @pierre/diffs ───────────────────────────────
  const parsedFiles = useMemo<ParsedFile[]>(() => {
    if (!patch || patch.patch === '') return [];
    const parsed = parsePatchFiles(patch.patch, patch.patchHash.slice(0, 16));
    const fileDiffs = parsed.flatMap((p) => p.files);
    // Server summaries and parsed files come from the same patch in the same
    // order; pair them so path identifiers match the sidebar exactly.
    return fileDiffs.map((fileDiff, index) => ({
      path: patch.files[index]?.path ?? fileDiff.name,
      fileDiff,
    }));
  }, [patch]);

  const filesByPath = useMemo(
    () => new Map((patch?.files ?? []).map((f) => [f.path, f])),
    [patch?.files],
  );
  const totalLines = useMemo(
    () => parsedFiles.reduce((sum, file) => sum + file.fileDiff.unifiedLineCount, 0),
    [parsedFiles],
  );

  const filterComments = useMemo(
    () => comments.filter((c) => c.filter === activeFilter),
    [comments, activeFilter],
  );

  // ── CodeView items with minimal version churn ────────────────────────
  const annotationsByPath = useMemo(
    () => buildAnnotations(filterComments, draft),
    [filterComments, draft],
  );

  const versionsRef = useRef(new Map<string, { version: number; key: string }>());
  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(() => {
    const hash = patch?.patchHash ?? '';
    return parsedFiles.map(({ path, fileDiff }) => {
      const id = `f:${path}`;
      const annotations = annotationsByPath.get(path) ?? [];
      const collapsed = collapsedPaths.has(path);
      const key = `${hash}|${collapsed ? 1 : 0}|${annotationsKey(annotations)}`;
      const entry = versionsRef.current.get(id);
      let version = entry?.version ?? 1;
      if (!entry || entry.key !== key) {
        version = (entry?.version ?? 0) + 1;
        versionsRef.current.set(id, { version, key });
      }
      return { id, type: 'diff', fileDiff, annotations, collapsed, version };
    });
  }, [parsedFiles, annotationsByPath, collapsedPaths, patch?.patchHash]);

  // Restore a line permalink once its target file is in the rendered patch.
  useEffect(() => {
    const target = pendingHashTargetRef.current;
    if (!target || items.length === 0) return;
    if (!items.some((item) => item.id === target.id)) return;
    pendingHashTargetRef.current = null;
    setSelectedLines(target);
    viewerRef.current?.scrollTo({
      type: 'range',
      id: target.id,
      range: target.range,
      align: 'center',
    });
  }, [items]);

  // ── Selection & permalinks ───────────────────────────────────────────
  const handleSelectedLinesChange = useStableCallback((selection: CodeViewLineSelection | null) => {
    setSelectedLines(selection);
    syncLineHash(selection);
  });

  // ── Collapse ─────────────────────────────────────────────────────────
  const toggleFileCollapsed = useStableCallback((path: string) => {
    const viewer = viewerRef.current;
    const instance = viewer?.getInstance();
    const itemTop = instance?.getTopForItem(`f:${path}`);
    const scrollTop = instance?.getScrollTop();
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
    // Keep a file collapsed above the viewport anchored in view.
    if (itemTop !== undefined && scrollTop !== undefined && itemTop < scrollTop) {
      requestAnimationFrame(() => {
        viewerRef.current?.scrollTo({ type: 'item', id: `f:${path}`, align: 'start' });
      });
    }
  });

  // ── Comment actions ──────────────────────────────────────────────────
  const handleGutterClick = useStableCallback((range: SelectedLineRange, itemId: string) => {
    setDraft({
      path: itemId.slice(2),
      side: range.endSide ?? range.side ?? 'additions',
      startLine: Math.min(range.start, range.end),
      endLine: Math.max(range.start, range.end),
    });
  });

  const createComment = useStableCallback(async (target: DraftComment, body: string) => {
    await api.createComment({
      filter: activeFilter,
      path: target.path,
      side: target.side,
      startLine: target.startLine,
      endLine: target.endLine,
      body,
    });
    setDraft(null);
  });

  const updateComment = useStableCallback(async (id: string, body: string) => {
    await api.updateComment(id, body);
  });

  const removeComment = useStableCallback(async (id: string) => {
    await api.deleteComment(id);
  });

  const openFile = useStableCallback((path: string) => {
    if (narrowView) setSidebarOpen(false);
    // Expand a collapsed file before navigating to it.
    setCollapsedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'item', id: `f:${path}`, align: 'start' });
    });
  });

  const openComment = useStableCallback((comment: ReviewComment) => {
    if (narrowView) setSidebarOpen(false);
    if (comment.outdated) {
      openFile(comment.path);
      return;
    }
    const id = `f:${comment.path}`;
    const range: SelectedLineRange = {
      start: comment.startLine,
      side: comment.side,
      end: comment.endLine,
      endSide: comment.side,
    };
    handleSelectedLinesChange({ id, range });
    // Expand the file first when collapsed, then navigate on the next frame.
    setCollapsedPaths((prev) => {
      if (!prev.has(comment.path)) return prev;
      const next = new Set(prev);
      next.delete(comment.path);
      return next;
    });
    requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({
        type: 'line',
        id,
        lineNumber: comment.endLine,
        side: comment.side,
        align: 'center',
        behavior: 'smooth-auto',
      });
    });
  });

  // ── CodeView options (memoized: CodeView diffs options by identity) ──
  const options = useMemo<CodeViewOptions<AnnotationMeta>>(
    () => ({
      theme: codeViewTheme(view.theme),
      diffStyle: effectiveDiffStyle,
      overflow: view.overflow,
      stickyHeaders: true,
      enableLineSelection: true,
      enableGutterUtility: true,
      lineHoverHighlight: 'number',
      hunkSeparators: 'line-info-basic',
      itemMetrics: { lineHeight: view.lineHeight },
      layout: CODE_VIEW_LAYOUT,
      unsafeCSS: CODE_VIEW_UNSAFE_CSS,
      onGutterUtilityClick(range, context) {
        if (context.item.type === 'diff') handleGutterClick(range, context.item.id);
      },
    }),
    [effectiveDiffStyle, view.overflow, view.theme, view.lineHeight, handleGutterClick],
  );

  const renderCustomHeader = useStableCallback((item: CodeViewItem<AnnotationMeta>) => (
    <FileHeader
      path={item.id.slice(2)}
      summary={filesByPath.get(item.id.slice(2))}
      collapsed={item.collapsed === true}
      onToggleCollapsed={toggleFileCollapsed}
    />
  ));

  const renderAnnotation = useStableCallback((annotation: { metadata: AnnotationMeta }) => (
    <CommentCard
      meta={annotation.metadata}
      onCreate={createComment}
      onUpdate={updateComment}
      onDelete={removeComment}
      onCancelDraft={() => setDraft(null)}
    />
  ));

  // ── Render ───────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="fullscreen-message error">
        <h1>diffs-pane</h1>
        <p>{loadError}</p>
      </div>
    );
  }
  if (!session || !patch) {
    return <div className="fullscreen-message">Loading…</div>;
  }

  return (
    <div className="app">
      <Toolbar
        session={session}
        filter={activeFilter}
        onFilterChange={setFilter}
        view={{ ...view, diffStyle: effectiveDiffStyle }}
        onViewChange={setView}
        unifiedOnly={narrowView}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        connection={connection}
      />
      <div className={`content ${narrowView ? 'narrow' : ''}`}>
        {narrowView && sidebarOpen && (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {sidebarOpen && (
          <Sidebar
            files={patch.files}
            comments={filterComments}
            totalLines={totalLines}
            onOpenFile={openFile}
            onOpenComment={openComment}
          />
        )}
        <main
          className="diff-pane"
          style={
            {
              '--viewer-font-family': view.fontFamily,
              '--viewer-font-size': `${view.fontSize}px`,
              '--viewer-line-height': `${view.lineHeight}px`,
            } as CSSProperties
          }
        >
          {patch.error ? (
            <div className="banner error">{patch.error}</div>
          ) : items.length === 0 ? (
            <div className="fullscreen-message subtle">
              No changes in the{' '}
              {activeFilter === 'unstaged' ? session.unstagedLabel.toLowerCase() : activeFilter}{' '}
              diff.
            </div>
          ) : (
            <CodeView<AnnotationMeta>
              ref={viewerRef}
              items={items}
              className="code-view"
              options={options}
              selectedLines={selectedLines}
              onSelectedLinesChange={handleSelectedLinesChange}
              renderCustomHeader={renderCustomHeader}
              renderAnnotation={renderAnnotation}
            />
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Custom sticky file header: collapse chevron, status badge, path, ± stats.
 * (The built-in header caches its HTML across item updates, so live patch
 * refreshes would show stale stats.)
 */
function FileHeader({
  path,
  summary,
  collapsed,
  onToggleCollapsed,
}: {
  path: string;
  summary: PatchFileSummary | undefined;
  collapsed: boolean;
  onToggleCollapsed(path: string): void;
}) {
  return (
    <div className="file-header">
      <button
        type="button"
        className="collapse-button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand diff' : 'Collapse diff'}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleCollapsed(path);
        }}
      >
        <ChevronDownIcon
          aria-hidden="true"
          className={collapsed ? 'chevron collapsed' : 'chevron'}
        />
      </button>
      {summary && (
        <span className={`file-status ${summary.kind}`} title={summary.kind}>
          {KIND_BADGE[summary.kind]}
        </span>
      )}
      <span className="file-path">
        {summary?.prevPath !== undefined ? `${summary.prevPath} → ${path}` : path}
      </span>
      {summary &&
        (summary.binary ? (
          <span className="file-stats binary">binary</span>
        ) : (
          <span className="file-stats">
            <span className="add">+{summary.additions}</span>
            <span className="del">−{summary.deletions}</span>
          </span>
        ))}
    </div>
  );
}
