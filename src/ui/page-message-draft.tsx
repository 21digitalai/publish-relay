import { useEffect, useRef, useState } from 'react';

import { getCsrfToken } from './posting-adapter-connection.js';
import {
  DRAFT_DELAY_MS,
  latestDraftMessage,
  type PageMessage,
} from './page-message-draft-context.js';

interface PageAccount {
  id: string;
  destinationProvider: string;
  displayName: string;
}
interface Conversation {
  id: string;
  displayName: string | null;
  noGo: boolean;
  terminal: boolean;
}
interface MessagePage {
  participantId: string;
  displayName: string | null;
  messages: PageMessage[];
}
interface DraftInput {
  accountId: string;
  clientActionId: string;
  provider: 'facebook_page';
  kind: 'dm';
  targetId: string;
  plannedDueAt: string;
  sourceContext: { text: string; authorLabel: string; sourceMessageId: string };
  content: { text: string };
}
async function read<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const body = (await response.json()) as { data: T; error: string | null };
  if (!response.ok || !body.data) throw new Error(body.error ?? 'Could not load Facebook messages');
  return body.data;
}

export function PageMessageDraft({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [accounts, setAccounts] = useState<PageAccount[]>([]);
  const [accountCursor, setAccountCursor] = useState<string | null>(null);
  const [account, setAccount] = useState<PageAccount | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<MessagePage | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const busyRef = useRef(false);
  const generation = useRef(0);
  const attempt = useRef<DraftInput | null>(null);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, []);

  const run = (action: (current: () => boolean) => Promise<void>) => {
    if (busyRef.current) return;
    const requested = ++generation.current;
    const current = () => requested === generation.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    void action(current)
      .catch((failure: unknown) => {
        if (current()) setError(failure instanceof Error ? failure.message : 'Request failed');
      })
      .finally(() => {
        if (current()) {
          busyRef.current = false;
          setBusy(false);
        }
      });
  };
  const resetMessage = () => {
    setConversation(null);
    setMessages(null);
    setDraft('');
    attempt.current = null;
    setUncertain(false);
  };
  const loadAccounts = (cursor?: string) => {
    run(async (current) => {
      const page = await read<{ accounts: PageAccount[]; nextCursor: string | null }>(
        `/api/provider-accounts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (!current()) return;
      const pages = page.accounts.filter((item) => item.destinationProvider === 'facebook_page');
      setAccounts((previous) => (cursor ? [...previous, ...pages] : pages));
      setAccountCursor(page.nextCursor);
    });
  };
  const loadConversations = (selected: PageAccount, cursor?: string) => {
    if (!cursor) {
      setAccount(selected);
      resetMessage();
      setConversations([]);
      setConversationCursor(null);
    }
    run(async (current) => {
      const page = await read<{ conversations: Conversation[]; nextCursor: string | null }>(
        `/api/provider-accounts/${selected.id}/facebook-conversations?limit=25&filter=eligible${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (!current()) return;
      setConversations((previous) =>
        cursor ? [...previous, ...page.conversations] : page.conversations,
      );
      setConversationCursor(page.nextCursor);
    });
  };
  const loadMessages = (selected: Conversation) => {
    if (!account) return;
    resetMessage();
    setConversation(selected);
    run(async (current) => {
      const page = await read<MessagePage>(
        `/api/provider-accounts/${account.id}/facebook-conversations/${encodeURIComponent(selected.id)}/messages?limit=25`,
      );
      if (current()) {
        setMessages(page);
        setNow(Date.now());
      }
    });
  };
  const source = messages
    ? latestDraftMessage(messages.messages, messages.participantId, now)
    : null;

  const save = () => {
    run(async (current) => {
      if (!account || !conversation || !source || !draft.trim()) return;
      if (!attempt.current) {
        // Re-read before creating a draft. The canonical approval/send path independently checks again.
        const fresh = await read<MessagePage>(
          `/api/provider-accounts/${account.id}/facebook-conversations/${encodeURIComponent(conversation.id)}/messages?limit=25`,
        );
        if (!current()) return;
        const latest = latestDraftMessage(fresh.messages, fresh.participantId, Date.now());
        if (latest?.id !== source.id) {
          setMessages(fresh);
          setNow(Date.now());
          throw new Error(
            'The incoming message changed or its reply window closed. Review the refreshed context before saving.',
          );
        }
        attempt.current = {
          accountId: account.id,
          clientActionId: crypto.randomUUID(),
          provider: 'facebook_page',
          kind: 'dm',
          targetId: conversation.id,
          plannedDueAt: new Date(Date.now() + DRAFT_DELAY_MS).toISOString(),
          sourceContext: {
            text: latest.text,
            authorLabel: fresh.displayName ?? 'Facebook customer',
            sourceMessageId: latest.id,
          },
          content: { text: draft.trim() },
        };
      }
      setUncertain(true);
      const response = await fetch('/api/engagement-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify(attempt.current),
      });
      const body = (await response.json()) as { data: { id: string } | null; error: string | null };
      if ([400, 401, 403, 404, 409, 422, 429].includes(response.status)) {
        setUncertain(false);
        attempt.current = null;
      }
      if (!response.ok || !body.data)
        throw new Error(body.error ?? 'Draft save could not be confirmed');
      if (!current()) return;
      setUncertain(false);
      attempt.current = null;
      setOpen(false);
      resetMessage();
      onCreated(body.data.id);
    });
  };

  return (
    <section className="page-message-draft" aria-label="Create a Messenger reply draft">
      <button
        className="page-message-draft-toggle secondary-button"
        type="button"
        disabled={busy}
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setOpen(true);
            loadAccounts();
          } else setOpen(false);
        }}
      >
        {open ? 'Close message picker' : 'New Messenger reply'}
      </button>
      {open && (
        <div className="page-message-draft-panel">
          <h2>Reply to a fresh Page message</h2>
          <p className="muted">
            Select a Page and conversation, then write a draft. Saving never sends a message. Review
            and approve it separately within five minutes. If the draft expires, create a fresh one.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {busy && (
            <p className="muted" role="status">
              Loading or saving…
            </p>
          )}
          <div
            className="page-message-draft-accounts"
            role="group"
            aria-label="Choose Facebook Page"
          >
            {accounts.map((item) => (
              <button
                className="page-message-draft-account secondary-button"
                type="button"
                key={item.id}
                disabled={busy || uncertain}
                aria-pressed={account?.id === item.id}
                onClick={() => {
                  loadConversations(item);
                }}
              >
                {item.displayName}
              </button>
            ))}
            {!busy && accounts.length === 0 && (
              <p>
                No Facebook Pages in this account page. Connect a Page in Accounts or load more
                accounts.
              </p>
            )}
            {accountCursor && (
              <button
                className="secondary-button"
                type="button"
                disabled={busy || uncertain}
                onClick={() => {
                  loadAccounts(accountCursor);
                }}
              >
                Load more accounts
              </button>
            )}
          </div>
          {account && (
            <div className="page-message-draft-conversations">
              <h3>Conversations for {account.displayName}</h3>
              <button
                className="secondary-button"
                type="button"
                disabled={busy || uncertain}
                onClick={() => {
                  loadConversations(account);
                }}
              >
                Refresh conversations
              </button>
              <div className="page-message-draft-conversation-list">
                {conversations.map((item) => (
                  <button
                    className="page-message-draft-conversation secondary-button"
                    type="button"
                    key={item.id}
                    disabled={busy || uncertain || item.noGo || item.terminal}
                    aria-pressed={conversation?.id === item.id}
                    onClick={() => {
                      loadMessages(item);
                    }}
                  >
                    {item.displayName ?? 'Facebook customer'}
                  </button>
                ))}
              </div>
              {!busy && conversations.length === 0 && (
                <p>
                  No eligible conversations on this page. Send a message to the Page from the tester
                  account, then refresh.
                </p>
              )}
              {conversationCursor && (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy || uncertain}
                  onClick={() => {
                    loadConversations(account, conversationCursor);
                  }}
                >
                  Load more conversations
                </button>
              )}
            </div>
          )}
          {conversation && messages && (
            <div className="page-message-draft-editor">
              <h3>Incoming message from {messages.displayName ?? 'Facebook customer'}</h3>
              {source ? (
                <blockquote className="page-message-draft-source">
                  {source.text}
                  <small>{new Date(source.createdAt).toLocaleString()}</small>
                </blockquote>
              ) : (
                <p role="status">
                  No recent, unambiguous incoming text message is available to draft against. Ask
                  the tester to send a fresh text message, then refresh.
                </p>
              )}
              <button
                className="secondary-button"
                type="button"
                disabled={busy || uncertain}
                onClick={() => {
                  loadMessages(conversation);
                }}
              >
                Refresh messages
              </button>
              <label className="page-message-draft-label" htmlFor="page-message-reply">
                Your reply draft
              </label>
              <textarea
                className="page-message-draft-input text-input"
                id="page-message-reply"
                value={draft}
                maxLength={2000}
                rows={4}
                disabled={busy || uncertain || !source}
                onChange={(event) => {
                  setDraft(event.target.value);
                  attempt.current = null;
                }}
              />
              <p className="muted">
                {draft.length}/2000 characters. Nothing sends until you approve it in Proposed
                replies.
              </p>
              {uncertain && (
                <p className="form-error" role="status">
                  Save not yet confirmed. Retry the same draft; do not create another copy. If the
                  draft has expired, refresh Proposed replies to check whether it was saved.
                </p>
              )}
              <button
                className="page-message-draft-save primary-button"
                type="button"
                disabled={busy || !source || !draft.trim()}
                onClick={save}
              >
                {uncertain ? 'Retry same draft' : 'Save reply draft'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
