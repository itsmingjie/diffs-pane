import { Cross2Icon, Pencil2Icon, TrashIcon } from '@radix-ui/react-icons';
import { useState } from 'react';

import type { ReviewComment } from '../../../src/shared/protocol';
import type { AnnotationMeta, DraftComment } from '../annotations';

export interface CommentCardProps {
  meta: AnnotationMeta;
  onCreate(draft: DraftComment, body: string): Promise<void>;
  onUpdate(id: string, body: string): Promise<void>;
  onDelete(id: string): Promise<void>;
  onCancelDraft(): void;
}

/** Inline annotation card: either an existing comment thread or a draft form. */
export function CommentCard({
  meta,
  onCreate,
  onUpdate,
  onDelete,
  onCancelDraft,
}: CommentCardProps) {
  if (meta.kind === 'draft') {
    return <DraftForm draft={meta.draft} onCreate={onCreate} onCancel={onCancelDraft} />;
  }
  return (
    <div className="comment-card">
      {meta.comments.map((comment) => (
        <CommentRow key={comment.id} comment={comment} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
    </div>
  );
}

function rangeLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `line ${endLine}` : `lines ${startLine}–${endLine}`;
}

function CommentRow({
  comment,
  onUpdate,
  onDelete,
}: {
  comment: ReviewComment;
  onUpdate(id: string, body: string): Promise<void>;
  onDelete(id: string): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (text.trim() === '') return;
    setBusy(true);
    try {
      await onUpdate(comment.id, text);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comment-row">
      <div className="comment-meta">
        <span className="comment-side">{comment.side === 'additions' ? '+' : '−'}</span>
        <span>{rangeLabel(comment.startLine, comment.endLine)}</span>
        <span className="comment-actions">
          <button
            type="button"
            className="comment-action-button"
            aria-label={editing ? 'Cancel editing' : 'Edit comment'}
            title={editing ? 'Cancel editing' : 'Edit comment'}
            onClick={() => {
              setEditing((v) => !v);
              setText(comment.body);
            }}
          >
            {editing ? <Cross2Icon aria-hidden="true" /> : <Pencil2Icon aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="comment-action-button danger"
            aria-label="Delete comment"
            title="Delete comment"
            onClick={() => void onDelete(comment.id)}
          >
            <TrashIcon aria-hidden="true" />
          </button>
        </span>
      </div>
      {editing ? (
        <div className="comment-editor">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && event.metaKey) {
                event.preventDefault();
                void save();
              }
            }}
            rows={3}
            disabled={busy}
          />
          <div className="comment-editor-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={busy || text.trim() === ''}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="comment-body">{comment.body}</div>
      )}
    </div>
  );
}

function DraftForm({
  draft,
  onCreate,
  onCancel,
}: {
  draft: DraftComment;
  onCreate(draft: DraftComment, body: string): Promise<void>;
  onCancel(): void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(draft, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="comment-card draft">
      <div className="comment-meta">
        <span className="comment-side">{draft.side === 'additions' ? '+' : '−'}</span>
        <span>
          New comment on {rangeLabel(draft.startLine, draft.endLine)} ({draft.side})
        </span>
      </div>
      <div className="comment-editor">
        <textarea
          autoFocus
          placeholder="Leave a review comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.metaKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          disabled={busy}
        />
        {error && <div className="comment-error">{error}</div>}
        <div className="comment-editor-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={busy || text.trim() === ''}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}
