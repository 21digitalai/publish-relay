import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from './confirmation-dialog.js';
import { getCsrfToken } from './posting-adapter-connection.js';
import { WorkspaceLayout } from './workflow.js';

interface ProposalSummary {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  sourcePreview: string;
  contentPreview: string;
  createdAt: string;
}

interface ProposalDetail {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  sourceContext: { text?: string; authorLabel?: string };
  content: { text: string; mediaIds?: string[]; priceCents?: number };
  revision: number;
  status: string;
}

async function readApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as { data: T | null; error: string | null };
  if (!response.ok || !body.data) throw new Error(body.error ?? 'Proposal request failed');
  return body.data;
}

function proposalLabel(proposal: { provider: string; kind: 'dm' | 'comment' }): string {
  const provider =
    proposal.provider === 'fanvue'
      ? 'Fanvue'
      : proposal.provider === 'facebook_page'
        ? 'Facebook Page'
        : proposal.provider;
  return `${provider} ${proposal.kind === 'dm' ? 'message' : 'comment'}`;
}

export function EngagementProposalsPage() {
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissTrigger = useRef<HTMLButtonElement>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const page = await readApi<{ items: ProposalSummary[]; nextCursor: string | null }>(
      `/api/engagement-proposals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    let active = true;
    void readApi<{ items: ProposalSummary[]; nextCursor: string | null }>(
      '/api/engagement-proposals',
    )
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((failure: unknown) => {
        if (active) {
          setListFailed(true);
          setError(failure instanceof Error ? failure.message : 'Could not load proposals');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetail(null);
    setDetailFailed(false);
    setError(null);
    void readApi<ProposalDetail>(`/api/engagement-proposals/${selectedId}`)
      .then((proposal) => {
        if (!active) return;
        setDetail(proposal);
        setDraft(proposal.content.text);
      })
      .catch((failure: unknown) => {
        if (active) {
          setDetailFailed(true);
          setError(failure instanceof Error ? failure.message : 'Could not load proposal');
        }
      });
    return () => {
      active = false;
    };
  }, [selectedId, detailReload]);

  const mutate = async (action: 'edit' | 'dismiss') => {
    if (!detail || saving) return;
    if (action === 'edit' && (!draft.trim() || draft.length > 5000)) {
      setError('Reply must contain 1–5,000 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await readApi<ProposalDetail>(
        `/api/engagement-proposals/${detail.id}${action === 'dismiss' ? '/dismiss' : ''}`,
        {
          method: action === 'dismiss' ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify(
            action === 'dismiss'
              ? { expectedRevision: detail.revision }
              : {
                  expectedRevision: detail.revision,
                  content: { ...detail.content, text: draft.trim() },
                },
          ),
        },
      );
      if (action === 'dismiss') {
        setItems((current) => current.filter((item) => item.id !== detail.id));
        setSelectedId(null);
        setDetail(null);
        setNotice('Proposal dismissed. No message was sent.');
      } else {
        setDetail({ ...updated, accountDisplayName: detail.accountDisplayName });
        setDraft(updated.content.text);
        setItems((current) =>
          current.map((item) =>
            item.id === detail.id
              ? { ...item, contentPreview: updated.content.text.slice(0, 280) }
              : item,
          ),
        );
        setNotice('Draft saved. No message was sent.');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Proposal could not be updated');
    } finally {
      setSaving(false);
      setConfirmDismiss(false);
    }
  };

  return (
    <WorkspaceLayout active="proposals">
      <section className="engagement-proposals-page" aria-labelledby="engagement-proposals-title">
        <header className="page-header">
          <div>
            <p className="eyebrow">Engagement</p>
            <h1 id="engagement-proposals-title">Proposed replies</h1>
            <p className="muted">
              Review and edit agent suggestions. Sending is not available yet.
            </p>
          </div>
        </header>
        {notice && (
          <p className="form-success" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="engagement-proposals-layout">
          <section className="engagement-proposals-list" aria-label="Pending proposals">
            {loading ? (
              <p role="status">Loading proposed replies…</p>
            ) : listFailed ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setLoading(true);
                  setError(null);
                  void loadPage()
                    .then(() => {
                      setListFailed(false);
                    })
                    .catch((failure: unknown) => {
                      setError(
                        failure instanceof Error ? failure.message : 'Could not load proposals',
                      );
                    })
                    .finally(() => {
                      setLoading(false);
                    });
                }}
              >
                Retry loading proposals
              </button>
            ) : items.length === 0 ? (
              <p>No replies await review.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  className={`engagement-proposal-row ${selectedId === item.id ? 'selected' : ''}`}
                  type="button"
                  aria-pressed={selectedId === item.id}
                  onClick={() => {
                    setSelectedId(item.id);
                  }}
                >
                  <strong>{proposalLabel(item)}</strong>
                  <span>{item.accountDisplayName}</span>
                  <span>{item.contentPreview}</span>
                  <small>{new Date(item.createdAt).toLocaleString()}</small>
                </button>
              ))
            )}
            {nextCursor && (
              <button
                className="secondary-button engagement-proposals-more"
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  setError(null);
                  void loadPage(nextCursor)
                    .catch((failure: unknown) => {
                      setError(
                        failure instanceof Error
                          ? failure.message
                          : 'More proposals could not be loaded',
                      );
                    })
                    .finally(() => {
                      setLoadingMore(false);
                    });
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </section>
          <section className="engagement-proposal-detail" aria-label="Proposal detail">
            {!selectedId ? (
              <p>Select a proposal to inspect its context and draft.</p>
            ) : detailFailed ? (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setDetailReload((current) => current + 1);
                }}
              >
                Retry loading proposal
              </button>
            ) : !detail ? (
              <p role="status">Loading proposal…</p>
            ) : (
              <>
                <h2>{proposalLabel(detail)}</h2>
                <p className="muted">Destination: {detail.accountDisplayName}</p>
                <p className="muted">
                  Agent-provided source context; verify it before sending elsewhere.
                </p>
                <blockquote className="engagement-proposal-source">
                  {detail.sourceContext.authorLabel && (
                    <strong>{detail.sourceContext.authorLabel}: </strong>
                  )}
                  {detail.sourceContext.text ?? 'No source text was supplied.'}
                </blockquote>
                <label className="field-label" htmlFor="engagement-proposal-draft">
                  Suggested reply
                </label>
                <textarea
                  id="engagement-proposal-draft"
                  className="engagement-proposal-draft text-input"
                  value={draft}
                  maxLength={5000}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                />
                {detail.content.mediaIds?.length ? (
                  <p className="muted">
                    {detail.content.mediaIds.length} media attachment(s) proposed; preview and
                    sending remain unavailable.
                  </p>
                ) : null}
                {detail.content.priceCents !== undefined && (
                  <p className="muted">
                    Proposed provider price: ${(detail.content.priceCents / 100).toFixed(2)}.
                    Sending remains unavailable.
                  </p>
                )}
                <div className="engagement-proposal-actions">
                  <button
                    className="secondary-button engagement-proposal-save"
                    type="button"
                    disabled={saving || !draft.trim() || draft.trim() === detail.content.text}
                    onClick={() => {
                      void mutate('edit');
                    }}
                  >
                    {saving ? 'Saving…' : 'Save draft'}
                  </button>
                  <button
                    ref={dismissTrigger}
                    className="danger-button engagement-proposal-dismiss"
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setConfirmDismiss(true);
                    }}
                  >
                    Dismiss proposal
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      </section>
      {confirmDismiss && (
        <ConfirmationDialog
          titleId="engagement-dismiss-title"
          title="Dismiss this proposal?"
          description="The proposed reply will leave this review queue. Nothing will be sent."
          cancelLabel="Keep proposal"
          confirmLabel={saving ? 'Dismissing…' : 'Dismiss proposal'}
          confirmTone="danger"
          disabled={saving}
          returnFocusTo={dismissTrigger.current}
          onCancel={() => {
            setConfirmDismiss(false);
          }}
          onConfirm={() => {
            void mutate('dismiss');
          }}
        />
      )}
    </WorkspaceLayout>
  );
}
