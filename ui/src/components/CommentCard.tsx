import { Pencil2Icon, TrashIcon } from '@radix-ui/react-icons';
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
    return (
      <div className="comment-card">
        <CommentForm
          label={`Add a comment on ${rangeLabel(meta.draft.startLine, meta.draft.endLine)} (${meta.draft.side})`}
          submitLabel="Comment"
          onSubmit={(body) => onCreate(meta.draft, body)}
          onCancel={onCancelDraft}
        />
      </div>
    );
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

  return (
    <div className="comment-row">
      {editing ? (
        <CommentForm
          initialText={comment.body}
          label={`Edit comment on ${rangeLabel(comment.startLine, comment.endLine)} (${comment.side})`}
          submitLabel="Save"
          onSubmit={async (body) => {
            await onUpdate(comment.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="comment-read">
          <div className="comment-body">{comment.body}</div>
          <span className="comment-actions">
            <button
              type="button"
              className="comment-action-button"
              aria-label="Edit comment"
              title="Edit comment"
              onClick={() => setEditing(true)}
            >
              <Pencil2Icon aria-hidden="true" />
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
      )}
    </div>
  );
}

function CommentForm({
  initialText = '',
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialText?: string;
  label: string;
  submitLabel: string;
  onSubmit(body: string): Promise<void>;
  onCancel(): void;
}) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="comment-editor">
      <textarea
        autoFocus
        aria-label={label}
        placeholder="Add a comment..."
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
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
