import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from './confirmation-dialog.js';
import { LiveRegion } from './feedback.js';

type GrantState = 'granted' | 'missing' | 'declined';
type PermissionState = Record<'instagram_basic' | 'instagram_manage_comments', GrantState>;
type CapabilityStatus = 'available' | 'needs_permission' | 'declined' | 'unknown';
type ActionKind = 'comment_reply' | 'dm_reply';
type ActionState = 'idle' | 'pending' | 'success' | 'failure' | 'unknown';

interface Media {
  id: string;
  caption: string;
  timestamp: string;
}
interface Comment {
  id: string;
  text: string;
  username: string | null;
}
interface Conversation {
  id: string;
  updatedAt: string | null;
  participants: { id: string; username: string | null }[];
}
interface Message {
  id: string;
  createdAt: string;
  senderId: string | null;
  senderUsername: string | null;
  text: string;
}
interface ScheduledReply { id: string; kind: ActionKind; text: string; dueAt: string; status: string; }

interface CapabilityRow {
  label: string;
  detail: string;
  state: CapabilityStatus;
}

function stateLabel(state: CapabilityStatus): string {
  if (state === 'available') return 'Verified';
  if (state === 'needs_permission') return 'Permission needed';
  if (state === 'declined') return 'Declined';
  return 'Unknown';
}

function capabilityState(
  status: PermissionState | null,
  permission: keyof PermissionState,
): CapabilityStatus {
  if (!status) return 'unknown';
  if (status[permission] === 'granted') return 'available';
  if (status[permission] === 'declined') return 'declined';
  return 'needs_permission';
}

export function InstagramUnifiedCapabilityControl({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [media, setMedia] = useState<Media[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedMedia, setSelectedMedia] = useState('');
  const [selectedComment, setSelectedComment] = useState('');
  const [selectedConversation, setSelectedConversation] = useState('');
  const [selectedMessage, setSelectedMessage] = useState('');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<ActionKind>('comment_reply');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<ActionState>('idle');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleDueAt, setScheduleDueAt] = useState('');
  const [scheduled, setScheduled] = useState<ScheduledReply[]>([]);
  const sendTrigger = useRef<HTMLButtonElement>(null);

  const loadPermissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/instagram-unified/status`, {
        headers: { accept: 'application/json' },
      });
      const result = (await response.json()) as {
        data: PermissionState | null;
        error: string | null;
      };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Capability status unavailable');
      setPermissions(result.data);
      setAnnouncement(`Verified capability status refreshed for ${accountName}.`);
    } catch (cause) {
      setPermissions(null);
      setError(cause instanceof Error ? cause.message : 'Capability status unavailable');
    } finally {
      setLoading(false);
    }
  }, [accountId, accountName]);

  const read = useCallback(async <T,>(path: string): Promise<T> => {
    const response = await fetch(path, { headers: { accept: 'application/json' } });
    const result = (await response.json()) as { data: T | null; error: string | null };
    if (!response.ok || result.data === null)
      throw new Error(result.error ?? 'Unified Instagram data unavailable');
    return result.data;
  }, []);

  const loadMedia = useCallback(async () => {
    setActionError(null);
    try {
      const result = await read<{ media: Media[] }>(
        `/api/provider-accounts/${accountId}/instagram-unified-media?limit=25`,
      );
      setMedia(result.media);
      setSelectedMedia(result.media[0]?.id ?? '');
      setComments([]);
      setSelectedComment('');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Media unavailable');
    }
  }, [accountId, read]);

  const loadComments = useCallback(async () => {
    if (!selectedMedia) return;
    try {
      const result = await read<{ comments: Comment[] }>(
        `/api/provider-accounts/${accountId}/instagram-unified-comments/${encodeURIComponent(selectedMedia)}?limit=50`,
      );
      setComments(result.comments);
      setSelectedComment(result.comments[0]?.id ?? '');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Comments unavailable');
    }
  }, [accountId, read, selectedMedia]);

  const loadConversations = useCallback(async () => {
    setActionError(null);
    try {
      const result = await read<{ conversations: Conversation[] }>(
        `/api/provider-accounts/${accountId}/instagram-unified-conversations?limit=25`,
      );
      setConversations(result.conversations);
      setSelectedConversation(result.conversations[0]?.id ?? '');
      setMessages([]);
      setSelectedMessage('');
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Conversations unavailable');
    }
  }, [accountId, read]);

  const loadMessages = useCallback(async () => {
    if (!selectedConversation) return;
    try {
      const result = await read<{ messages: Message[] }>(
        `/api/provider-accounts/${accountId}/instagram-unified-conversations/${encodeURIComponent(selectedConversation)}/messages?limit=50`,
      );
      setMessages(result.messages);
      setSelectedMessage(
        result.messages.find((item) => item.senderId !== null)?.id ?? result.messages[0]?.id ?? '',
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Messages unavailable');
    }
  }, [accountId, read, selectedConversation]);

  useEffect(() => {
    if (selectedMedia) void loadComments();
  }, [loadComments, selectedMedia]);
  useEffect(() => {
    if (selectedConversation) void loadMessages();
  }, [loadMessages, selectedConversation]);

  const send = async () => {
    const targetId = kind === 'comment_reply' ? selectedComment : selectedMessage;
    const parentId = kind === 'comment_reply' ? selectedMedia : selectedConversation;
    const recipientId =
      kind === 'dm_reply'
        ? messages.find((item) => item.id === selectedMessage)?.senderId
        : undefined;
    if (!targetId || !parentId || !text.trim() || (kind === 'dm_reply' && !recipientId)) return;
    setBusy(true);
    setActionState('pending');
    setActionError(null);
    try {
      const response = await fetch(
        `/api/provider-accounts/${accountId}/instagram-unified-actions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            clientActionId: crypto.randomUUID(),
            kind,
            targetId,
            parentId,
            ...(recipientId ? { recipientId } : {}),
            text: text.trim(),
          }),
        },
      );
      const result = (await response.json()) as {
        data: { state: string; receipt?: string } | null;
        error: string | null;
      };
      if (!response.ok || !result.data) throw new Error(result.error ?? 'Reply failed');
      setText('');
      setActionState(
        result.data.state === 'confirmed'
          ? 'success'
          : result.data.state === 'unknown'
            ? 'unknown'
            : 'failure',
      );
      setAnnouncement(
        result.data.state === 'confirmed' ? 'Reply sent.' : `Reply outcome: ${result.data.state}.`,
      );
    } catch (cause) {
      setActionState('failure');
      setActionError(cause instanceof Error ? cause.message : 'Reply failed');
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const loadScheduled = useCallback(async () => {
    try {
      const result = await read<{ items: ScheduledReply[] }>(
        `/api/provider-accounts/${accountId}/instagram-unified-schedules?limit=25`,
      );
      setScheduled(result.items);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Scheduled replies unavailable');
    }
  }, [accountId, read]);

  const schedule = async () => {
    const targetId = kind === 'comment_reply' ? selectedComment : selectedMessage;
    const parentId = kind === 'comment_reply' ? selectedMedia : selectedConversation;
    const recipientId = kind === 'dm_reply' ? messages.find((item) => item.id === selectedMessage)?.senderId : undefined;
    if (!targetId || !parentId || !text.trim() || !scheduleDueAt || (kind === 'dm_reply' && !recipientId)) return;
    setBusy(true); setActionError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/instagram-unified-schedules`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ clientActionId: crypto.randomUUID(), kind, targetId, parentId, ...(recipientId ? { recipientId } : {}), text: text.trim(), dueAt: new Date(scheduleDueAt).toISOString() }),
      });
      const result = (await response.json()) as { data: ScheduledReply | null; error: string | null };
      if (!response.ok || !result.data) throw new Error(result.error ?? 'Scheduling failed');
      setText(''); setScheduleDueAt(''); setAnnouncement('Reply scheduled.'); await loadScheduled();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : 'Scheduling failed'); }
    finally { setBusy(false); }
  };

  const cancelScheduled = async (id: string) => {
    const response = await fetch(`/api/provider-accounts/${accountId}/instagram-unified-schedules/${id}`, { method: 'DELETE', headers: { accept: 'application/json' } });
    if (!response.ok) { setActionError('Scheduled reply is already in flight or finished.'); return; }
    await loadScheduled(); setAnnouncement('Scheduled reply cancelled.');
  };

  const targetLabel =
    kind === 'comment_reply'
      ? (comments.find((item) => item.id === selectedComment)?.text ?? selectedComment)
      : (messages.find((item) => item.id === selectedMessage)?.senderUsername ?? selectedMessage);
  const recipientLabel =
    kind === 'comment_reply'
      ? accountName
      : (messages.find((item) => item.id === selectedMessage)?.senderUsername ??
        'conversation participant');

  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  const rows: CapabilityRow[] = [
    {
      label: 'Posts and media',
      detail: 'Read-only access to posts owned by this Unified Instagram account.',
      state: capabilityState(permissions, 'instagram_basic'),
    },
    {
      label: 'Comments and replies',
      detail: 'Read-only access to comments after the provider grant is verified.',
      state: capabilityState(permissions, 'instagram_manage_comments'),
    },
    {
      label: 'Conversations and messages',
      detail: 'Available only after a separate messaging grant is verified when used.',
      state: permissions ? 'needs_permission' : 'unknown',
    },
  ];

  return (
    <section
      className="instagram-unified-capability-control"
      aria-label="Unified Instagram capabilities"
    >
      <div className="instagram-unified-capability-heading">
        <div>
          <strong>Unified Instagram access</strong>
          <small>Live provider checks; Connected does not prove permissions.</small>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void loadPermissions()}
          disabled={loading}
        >
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="instagram-unified-capability-list">
        {rows.map((row) => (
          <div className="instagram-unified-capability-row" key={row.label}>
            <div>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </div>
            <span className={`status-badge ${row.state === 'available' ? 'success' : 'warning'}`}>
              {stateLabel(row.state)}
            </span>
          </div>
        ))}
      </div>
      <small className="instagram-unified-capability-note">
        Replies are manual, bounded, and checked against the selected account and live provider
        ancestry immediately before sending.
      </small>
      <div
        className="instagram-unified-reply-control"
        aria-label="Unified Instagram manual replies"
      >
        <div className="instagram-unified-reply-heading">
          <strong>Manual replies</strong>
          <span>Existing comments and conversations only</span>
        </div>
        <div className="instagram-unified-reply-tabs" role="tablist" aria-label="Reply type">
          <button
            type="button"
            className={`instagram-unified-reply-tab ${kind === 'comment_reply' ? 'active' : ''}`}
            aria-selected={kind === 'comment_reply'}
            role="tab"
            onClick={() => {
              setKind('comment_reply');
            }}
          >
            Comment reply
          </button>
          <button
            type="button"
            className={`instagram-unified-reply-tab ${kind === 'dm_reply' ? 'active' : ''}`}
            aria-selected={kind === 'dm_reply'}
            role="tab"
            onClick={() => {
              setKind('dm_reply');
            }}
          >
            Conversation reply
          </button>
        </div>
        {kind === 'comment_reply' ? (
          <>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void loadMedia()}
              disabled={loading}
            >
              Load recent posts
            </button>
            {media.length > 0 && (
              <label>
                Post
                <UnifiedSelect
                  label="Post"
                  value={selectedMedia}
                  options={media.map((item) => [
                    item.id,
                    item.caption || new Date(item.timestamp).toLocaleString(),
                  ])}
                  onChange={setSelectedMedia}
                />
              </label>
            )}
            {comments.length > 0 && (
              <label>
                Comment
                <UnifiedSelect
                  label="Comment"
                  value={selectedComment}
                  options={comments.map((item) => [
                    item.id,
                    `${item.username ? `${item.username}: ` : ''}${item.text}`,
                  ])}
                  onChange={setSelectedComment}
                />
              </label>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="secondary-button"
              onClick={() => void loadConversations()}
              disabled={loading}
            >
              Load conversations
            </button>
            {conversations.length > 0 && (
              <label>
                Conversation
                <UnifiedSelect
                  label="Conversation"
                  value={selectedConversation}
                  options={conversations.map((item) => [
                    item.id,
                    `${item.participants.find((participant) => participant.id !== accountId)?.username ?? 'Conversation'}${item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleString()}` : ''}`,
                  ])}
                  onChange={setSelectedConversation}
                />
              </label>
            )}
            {messages.length > 0 && (
              <label>
                Inbound message
                <UnifiedSelect
                  label="Inbound message"
                  value={selectedMessage}
                  options={messages
                    .filter((item) => item.senderId !== accountId)
                    .map((item) => [
                      item.id,
                      `${item.senderUsername ?? 'Participant'}: ${item.text}`,
                    ])}
                  onChange={setSelectedMessage}
                />
              </label>
            )}
          </>
        )}
        <label>
          Reply
          <textarea
            className="instagram-unified-reply-textarea"
            value={text}
            maxLength={2000}
            onChange={(event) => {
              setText(event.target.value);
            }}
            placeholder="Write a reply"
          />
        </label>
        {actionError && (
          <p className="field-error" role="alert">
            {actionError}
          </p>
        )}
        <button
          type="button"
          className="primary-button"
          ref={sendTrigger}
          onClick={() => {
            setConfirmOpen(true);
          }}
          disabled={
            busy || !text.trim() || (kind === 'comment_reply' ? !selectedComment : !selectedMessage)
          }
        >
          {busy ? 'Sending…' : 'Send reply'}
        </button>
        {actionState !== 'idle' && (
          <small
            className={actionState === 'failure' ? 'field-error' : 'instagram-unified-action-state'}
            role="status"
          >
            {actionState === 'pending' && 'Reply is pending provider confirmation.'}
            {actionState === 'success' && 'Reply confirmed by the provider.'}
            {actionState === 'failure' && 'Reply was rejected; it was not retried automatically.'}
            {actionState === 'unknown' && 'Reply outcome is unknown; do not resend automatically.'}
          </small>
        )}
        <label>
          Schedule for
          <input type="datetime-local" value={scheduleDueAt} onChange={(event) => setScheduleDueAt(event.target.value)} />
        </label>
        <button type="button" className="secondary-button" onClick={() => void schedule()} disabled={busy || !scheduleDueAt || !text.trim()}>
          {busy ? 'Scheduling…' : 'Schedule reply'}
        </button>
        <button type="button" className="secondary-button" onClick={() => void loadScheduled()} disabled={busy}>Refresh scheduled replies</button>
        {scheduled.length > 0 && <div aria-label="Scheduled Unified Instagram replies">
          {scheduled.map((item) => <div key={item.id} className="instagram-unified-action-state">
            <span>{new Date(item.dueAt).toLocaleString()} · {item.status} · {item.text}</span>
            {item.status === 'pending' && <button type="button" className="secondary-button" onClick={() => void cancelScheduled(item.id)}>Cancel</button>}
          </div>)}
        </div>}
      </div>
      {confirmOpen && (
        <ConfirmationDialog
          titleId="instagram-unified-reply-confirmation"
          title={kind === 'comment_reply' ? 'Confirm comment reply' : 'Confirm conversation reply'}
          description={
            <>
              Send to <strong>{recipientLabel}</strong> for <strong>{targetLabel}</strong>:
              <br />“{text.trim()}”
            </>
          }
          cancelLabel="Cancel"
          confirmLabel={busy ? 'Sending…' : 'Confirm and send'}
          confirmTone="primary"
          disabled={busy}
          returnFocusTo={sendTrigger.current}
          onCancel={() => {
            setConfirmOpen(false);
          }}
          onConfirm={() => void send()}
        />
      )}
      <LiveRegion message={announcement} />
    </section>
  );
}

function UnifiedSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(([option]) => option === value)?.[1] ?? 'Select';
  return (
    <div className="filter-select">
      <button
        type="button"
        className="filter-button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {selected} <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="filter-select-menu" role="listbox" aria-label={label}>
          {options.map((entry) => {
            const [option, text] = entry;
            if (!option || !text) return null;
            return (
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                className={`instagram-unified-reply-option ${option === value ? 'selected' : ''}`}
                key={option}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
              >
                {text}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
