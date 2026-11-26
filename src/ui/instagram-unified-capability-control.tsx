import { useCallback, useEffect, useState } from 'react';

import { LiveRegion } from './feedback.js';

type GrantState = 'granted' | 'missing' | 'declined';
type PermissionState = Record<'instagram_basic' | 'instagram_manage_comments', GrantState>;
type CapabilityStatus = 'available' | 'needs_permission' | 'declined' | 'unknown';
type ActionKind = 'comment_reply' | 'dm_reply';

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
      setAnnouncement(
        result.data.state === 'confirmed' ? 'Reply sent.' : `Reply outcome: ${result.data.state}.`,
      );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Reply failed');
    } finally {
      setBusy(false);
    }
  };

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
            className={kind === 'comment_reply' ? 'active' : ''}
            onClick={() => {
              setKind('comment_reply');
            }}
          >
            Comment reply
          </button>
          <button
            type="button"
            className={kind === 'dm_reply' ? 'active' : ''}
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
                <select
                  value={selectedMedia}
                  onChange={(event) => {
                    setSelectedMedia(event.target.value);
                  }}
                >
                  {media.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.caption || new Date(item.timestamp).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {comments.length > 0 && (
              <label>
                Comment
                <select
                  value={selectedComment}
                  onChange={(event) => {
                    setSelectedComment(event.target.value);
                  }}
                >
                  {comments.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.username ? `${item.username}: ` : ''}
                      {item.text}
                    </option>
                  ))}
                </select>
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
                <select
                  value={selectedConversation}
                  onChange={(event) => {
                    setSelectedConversation(event.target.value);
                  }}
                >
                  {conversations.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.participants.find((participant) => participant.id !== accountId)
                        ?.username ?? 'Conversation'}
                      {item.updatedAt ? ` · ${new Date(item.updatedAt).toLocaleString()}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {messages.length > 0 && (
              <label>
                Inbound message
                <select
                  value={selectedMessage}
                  onChange={(event) => {
                    setSelectedMessage(event.target.value);
                  }}
                >
                  {messages
                    .filter((item) => item.senderId !== accountId)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.senderUsername ?? 'Participant'}: {item.text}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </>
        )}
        <label>
          Reply
          <textarea
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
          onClick={() => void send()}
          disabled={
            busy || !text.trim() || (kind === 'comment_reply' ? !selectedComment : !selectedMessage)
          }
        >
          {busy ? 'Sending…' : 'Send reply'}
        </button>
      </div>
      <LiveRegion message={announcement} />
    </section>
  );
}
