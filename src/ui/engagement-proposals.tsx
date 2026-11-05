import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from './confirmation-dialog.js';
import { getCsrfToken } from './posting-adapter-connection.js';
import { WorkspaceLayout } from './workflow.js';

interface ProposalSummary {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  status: string;
  sourcePreview: string;
  contentPreview: string;
  createdAt: string;
}

interface ProposalDetail {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  targetId: string;
  sourceContext: { text?: string; authorLabel?: string; postId?: string; sourceMessageId?: string };
  content: { text: string; mediaIds?: string[]; priceCents?: number };
  revision: number;
  status: string;
  canApprove: boolean;
  noGo: boolean;
}

interface NoGoEntry {
  accountId: string;
  conversationId: string;
  displayName: string | null;
  accountDisplayName: string;
  createdAt: string;
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
  const [noGoEntries, setNoGoEntries] = useState<NoGoEntry[]>([]);
  const [canManageNoGo, setCanManageNoGo] = useState(false);
  const [noGoFailed, setNoGoFailed] = useState(false);
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
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [confirmNoGo, setConfirmNoGo] = useState(false);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [mediaStates, setMediaStates] = useState<Record<string, string>>({});
  const [mediaPending, setMediaPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissTrigger = useRef<HTMLButtonElement>(null);
  const approveTrigger = useRef<HTMLButtonElement>(null);
  const noGoTrigger = useRef<HTMLButtonElement>(null);
  const activeProposalRef = useRef<string | null>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const page = await readApi<{ items: ProposalSummary[]; nextCursor: string | null }>(
      `/api/engagement-proposals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
  }, []);

  const loadNoGo = useCallback(async () => {
    const result = await readApi<{ items: NoGoEntry[]; canManage: boolean }>(
      '/api/facebook-page-dm-no-go',
    );
    setNoGoEntries(result.items);
    setCanManageNoGo(result.canManage);
    setNoGoFailed(false);
  }, []);

  useEffect(() => {
    void loadNoGo().catch(() => {
      setNoGoFailed(true);
    });
  }, [loadNoGo]);

  const changeNoGo = async () => {
    if (!detail) return;
    const blocked = !detail.noGo;
    setSaving(true);
    setError(null);
    try {
      await readApi<{ noGo: boolean }>(`/api/engagement-proposals/${detail.id}/no-go`, {
        method: blocked ? 'POST' : 'DELETE',
        headers: { 'x-csrf-token': getCsrfToken() },
      });
      setNotice(
        blocked
          ? 'Conversation added to the no-go list. Pending replies were dismissed.'
          : 'Conversation removed from the no-go list.',
      );
      setDetailReload((current) => current + 1);
      await loadPage();
      await loadNoGo();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update the no-go list');
    } finally {
      setSaving(false);
      setConfirmNoGo(false);
    }
  };

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
      activeProposalRef.current = null;
      setDetail(null);
      return;
    }
    let active = true;
    activeProposalRef.current = null;
    setDetail(null);
    setMediaStates({});
    setDetailFailed(false);
    setError(null);
    void readApi<ProposalDetail>(`/api/engagement-proposals/${selectedId}`)
      .then((proposal) => {
        if (!active) return;
        setDetail(proposal);
        activeProposalRef.current = `${proposal.id}:${String(proposal.revision)}`;
        setDraft(proposal.content.text);
        setSendUncertain(false);
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
        activeProposalRef.current = `${updated.id}:${String(updated.revision)}`;
        setDetail({
          ...updated,
          accountDisplayName: detail.accountDisplayName,
          canApprove: detail.canApprove,
        });
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

  const approve = async () => {
    if (!detail || saving || sendUncertain) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await readApi<{ id: string; status: string }>(
        `/api/engagement-proposals/${detail.id}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({ expectedRevision: detail.revision }),
        },
      );
      setDetail({ ...detail, status: outcome.status });
      setItems((current) =>
        outcome.status === 'sent'
          ? current.filter((item) => item.id !== detail.id)
          : current.map((item) =>
              item.id === detail.id ? { ...item, status: outcome.status } : item,
            ),
      );
      setNotice(
        outcome.status === 'sent'
          ? `Reply sent through ${detail.provider === 'facebook_page' ? 'Facebook Page' : 'Fanvue'}.`
          : outcome.status === 'failed'
            ? 'The provider rejected the send. No reply was sent.'
            : 'Send outcome is unknown. Do not submit this reply again until it is reconciled.',
      );
    } catch (failure) {
      setSendUncertain(true);
      setError(
        failure instanceof Error
          ? `${failure.message}. Refresh this proposal before taking another action; the send outcome may be unknown.`
          : 'Send outcome may be unknown. Refresh this proposal before taking another action.',
      );
    } finally {
      setSaving(false);
      setConfirmApprove(false);
    }
  };

  const stageMedia = async (mediaId: string) => {
    if (!detail || mediaPending) return;
    const proposalKey = `${detail.id}:${String(detail.revision)}`;
    setMediaPending(mediaId);
    setError(null);
    try {
      const result = await readApi<{ state: string }>(
        `/api/engagement-proposals/${detail.id}/media/${mediaId}/stage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({ expectedRevision: detail.revision }),
        },
      );
      if (activeProposalRef.current === proposalKey)
        setMediaStates((current) => ({ ...current, [mediaId]: result.state }));
    } catch (failure) {
      if (activeProposalRef.current === proposalKey) {
        setMediaStates((current) => ({ ...current, [mediaId]: 'unknown' }));
        setError(
          failure instanceof Error
            ? `${failure.message}. Attachment outcome may be unknown; refresh the proposal before another attempt.`
            : 'Attachment outcome may be unknown; refresh the proposal before another attempt.',
        );
      }
    } finally {
      setMediaPending(null);
    }
  };

  const mediaReady =
    !detail?.content.mediaIds?.length ||
    detail.content.mediaIds.every((mediaId) => mediaStates[mediaId] === 'ready');
  const priceValid =
    detail?.content.priceCents === undefined ||
    detail.content.priceCents === 0 ||
    detail.content.priceCents >= 300;
  const priceHasMedia = !detail?.content.priceCents || Boolean(detail.content.mediaIds?.length);
  const facebookReady =
    detail?.provider === 'facebook_page' &&
    !detail.content.mediaIds?.length &&
    detail.content.priceCents === undefined &&
    detail.content.text.length <= 2000 &&
    (detail.kind === 'dm'
      ? /^[A-Za-z0-9_]+$/.test(detail.targetId)
      : /^[0-9]+(?:_[0-9]+)*$/.test(detail.targetId) && Boolean(detail.sourceContext.postId));
  const fanvueReady =
    detail?.provider === 'fanvue' &&
    document.body.dataset.fanvueEnabled === 'true' &&
    (detail.kind === 'dm' ||
      (!detail.content.mediaIds?.length && detail.content.priceCents === undefined)) &&
    mediaReady &&
    priceValid &&
    priceHasMedia &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(detail.targetId) &&
    detail.content.text.length <= (detail.kind === 'comment' ? 600 : 5000);

  const canApprove =
    detail?.status === 'pending' &&
    selectedId === detail.id &&
    activeProposalRef.current === `${detail.id}:${String(detail.revision)}` &&
    detail.canApprove &&
    !detail.noGo &&
    (facebookReady || fanvueReady) &&
    draft.trim() === detail.content.text &&
    !sendUncertain;

  return (
    <WorkspaceLayout active="proposals">
      <section className="engagement-proposals-page" aria-labelledby="engagement-proposals-title">
        <header className="page-header">
          <div>
            <p className="eyebrow">Engagement</p>
            <h1 id="engagement-proposals-title">Proposed replies</h1>
            <p className="muted">
              Review Fanvue and Facebook Page suggestions and unresolved sends. Supported replies
              can be approved; other proposals remain drafts.
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
          <section
            className="engagement-proposals-list"
            aria-label="Review proposals and unresolved sends"
          >
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
              <p>No replies await review or reconciliation.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  className={`engagement-proposal-row ${selectedId === item.id ? 'selected' : ''}`}
                  type="button"
                  aria-pressed={selectedId === item.id}
                  onClick={() => {
                    if (selectedId !== item.id) activeProposalRef.current = null;
                    setSelectedId(item.id);
                  }}
                >
                  <strong>{proposalLabel(item)}</strong>
                  {item.status !== 'pending' && (
                    <span>
                      {item.status === 'unknown' || item.status === 'sending'
                        ? 'Send outcome unknown'
                        : 'Provider rejected send'}
                    </span>
                  )}
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
                {detail.provider === 'facebook_page' && detail.kind === 'dm' && (
                  <p className={detail.noGo ? 'form-error' : 'muted'} role="status">
                    {detail.noGo
                      ? 'No-go conversation: new proposals and sends are blocked.'
                      : 'This conversation is not on the no-go list.'}
                  </p>
                )}
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
                  <section className="engagement-proposal-media" aria-label="Proposed attachments">
                    <h3>Attachments</h3>
                    {detail.content.mediaIds.map((mediaId, index) => (
                      <div className="engagement-proposal-attachment" key={mediaId}>
                        <a
                          className="engagement-proposal-media-preview"
                          href={`/api/workflow/media/${mediaId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Preview attachment {index + 1}
                        </a>
                        <span className="engagement-proposal-media-status" role="status">
                          {mediaStates[mediaId] === 'ready'
                            ? 'Ready to send'
                            : mediaStates[mediaId] === 'unknown'
                              ? 'Outcome unknown; do not retry'
                              : mediaStates[mediaId] === 'failed'
                                ? 'Provider preparation failed'
                                : mediaStates[mediaId] === 'processing'
                                  ? 'Processing at Fanvue'
                                  : mediaStates[mediaId] === 'uploading'
                                    ? 'More preparation needed'
                                    : 'Not prepared for sending'}
                        </span>
                        {detail.status === 'pending' &&
                          detail.provider === 'fanvue' &&
                          detail.kind === 'dm' &&
                          mediaStates[mediaId] !== 'ready' &&
                          mediaStates[mediaId] !== 'unknown' &&
                          mediaStates[mediaId] !== 'failed' && (
                            <button
                              className="engagement-proposal-stage-media secondary-button"
                              type="button"
                              disabled={Boolean(mediaPending) || saving || !detail.canApprove}
                              onClick={() => {
                                void stageMedia(mediaId);
                              }}
                            >
                              {mediaPending === mediaId ? 'Preparing…' : 'Prepare attachment'}
                            </button>
                          )}
                      </div>
                    ))}
                  </section>
                ) : null}
                {detail.content.priceCents !== undefined && (
                  <p className="muted">
                    Proposed provider price: ${(detail.content.priceCents / 100).toFixed(2)}.
                    {detail.content.priceCents > 0 && detail.content.priceCents < 300
                      ? ' Fanvue requires a minimum price of $3.00.'
                      : ''}
                  </p>
                )}
                {detail.status !== 'pending' && (
                  <p className="form-success" role="status">
                    {detail.status === 'sent'
                      ? 'Sent'
                      : detail.status === 'dismissed'
                        ? 'Dismissed without sending'
                        : detail.status === 'failed'
                          ? 'Provider rejected this send'
                          : 'Send outcome is unknown; do not send again'}
                  </p>
                )}
                <div className="engagement-proposal-actions">
                  {detail.status === 'pending' && (
                    <button
                      ref={approveTrigger}
                      className="primary-button engagement-proposal-approve"
                      type="button"
                      disabled={saving || !canApprove}
                      onClick={() => {
                        setConfirmApprove(true);
                      }}
                    >
                      Approve and send
                    </button>
                  )}
                  <button
                    className="secondary-button engagement-proposal-save"
                    type="button"
                    disabled={
                      saving ||
                      detail.status !== 'pending' ||
                      !draft.trim() ||
                      draft.trim() === detail.content.text
                    }
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
                    disabled={saving || detail.status !== 'pending' || sendUncertain}
                    onClick={() => {
                      setConfirmDismiss(true);
                    }}
                  >
                    Dismiss proposal
                  </button>
                  {detail.provider === 'facebook_page' &&
                    detail.kind === 'dm' &&
                    detail.canApprove && (
                      <button
                        ref={noGoTrigger}
                        className={
                          detail.noGo
                            ? 'secondary-button engagement-proposal-no-go'
                            : 'danger-button engagement-proposal-no-go'
                        }
                        type="button"
                        disabled={saving || sendUncertain}
                        onClick={() => {
                          setConfirmNoGo(true);
                        }}
                      >
                        {detail.noGo ? 'Remove from no-go list' : 'Do not message this person'}
                      </button>
                    )}
                </div>
                {detail.status === 'pending' && !canApprove && (
                  <p className="muted">
                    {sendUncertain
                      ? 'Refresh to verify the latest send state before continuing.'
                      : !detail.canApprove
                        ? 'Only a workspace owner or admin can approve and send.'
                        : draft.trim() !== detail.content.text
                          ? 'Save the edited draft before approving.'
                          : !mediaReady
                            ? 'Prepare every attachment and confirm it is ready before approving.'
                            : 'Sending is not available for this provider or proposal shape.'}
                  </p>
                )}
                {sendUncertain && (
                  <button
                    className="secondary-button engagement-proposal-refresh"
                    type="button"
                    onClick={() => {
                      setDetailReload((current) => current + 1);
                    }}
                  >
                    Refresh proposal state
                  </button>
                )}
              </>
            )}
          </section>
        </div>
        <section className="engagement-no-go-list" aria-labelledby="engagement-no-go-title">
          <h2 id="engagement-no-go-title">Page DM no-go list</h2>
          {noGoFailed ? (
            <button
              className="secondary-button engagement-no-go-retry"
              type="button"
              onClick={() => {
                void loadNoGo().catch(() => {
                  setNoGoFailed(true);
                });
              }}
            >
              Retry loading no-go list
            </button>
          ) : noGoEntries.length === 0 ? (
            <p className="muted">No Page conversations are blocked.</p>
          ) : (
            <ul className="engagement-no-go-entries">
              {noGoEntries.map((entry) => (
                <li
                  className="engagement-no-go-entry"
                  key={`${entry.accountId}:${entry.conversationId}`}
                >
                  <span>
                    {entry.displayName ?? 'Page conversation'} · {entry.accountDisplayName}
                  </span>
                  <small>Blocked {new Date(entry.createdAt).toLocaleString()}</small>
                  {canManageNoGo && (
                    <button
                      className="secondary-button engagement-no-go-remove"
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setSaving(true);
                        setError(null);
                        void readApi<{ noGo: boolean }>(
                          `/api/facebook-page-dm-no-go/${encodeURIComponent(entry.accountId)}/${encodeURIComponent(entry.conversationId)}`,
                          {
                            method: 'DELETE',
                            headers: { 'x-csrf-token': getCsrfToken() },
                          },
                        )
                          .then(async () => {
                            setNotice('Conversation removed from the no-go list.');
                            await loadNoGo();
                            setDetailReload((current) => current + 1);
                          })
                          .catch((failure: unknown) => {
                            setError(
                              failure instanceof Error ? failure.message : 'Could not remove block',
                            );
                          })
                          .finally(() => {
                            setSaving(false);
                          });
                      }}
                    >
                      Allow messages
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
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
      {confirmNoGo && detail && (
        <ConfirmationDialog
          titleId="engagement-no-go-title"
          title={
            detail.noGo ? 'Allow messages to this person again?' : 'Stop messaging this person?'
          }
          description={
            detail.noGo
              ? 'New proposals and sends will be allowed again. Dismissed replies stay dismissed.'
              : 'New proposals and sends to this Page conversation will be blocked. Pending replies will be dismissed.'
          }
          cancelLabel="Cancel"
          confirmLabel={saving ? 'Updating…' : detail.noGo ? 'Remove block' : 'Block and dismiss'}
          confirmTone={detail.noGo ? 'primary' : 'danger'}
          disabled={saving}
          returnFocusTo={noGoTrigger.current}
          onCancel={() => {
            setConfirmNoGo(false);
          }}
          onConfirm={() => {
            void changeNoGo();
          }}
        />
      )}
      {confirmApprove && detail && (
        <ConfirmationDialog
          titleId="engagement-approve-title"
          title="Approve and send this reply?"
          description={`Send the reviewed ${proposalLabel(detail)} to ${detail.accountDisplayName} now${detail.content.priceCents ? ` with a $${(detail.content.priceCents / 100).toFixed(2)} unlock price` : ''}. This cannot be undone in Publish Relay.`}
          cancelLabel="Keep reviewing"
          confirmLabel={saving ? 'Sending…' : 'Approve and send'}
          confirmTone="primary"
          disabled={saving}
          returnFocusTo={approveTrigger.current}
          onCancel={() => {
            setConfirmApprove(false);
          }}
          onConfirm={() => {
            void approve();
          }}
        />
      )}
    </WorkspaceLayout>
  );
}
