import { BarChartIcon, ChatBubbleIcon, FileIcon, MagnifyingGlassIcon } from '@radix-ui/react-icons';
import type { FileTreeOptions, GitStatus, GitStatusEntry } from '@pierre/trees';
import { preparePresortedFileTreeInput } from '@pierre/trees';
import { useStableCallback } from '@pierre/diffs/react';
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { FileChangeKind, PatchFileSummary, ReviewComment } from '../../../src/shared/protocol';
import { sortPathsForTree } from '../sortPaths';

const KIND_TO_STATUS: Record<FileChangeKind, GitStatus> = {
  added: 'added',
  deleted: 'deleted',
  modified: 'modified',
  renamed: 'renamed',
};

// Keep the built-in tree search mounted but hidden until the user opts in via
// the toolbar toggle; the tree reflects open state on `data-open`.
const TREE_UNSAFE_CSS = `
  [data-file-tree-search-container][data-open='false'] {
    display: none;
  }
  [data-file-tree-search-container] {
    padding: 0 8px 8px;
  }
  [data-item-contains-git-change='true'] > [data-item-section='git'] {
    display: none;
  }
  [title='Unsaved changes'] { color: #e9b949; }
  [data-item-type='folder'] {
    color: color-mix(in lab, light-dark(#000, #fff) 25%, var(--trees-fg));
    font-weight: 500;
  }
`;

/** Module scope so the reference is stable and useFileTree never churns. */
const BASE_TREE_OPTIONS = {
  flattenEmptyDirectories: true,
  initialExpansion: 'open',
  search: true,
  fileTreeSearchMode: 'hide-non-matches',
  stickyFolders: true,
  unsafeCSS: TREE_UNSAFE_CSS,
} as const satisfies Partial<FileTreeOptions>;

type SidebarTab = 'files' | 'comments';

interface FileSearchControl {
  isOpen: boolean;
  toggle(): void;
}

export interface SidebarProps {
  files: PatchFileSummary[];
  /** All comments for the active filter, including outdated ones. */
  comments: ReviewComment[];
  totalLines: number;
  dirtyPaths: ReadonlySet<string>;
  onOpenFile(path: string): void;
  onOpenComment(comment: ReviewComment): void;
}

export function Sidebar({
  files,
  comments,
  totalLines,
  dirtyPaths,
  onOpenFile,
  onOpenComment,
}: SidebarProps) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('files');
  const [fileSearch, setFileSearch] = useState<FileSearchControl | null>(null);

  return (
    <aside className="sidebar" id="diff-sidebar">
      <div className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'files'}
          className={activeTab === 'files' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('files')}
        >
          <FileIcon aria-hidden="true" />
          Files
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'comments'}
          className={activeTab === 'comments' ? 'tab active' : 'tab'}
          onClick={() => setActiveTab('comments')}
        >
          <ChatBubbleIcon aria-hidden="true" />
          Comments
          {comments.length > 0 && <span className="badge-count">{comments.length}</span>}
        </button>
        <button
          type="button"
          className="icon-button sidebar-search-button"
          aria-pressed={fileSearch?.isOpen ?? false}
          aria-label={fileSearch?.isOpen ? 'Hide file search' : 'Search files'}
          title={fileSearch?.isOpen ? 'Hide file search' : 'Search files'}
          onPointerDown={(event) => {
            // Let the button toggle the model state before the focused input blurs.
            event.preventDefault();
          }}
          onClick={() => {
            setActiveTab('files');
            fileSearch?.toggle();
          }}
        >
          <MagnifyingGlassIcon aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-body" hidden={activeTab !== 'files'}>
        <FilesTree
          files={files}
          dirtyPaths={dirtyPaths}
          comments={comments}
          onOpenFile={onOpenFile}
          onSearchControlChange={setFileSearch}
        />
      </div>
      <div className="sidebar-body" hidden={activeTab !== 'comments'}>
        <CommentsList comments={comments} files={files} onOpenComment={onOpenComment} />
      </div>
      <DiffStats files={files} totalLines={totalLines} unsavedFiles={dirtyPaths.size} />
    </aside>
  );
}

function FilesTree({
  files,
  dirtyPaths,
  comments,
  onOpenFile,
  onSearchControlChange,
}: {
  files: PatchFileSummary[];
  dirtyPaths: ReadonlySet<string>;
  comments: ReviewComment[];
  onOpenFile(path: string): void;
  onSearchControlChange(control: FileSearchControl): void;
}) {
  const sortedPaths = useMemo(() => sortPathsForTree(files.map((f) => f.path)), [files]);
  const stablePaths = useStablePaths(sortedPaths);
  const preparedInput = useMemo(() => preparePresortedFileTreeInput(stablePaths), [stablePaths]);

  // Latest data for callbacks captured once at model creation.
  const filePathsRef = useRef(new Set<string>());
  const commentCountsRef = useRef(new Map<string, number>());
  const dirtyPathsRef = useRef(dirtyPaths);
  dirtyPathsRef.current = dirtyPaths;
  filePathsRef.current = new Set(files.map((f) => f.path));
  commentCountsRef.current = countByPath(comments);

  const handleSelectionChange = useStableCallback((selected: readonly string[]) => {
    const path = selected[0];
    if (path !== undefined && filePathsRef.current.has(path)) onOpenFile(path);
  });

  const { model } = useFileTree({
    ...BASE_TREE_OPTIONS,
    preparedInput,
    itemHeight: 24,
    onSelectionChange: handleSelectionChange,
    renderRowDecoration: ({ item }) => {
      if (!filePathsRef.current.has(item.path)) return null;
      if (dirtyPathsRef.current.has(item.path)) return { text: '●', title: 'Unsaved changes' };
      const count = commentCountsRef.current.get(item.path) ?? 0;
      if (count === 0) return null;
      return {
        text: String(count),
        title: `${count} review comment${count === 1 ? '' : 's'}`,
      };
    },
  });
  const search = useFileTreeSearch(model);
  const toggleSearch = useStableCallback(() => {
    if (search.isOpen) search.close();
    else search.open();
  });
  const searchControl = useMemo(
    () => ({ isOpen: search.isOpen, toggle: toggleSearch }),
    [search.isOpen, toggleSearch],
  );

  useEffect(() => onSearchControlChange(searchControl), [onSearchControlChange, searchControl]);

  useEffect(() => {
    model.resetPaths({ preparedInput });
  }, [model, preparedInput]);

  useEffect(() => {
    const status: GitStatusEntry[] = files.map((f) => ({
      path: f.path,
      status: KIND_TO_STATUS[f.kind],
    }));
    model.setGitStatus(status);
  }, [model, files]);

  useEffect(() => {
    // Re-render decorations with the latest value from commentCountsRef.
    model.setComposition();
  }, [model, comments, dirtyPaths]);

  if (files.length === 0) {
    return <div className="sidebar-empty">No changed files</div>;
  }
  return (
    <div className="tree-host">
      <FileTree model={model} className="file-tree" />
    </div>
  );
}

interface CommentSection {
  path: string;
  comments: ReviewComment[];
}

function CommentsList({
  comments,
  files,
  onOpenComment,
}: {
  comments: ReviewComment[];
  files: PatchFileSummary[];
  onOpenComment(comment: ReviewComment): void;
}) {
  const sections = useMemo(() => groupByFile(comments, files), [comments, files]);

  if (sections.length === 0) {
    return (
      <div className="sidebar-empty">
        <strong>No comments yet</strong>
        <p>
          Hover a line number and click the <span className="hint-plus">+</span> button to leave a
          review comment. Agents read them with <code>dp reviews</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="comments-list">
      {sections.map((section) => (
        <section key={section.path}>
          <h3 className="comments-section-path">{section.path}</h3>
          {section.comments.map((comment) => (
            <button
              key={comment.id}
              type="button"
              className="comment-link"
              onClick={() => onOpenComment(comment)}
              title={comment.outdated ? 'Outdated: the commented lines changed' : undefined}
            >
              <span className={`comment-line ${comment.outdated ? '' : comment.side}`}>
                {commentLineLabel(comment)}
              </span>
              {comment.outdated && <span className="badge">outdated</span>}
              <span className="comment-preview">{comment.body}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US');

function DiffStats({
  files,
  totalLines,
  unsavedFiles,
}: {
  files: PatchFileSummary[];
  totalLines: number;
  unsavedFiles: number;
}) {
  const [expanded, setExpanded] = useState(true);
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return (
    <footer className="diff-stats">
      <button
        type="button"
        className="diff-stats-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <BarChartIcon aria-hidden="true" />
        <span>Diff Stats</span>
      </button>
      {expanded && (
        <div className="diff-stats-details">
          <StatRow label="Files" value={files.length} />
          <StatRow label="Unsaved files" value={unsavedFiles} />
          <StatRow label="Additions" value={additions} tone="additions" />
          <StatRow label="Deletions" value={deletions} tone="deletions" />
          <StatRow label="Lines of code" value={totalLines} />
        </div>
      )}
    </footer>
  );
}

function StatRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'additions' | 'deletions';
}) {
  return (
    <div className="diff-stat-row">
      <span>{label}</span>
      <strong className={tone}>{NUMBER_FORMATTER.format(value)}</strong>
    </div>
  );
}

function commentLineLabel(comment: ReviewComment): string {
  const sigil = comment.side === 'additions' ? '+' : '−';
  const range =
    comment.startLine === comment.endLine
      ? `${comment.startLine}`
      : `${comment.startLine}–${comment.endLine}`;
  return `Line ${sigil}${range}`;
}

/** Group comments by file in patch order, then by line within each file. */
function groupByFile(comments: ReviewComment[], files: PatchFileSummary[]): CommentSection[] {
  const byPath = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const list = byPath.get(comment.path);
    if (list) list.push(comment);
    else byPath.set(comment.path, [comment]);
  }
  const ordered: CommentSection[] = [];
  const emit = (path: string) => {
    const list = byPath.get(path);
    if (!list) return;
    byPath.delete(path);
    list.sort((a, b) => a.startLine - b.startLine || a.createdAt.localeCompare(b.createdAt));
    ordered.push({ path, comments: list });
  };
  for (const file of files) emit(file.path);
  for (const path of [...byPath.keys()].sort()) emit(path); // outdated-only files
  return ordered;
}

function useStablePaths(paths: readonly string[]): readonly string[] {
  const stable = useRef(paths);
  if (
    stable.current.length !== paths.length ||
    stable.current.some((path, index) => path !== paths[index])
  ) {
    stable.current = paths;
  }
  return stable.current;
}

function countByPath(comments: ReviewComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) counts.set(c.path, (counts.get(c.path) ?? 0) + 1);
  return counts;
}
