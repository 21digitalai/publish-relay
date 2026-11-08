import { useCallback, useEffect, useRef, useState } from 'react';

import { ConfirmationDialog } from './confirmation-dialog.js';
import { PageDmConversationLink } from './page-dm-conversation-link.js';
import { PageDmHistory } from './page-dm-history.js';
import { getCsrfToken } from './posting-adapter-connection.js';
import { WorkspaceLayout } from './workflow.js';

interface ProposalSummary {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  status: string;
  plannedDueAt?: string;
  sourcePreview: string;
  contentPreview: string;
  bubbleCount?: number;
  createdAt: string;
}

interface ProposalDetail {
  id: string;
  accountDisplayName: string;
  provider: string;
  kind: 'dm' | 'comment';
  targetId: string;
  sourceContext: { text?: string; authorLabel?: string; postId?: string; sourceMessageId?: string };
  content: { text: string; followUps?: [string, string]; mediaIds?: string[]; priceCents?: number };
  plannedDueAt?: string;
  revision: number;
  status: string;
  canApprove: boolean;
  noGo: boolean;
  schedule?: { dueAt: string; status: string } | null;
  scheduleWindow?: { earliestDelaySeconds: number; latestDelaySeconds: number } | null;
}

interface NoGoEntry {
  accountId: string;
  conversationId: string;
  displayName: string | null;
  accountDisplayName: string;
  createdAt: string;
}

type ReplyWindow =
  | { state: 'open'; latestInboundAt: string; windowDeadline: string }
  | { state: 'closed' }
  | { state: 'stale' }
  | { state: 'unavailable' };

function replyWindowLabel(window: ReplyWindow | null, now: number): string {
  if (!window) return 'Checking the Messenger reply window…';
  if (window.state === 'stale') return 'Newer message arrived · fresh draft coming';
  if (window.state === 'closed') return 'Reply window closed · waiting for their next message';
  if (window.state === 'unavailable')
    return 'Reply window could not be verified. Approval is unavailable.';
  if (Date.parse(window.windowDeadline) <= now)
    return 'Reply window closed · waiting for their next message';
  const minutesLeft = Math.ceil((Date.parse(window.windowDeadline) - now) / 60_000);
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  const closes = new Date(window.windowDeadline).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Reply window: ${String(hours)}h ${String(minutes).padStart(2, '0')}m left (closes ${closes})`;
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
  const terminalWindowKey = `page-dm-terminal-windows:${window.location.pathname.split('/')[2] ?? ''}`;
  const [now, setNow] = useState(Date.now());
  const [items, setItems] = useState<ProposalSummary[]>([]);
  const [noGoEntries, setNoGoEntries] = useState<NoGoEntry[]>([]);
  const [noGoCursor, setNoGoCursor] = useState<string | null>(null);
  const [noGoLoadingMore, setNoGoLoadingMore] = useState(false);
  const [canManageNoGo, setCanManageNoGo] = useState(false);
  const [noGoFailed, setNoGoFailed] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProposalDetail | null>(null);
  const [replyWindow, setReplyWindow] = useState<ReplyWindow | null>(null);
  const [terminalWindows, setTerminalWindows] = useState<Record<string, 'closed' | 'stale'>>(() => {
    try {
      return JSON.parse(window.sessionStorage.getItem(terminalWindowKey) ?? '{}') as Record<
        string,
        'closed' | 'stale'
      >;
    } catch {
      return {};
    }
  });
  const [draft, setDraft] = useState('');
  const [draftFollowUps, setDraftFollowUps] = useState<[string, string]>(['', '']);
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailReload, setDetailReload] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approvalPreview, setApprovalPreview] = useState<{
    dueAt: string;
    previewedAt: string;
    latestInboundFingerprint: string;
  } | null>(null);
  const [confirmNoGo, setConfirmNoGo] = useState(false);
  const [confirmCancelSchedule, setConfirmCancelSchedule] = useState(false);
  const [dmTiming, setDmTiming] = useState<'scheduled' | 'immediate'>('scheduled');
  const [delayMinMinutes, setDelayMinMinutes] = useState(5);
  const [delayMaxMinutes, setDelayMaxMinutes] = useState(45);
  const [sendUncertain, setSendUncertain] = useState(false);
  const [mediaStates, setMediaStates] = useState<Record<string, string>>({});
  const [mediaPending, setMediaPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissTrigger = useRef<HTMLButtonElement>(null);
  const approveTrigger = useRef<HTMLButtonElement>(null);
  const noGoTrigger = useRef<HTMLButtonElement>(null);
  const cancelScheduleTrigger = useRef<HTMLButtonElement>(null);
  const activeProposalRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.sessionStorage.setItem(terminalWindowKey, JSON.stringify(terminalWindows));
  }, [terminalWindowKey, terminalWindows]);

  const loadPage = useCallback(async (cursor?: string) => {
    const page = await readApi<{ items: ProposalSummary[]; nextCursor: string | null }>(
      `/api/engagement-proposals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    setItems((current) => (cursor ? [...current, ...page.items] : page.items));
    setNextCursor(page.nextCursor);
  }, []);

  const loadNoGo = useCallback(async (cursor?: string) => {
    const result = await readApi<{
      items: NoGoEntry[];
      canManage: boolean;
      nextCursor: string | null;
    }>(`/api/facebook-page-dm-no-go${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    setNoGoEntries((current) => (cursor ? [...current, ...result.items] : result.items));
    setNoGoCursor(result.nextCursor);
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
    setReplyWindow(null);
    setMediaStates({});
    setDetailFailed(false);
    setError(null);
    void readApi<ProposalDetail>(`/api/engagement-proposals/${selectedId}`)
      .then((proposal) => {
        if (!active) return;
        setDetail(proposal);
        activeProposalRef.current = `${proposal.id}:${String(proposal.revision)}`;
        setDraft(proposal.content.text);
        setDraftFollowUps(proposal.content.followUps ?? ['', '']);
        setSendUncertain(false);
        setDmTiming('scheduled');
        setDelayMinMinutes((proposal.scheduleWindow?.earliestDelaySeconds ?? 300) / 60);
        setDelayMaxMinutes((proposal.scheduleWindow?.latestDelaySeconds ?? 2700) / 60);
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

  useEffect(() => {
    if (detail?.provider !== 'facebook_page' || detail.kind !== 'dm' || detail.status !== 'pending')
      return;
    let active = true;
    void readApi<ReplyWindow>(`/api/engagement-proposals/${detail.id}/reply-window`)
      .then((window) => {
        if (!active) return;
        setReplyWindow(window);
        if (window.state === 'closed' || window.state === 'stale') {
          setTerminalWindows((current) => ({ ...current, [detail.id]: window.state }));
        } else if (window.state === 'open') {
          setTerminalWindows((current) =>
            Object.fromEntries(Object.entries(current).filter(([id]) => id !== detail.id)),
          );
        }
      })
      .catch(() => {
        if (active) setReplyWindow({ state: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [detail]);

  useEffect(() => {
    if (detail?.id !== selectedId || replyWindow?.state !== 'open') return;
    if (Date.parse(replyWindow.windowDeadline) > now) return;
    setTerminalWindows((current) =>
      current[detail.id] === 'closed' ? current : { ...current, [detail.id]: 'closed' },
    );
  }, [detail, now, replyWindow, selectedId]);

  const mutate = async (action: 'edit' | 'dismiss') => {
    if (!detail || saving) return;
    if (action === 'edit' && (!draft.trim() || draft.length > 5000)) {
      setError('Reply must contain 1–5,000 characters.');
      return;
    }
    if (
      action === 'edit' &&
      detail.content.followUps &&
      draftFollowUps.some((text) => !text.trim() || text.length > 2000)
    ) {
      setError('Each follow-up bubble must contain 1–2,000 characters.');
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
                  content: {
                    ...detail.content,
                    text: draft.trim(),
                    ...(detail.content.followUps
                      ? { followUps: draftFollowUps.map((text) => text.trim()) }
                      : {}),
                  },
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
        setDraftFollowUps(updated.content.followUps ?? ['', '']);
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
      const outcome = await readApi<{ id: string; status: string; dueAt?: string }>(
        `/api/engagement-proposals/${detail.id}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({
            expectedRevision: detail.revision,
            ...(detail.provider === 'facebook_page' && detail.kind === 'dm'
              ? { sendMode: dmTiming, ...(dmTiming === 'scheduled' ? approvalPreview : {}) }
              : {}),
          }),
        },
      );
      setDetail({
        ...detail,
        status: outcome.status,
        schedule: outcome.dueAt
          ? { dueAt: outcome.dueAt, status: 'pending' }
          : (detail.schedule ?? null),
      });
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
          : outcome.status === 'scheduled'
            ? `Reply scheduled for ${outcome.dueAt ? new Date(outcome.dueAt).toLocaleString() : 'the selected window'}; you can cancel before dispatch.`
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
      setApprovalPreview(null);
    }
  };

  const openApprovalConfirmation = async () => {
    if (!detail || saving) return;
    if (detail.provider !== 'facebook_page' || detail.kind !== 'dm' || dmTiming !== 'scheduled') {
      setConfirmApprove(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const preview = await readApi<{
        dueAt: string;
        previewedAt: string;
        latestInboundFingerprint: string;
      }>(`/api/engagement-proposals/${detail.id}/approve-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ expectedRevision: detail.revision }),
      });
      setApprovalPreview(preview);
      setConfirmApprove(true);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not preview the final send time',
      );
    } finally {
      setSaving(false);
    }
  };

  const cancelSchedule = async () => {
    if (!detail || saving) return;
    setSaving(true);
    setError(null);
    try {
      await readApi<{ status: string }>(`/api/engagement-proposals/${detail.id}/cancel-scheduled`, {
        method: 'POST',
        headers: { 'x-csrf-token': getCsrfToken() },
      });
      setDetailReload((current) => current + 1);
      setItems((current) => current.filter((item) => item.id !== detail.id));
      setNotice(
        detail.content.followUps
          ? 'Remaining scheduled bubbles cancelled. Earlier confirmed bubbles, if any, remain in Page DM history.'
          : 'Scheduled reply cancelled before dispatch. No message was sent.',
      );
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Could not cancel this scheduled reply',
      );
      setDetailReload((current) => current + 1);
    } finally {
      setSaving(false);
      setConfirmCancelSchedule(false);
    }
  };

  const savePageTiming = async () => {
    if (!detail || saving) return;
    if (delayMaxMinutes < delayMinMinutes) {
      setError('Latest delay must not be earlier than earliest delay.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const scheduleWindow = await readApi<{
        earliestDelaySeconds: number;
        latestDelaySeconds: number;
      }>(`/api/engagement-proposals/${detail.id}/schedule-default`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({
          earliestDelaySeconds: delayMinMinutes * 60,
          latestDelaySeconds: delayMaxMinutes * 60,
        }),
      });
      setDetail({ ...detail, scheduleWindow });
      setNotice(
        `Default Page reply delay saved: ${String(delayMinMinutes)}–${String(delayMaxMinutes)} minutes.`,
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save Page reply timing');
    } finally {
      setSaving(false);
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
    (!detail.content.followUps || detail.content.followUps.every((text) => text.length <= 2000)) &&
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

  const expiredScheduled =
    detail?.status === 'expired' ||
    (detail?.status === 'pending' &&
      detail.provider === 'facebook_page' &&
      detail.kind === 'dm' &&
      Boolean(detail.plannedDueAt && Date.parse(detail.plannedDueAt) <= now));
  const pageDmWindowClosed =
    detail?.id === selectedId &&
    (replyWindow?.state === 'closed' ||
      (replyWindow?.state === 'open' && Date.parse(replyWindow.windowDeadline) <= now));
  const pageDmWindowReady = replyWindow?.state === 'open' && !pageDmWindowClosed;
  const canApprove =
    detail?.status === 'pending' &&
    selectedId === detail.id &&
    activeProposalRef.current === `${detail.id}:${String(detail.revision)}` &&
    detail.canApprove &&
    (detail.provider !== 'facebook_page' || detail.kind !== 'dm' || pageDmWindowReady) &&
    !detail.noGo &&
    (facebookReady || fanvueReady) &&
    draft.trim() === detail.content.text &&
    (!detail.content.followUps ||
      detail.content.followUps.every((text, index) => draftFollowUps[index]?.trim() === text)) &&
    !(
      detail.provider === 'facebook_page' &&
      detail.kind === 'dm' &&
      dmTiming === 'scheduled' &&
      !detail.plannedDueAt
    ) &&
    !sendUncertain;

  const inactiveDraft = (item: ProposalSummary): boolean => {
    if (item.status === 'expired' || item.status === 'superseded') return true;
    if (item.status !== 'pending' || item.provider !== 'facebook_page' || item.kind !== 'dm')
      return false;
    if (terminalWindows[item.id]) return true;
    if (selectedId !== item.id || detail?.id !== item.id) return false;
    return (
      replyWindow?.state === 'closed' ||
      replyWindow?.state === 'stale' ||
      (replyWindow?.state === 'open' && Date.parse(replyWindow.windowDeadline) <= now)
    );
  };
  const activeItems = items.filter((item) => item.status === 'pending' && !inactiveDraft(item));
  const inactiveItems = items.filter(inactiveDraft);
  const outcomeItems = items.filter((item) => item.status !== 'pending' && !inactiveDraft(item));

  const renderProposalRow = (item: ProposalSummary) => (
    <div className="engagement-proposal-entry" key={item.id}>
      <button
        className={`engagement-proposal-row ${selectedId === item.id ? 'selected' : ''}`}
        type="button"
        aria-pressed={selectedId === item.id}
        onClick={() => {
          if (selectedId !== item.id) activeProposalRef.current = null;
          setSelectedId(item.id);
        }}
      >
        <strong>{proposalLabel(item)}</strong>
        {item.bubbleCount === 3 && <span>3-bubble group · one approval</span>}
        {item.provider === 'facebook_page' && item.kind === 'dm' && item.status === 'pending' && (
          <span
            className={`engagement-reply-window-badge ${inactiveDraft(item) || (selectedId === item.id && replyWindow?.state === 'unavailable') ? 'danger' : ''}`}
          >
            {selectedId === item.id && detail?.id === item.id
              ? replyWindowLabel(replyWindow, now)
              : terminalWindows[item.id]
                ? replyWindowLabel(
                    { state: terminalWindows[item.id] === 'stale' ? 'stale' : 'closed' },
                    now,
                  )
                : 'Reply window: select to check'}
            {selectedId === item.id && detail?.id === item.id && replyWindow?.state === 'open' && (
              <small>
                Last message from recipient:{' '}
                {new Date(replyWindow.latestInboundAt).toLocaleString()}
              </small>
            )}
          </span>
        )}
        {item.status === 'expired' && (
          <span className="engagement-proposal-warning">
            Expired draft · dismiss or wait for a fresh draft
          </span>
        )}
        {item.status === 'superseded' && (
          <span className="engagement-proposal-warning">Superseded by a newer draft</span>
        )}
        {item.status !== 'pending' && !inactiveDraft(item) && (
          <span>
            {item.status === 'scheduled'
              ? 'Scheduled'
              : item.status === 'unknown' || item.status === 'sending'
                ? 'Send outcome unknown'
                : 'Provider rejected send'}
          </span>
        )}
        <span>{item.accountDisplayName}</span>
        <span>{item.contentPreview}</span>
        <small>{new Date(item.createdAt).toLocaleString()}</small>
      </button>
      {item.provider === 'facebook_page' && item.kind === 'dm' && (
        <PageDmConversationLink kind="proposal" rowId={item.id} />
      )}
    </div>
  );

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
              <>
                <div className="engagement-proposals-active" aria-label="Awaiting approval">
                  <h2>Awaiting approval</h2>
                  {activeItems.length ? (
                    activeItems.map(renderProposalRow)
                  ) : (
                    <p>No drafts await approval.</p>
                  )}
                </div>
                {outcomeItems.length > 0 && (
                  <div className="engagement-proposals-outcomes" aria-label="Send outcomes">
                    <h2>Send outcomes</h2>
                    {outcomeItems.map(renderProposalRow)}
                  </div>
                )}
                {inactiveItems.length > 0 && (
                  <div className="engagement-proposals-inactive" aria-label="Unsent suggestions">
                    <h2>Unsent suggestions</h2>
                    <p className="muted">Never sent · kept for context only.</p>
                    {inactiveItems.map(renderProposalRow)}
                  </div>
                )}
              </>
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
                {detail.provider === 'facebook_page' &&
                  detail.kind === 'dm' &&
                  detail.status === 'pending' && (
                    <div
                      className={`engagement-reply-window-detail ${pageDmWindowClosed || replyWindow?.state === 'stale' || replyWindow?.state === 'unavailable' ? 'danger' : ''}`}
                      role="status"
                    >
                      <p>{replyWindowLabel(replyWindow, now)}</p>
                      {replyWindow?.state === 'open' && (
                        <p className="muted">
                          Last message from recipient:{' '}
                          {new Date(replyWindow.latestInboundAt).toLocaleString()}
                        </p>
                      )}
                      {replyWindow?.state === 'unavailable' && (
                        <button
                          className="secondary-button engagement-reply-window-retry"
                          type="button"
                          onClick={() => {
                            setDetailReload((current) => current + 1);
                          }}
                        >
                          Retry reply-window check
                        </button>
                      )}
                    </div>
                  )}
                {detail.provider === 'facebook_page' && detail.kind === 'dm' && (
                  <p className={detail.noGo ? 'form-error' : 'muted'} role="status">
                    {detail.noGo
                      ? 'No-go conversation: new proposals and sends are blocked.'
                      : 'This conversation is not on the no-go list.'}
                  </p>
                )}
                <label className="field-label" htmlFor="engagement-proposal-draft">
                  {detail.content.followUps ? 'Bubble 1' : 'Suggested reply'}
                </label>
                <p className="engagement-proposal-edit-help muted">
                  Edit the bubbles, then approve.
                </p>
                <textarea
                  id="engagement-proposal-draft"
                  className="engagement-proposal-draft text-input"
                  value={draft}
                  maxLength={5000}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                />
                {detail.provider === 'facebook_page' &&
                  detail.kind === 'dm' &&
                  detail.content.followUps?.map((_, index) => (
                    <label className="field-label" key={index}>
                      Bubble {index + 2}
                      <textarea
                        className="engagement-proposal-draft text-input"
                        value={draftFollowUps[index]}
                        maxLength={2000}
                        onChange={(event) => {
                          setDraftFollowUps(
                            (current) =>
                              current.map((text, itemIndex) =>
                                itemIndex === index ? event.target.value : text,
                              ) as [string, string],
                          );
                        }}
                      />
                    </label>
                  ))}
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
                {(detail.status !== 'pending' || expiredScheduled) &&
                  !(
                    detail.provider === 'facebook_page' &&
                    detail.kind === 'dm' &&
                    detail.status === 'pending' &&
                    !pageDmWindowReady
                  ) && (
                    <p
                      className={
                        expiredScheduled || detail.status === 'superseded'
                          ? 'form-error'
                          : 'form-success'
                      }
                      role="status"
                    >
                      {detail.status === 'sent'
                        ? 'Sent'
                        : detail.status === 'superseded'
                          ? 'A newer draft replaced this one. This proposal cannot be approved or sent.'
                          : expiredScheduled
                            ? 'Expired draft. Dismiss it or wait for a fresh draft.'
                            : detail.status === 'scheduled'
                              ? detail.schedule
                                ? `Scheduled for ${new Date(detail.schedule.dueAt).toLocaleString()}. You can cancel before dispatch.`
                                : 'Scheduled; refresh to see the send time.'
                              : detail.status === 'cancelled'
                                ? 'Cancelled before dispatch'
                                : detail.status === 'dismissed'
                                  ? 'Dismissed without sending'
                                  : detail.status === 'failed'
                                    ? 'Provider rejected this send'
                                    : 'Send outcome is unknown; do not send again'}
                    </p>
                  )}
                <div className="engagement-proposal-actions">
                  {detail.status === 'pending' &&
                    detail.provider === 'facebook_page' &&
                    detail.kind === 'dm' &&
                    pageDmWindowReady && (
                      <fieldset className="engagement-proposal-timing">
                        <legend>Bot-selected send plan</legend>
                        <p className="muted engagement-planned-due-at">
                          {detail.plannedDueAt
                            ? Date.parse(detail.plannedDueAt) <= Date.now()
                              ? `Bot-selected time ${new Date(detail.plannedDueAt).toLocaleString()} has passed. A fresh reply-window check is required.`
                              : `Bot-selected time ${new Date(detail.plannedDueAt).toLocaleString()}; approval adds the Page delay on top.`
                            : 'This proposal has no bot-selected time. Scheduling is unavailable; request a new proposal.'}
                        </p>
                        <p className="muted">
                          {detail.content.followUps
                            ? 'One approval schedules all three bubbles. Bubbles 2 and 3 follow the preceding confirmed send by 4–10 seconds; a changed conversation or failed send stops the rest.'
                            : ''}
                        </p>
                        <p className="muted">
                          Default for this Page:{' '}
                          {Math.round((detail.scheduleWindow?.earliestDelaySeconds ?? 300) / 60)}–
                          {Math.round((detail.scheduleWindow?.latestDelaySeconds ?? 2700) / 60)}{' '}
                          minutes.
                        </p>
                        <button
                          type="button"
                          className={`secondary-button engagement-timing-scheduled ${dmTiming === 'scheduled' ? 'selected' : ''}`}
                          aria-pressed={dmTiming === 'scheduled'}
                          onClick={() => {
                            setDmTiming('scheduled');
                          }}
                        >
                          Approve scheduled time
                        </button>
                        {!detail.content.followUps && !expiredScheduled && (
                          <button
                            type="button"
                            className={`secondary-button engagement-timing-immediate ${dmTiming === 'immediate' ? 'selected' : ''}`}
                            aria-pressed={dmTiming === 'immediate'}
                            onClick={() => {
                              setDmTiming('immediate');
                            }}
                          >
                            Send immediately
                          </button>
                        )}
                        {detail.canApprove && (
                          <div className="engagement-page-delay-settings">
                            <label className="field-label" htmlFor="engagement-delay-min">
                              Earliest delay (minutes)
                            </label>
                            <select
                              id="engagement-delay-min"
                              className="engagement-delay-min text-input"
                              value={delayMinMinutes}
                              onChange={(event) => {
                                setDelayMinMinutes(Number(event.target.value));
                              }}
                            >
                              {[0, 5, 10, 15, 30, 45, 60, 90].map((minutes) => (
                                <option key={minutes} value={minutes}>
                                  {minutes}
                                </option>
                              ))}
                            </select>
                            <label className="field-label" htmlFor="engagement-delay-max">
                              Latest delay (minutes)
                            </label>
                            <select
                              id="engagement-delay-max"
                              className="engagement-delay-max text-input"
                              value={delayMaxMinutes}
                              onChange={(event) => {
                                setDelayMaxMinutes(Number(event.target.value));
                              }}
                            >
                              {[0, 5, 10, 15, 30, 45, 60, 90].map((minutes) => (
                                <option key={minutes} value={minutes}>
                                  {minutes}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="secondary-button engagement-delay-save"
                              disabled={
                                saving ||
                                delayMaxMinutes < delayMinMinutes ||
                                ((detail.scheduleWindow?.earliestDelaySeconds ?? 300) ===
                                  delayMinMinutes * 60 &&
                                  (detail.scheduleWindow?.latestDelaySeconds ?? 2700) ===
                                    delayMaxMinutes * 60)
                              }
                              onClick={() => {
                                void savePageTiming();
                              }}
                            >
                              Save Page timing
                            </button>
                          </div>
                        )}
                      </fieldset>
                    )}
                  {detail.status === 'pending' &&
                    !(
                      detail.provider === 'facebook_page' &&
                      detail.kind === 'dm' &&
                      !pageDmWindowReady
                    ) && (
                      <button
                        ref={approveTrigger}
                        className="primary-button engagement-proposal-approve"
                        type="button"
                        disabled={saving || !canApprove}
                        onClick={() => {
                          void openApprovalConfirmation();
                        }}
                      >
                        {detail.provider === 'facebook_page' &&
                        detail.kind === 'dm' &&
                        dmTiming === 'scheduled'
                          ? detail.content.followUps
                            ? 'Approve and schedule 3 bubbles'
                            : 'Approve and schedule'
                          : 'Approve and send'}
                      </button>
                    )}
                  {detail.status === 'scheduled' && detail.canApprove && (
                    <button
                      ref={cancelScheduleTrigger}
                      className="danger-button engagement-proposal-cancel-schedule"
                      type="button"
                      disabled={saving || detail.schedule?.status !== 'pending'}
                      onClick={() => {
                        setConfirmCancelSchedule(true);
                      }}
                    >
                      Cancel scheduled reply
                    </button>
                  )}
                  {detail.status === 'pending' &&
                    (detail.provider !== 'facebook_page' ||
                      detail.kind !== 'dm' ||
                      pageDmWindowReady) && (
                      <button
                        className="secondary-button engagement-proposal-save"
                        type="button"
                        disabled={
                          saving ||
                          !draft.trim() ||
                          (draft.trim() === detail.content.text &&
                            (!detail.content.followUps ||
                              detail.content.followUps.every(
                                (text, index) => draftFollowUps[index]?.trim() === text,
                              )))
                        }
                        onClick={() => {
                          void mutate('edit');
                        }}
                      >
                        {saving ? 'Saving…' : 'Save edits'}
                      </button>
                    )}
                  <button
                    ref={dismissTrigger}
                    className="danger-button engagement-proposal-dismiss"
                    type="button"
                    disabled={
                      saving ||
                      !['pending', 'expired', 'superseded'].includes(detail.status) ||
                      sendUncertain
                    }
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
                {detail.status === 'pending' &&
                  !canApprove &&
                  !(
                    detail.provider === 'facebook_page' &&
                    detail.kind === 'dm' &&
                    !pageDmWindowReady
                  ) && (
                    <p className="muted">
                      {sendUncertain
                        ? 'Refresh to verify the latest send state before continuing.'
                        : dmTiming === 'scheduled' &&
                            detail.provider === 'facebook_page' &&
                            detail.kind === 'dm' &&
                            !detail.plannedDueAt
                          ? 'A future bot-selected send time is required before approval.'
                          : !detail.canApprove
                            ? 'Only a workspace owner or admin can approve and send.'
                            : draft.trim() !== detail.content.text ||
                                detail.content.followUps?.some(
                                  (text, index) => draftFollowUps[index]?.trim() !== text,
                                )
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
            <>
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
                                failure instanceof Error
                                  ? failure.message
                                  : 'Could not remove block',
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
              {noGoCursor && (
                <button
                  className="secondary-button engagement-no-go-more"
                  type="button"
                  disabled={noGoLoadingMore}
                  onClick={() => {
                    setNoGoLoadingMore(true);
                    void loadNoGo(noGoCursor)
                      .catch(() => {
                        setNoGoFailed(true);
                      })
                      .finally(() => {
                        setNoGoLoadingMore(false);
                      });
                  }}
                >
                  {noGoLoadingMore ? 'Loading…' : 'Load more blocked conversations'}
                </button>
              )}
            </>
          )}
        </section>
        <PageDmHistory />
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
          title={
            dmTiming === 'scheduled' && detail.provider === 'facebook_page' && detail.kind === 'dm'
              ? detail.content.followUps
                ? 'Approve and schedule all three bubbles?'
                : 'Approve and schedule this reply?'
              : 'Approve and send this reply?'
          }
          description={
            dmTiming === 'scheduled' && detail.provider === 'facebook_page' && detail.kind === 'dm'
              ? `Schedule the reviewed ${detail.content.followUps ? 'three-bubble reply' : 'reply'} to ${detail.sourceContext.authorLabel ?? 'this recipient'} on ${detail.accountDisplayName} for ${approvalPreview ? new Date(approvalPreview.dueAt).toLocaleString() : 'an unavailable time'}.${detail.content.followUps ? ' Later bubbles follow confirmed sends by 4–10 seconds.' : ''} You can cancel remaining pending bubbles.`
              : `Send the reviewed ${proposalLabel(detail)} to ${detail.accountDisplayName} now${detail.content.priceCents ? ` with a $${(detail.content.priceCents / 100).toFixed(2)} unlock price` : ''}. This cannot be undone in Publish Relay.`
          }
          cancelLabel="Keep reviewing"
          confirmLabel={
            saving
              ? 'Submitting…'
              : dmTiming === 'scheduled' &&
                  detail.provider === 'facebook_page' &&
                  detail.kind === 'dm'
                ? 'Approve and schedule'
                : 'Approve and send'
          }
          confirmTone="primary"
          disabled={saving}
          returnFocusTo={approveTrigger.current}
          onCancel={() => {
            setConfirmApprove(false);
            setApprovalPreview(null);
          }}
          onConfirm={() => {
            void approve();
          }}
        />
      )}
      {confirmCancelSchedule && detail && (
        <ConfirmationDialog
          titleId="engagement-cancel-schedule-title"
          title="Cancel this scheduled reply?"
          description="Cancellation works only before dispatch begins. Nothing will be sent if cancellation succeeds."
          cancelLabel="Keep scheduled"
          confirmLabel={saving ? 'Cancelling…' : 'Cancel scheduled reply'}
          confirmTone="danger"
          disabled={saving}
          returnFocusTo={cancelScheduleTrigger.current}
          onCancel={() => {
            setConfirmCancelSchedule(false);
          }}
          onConfirm={() => {
            void cancelSchedule();
          }}
        />
      )}
    </WorkspaceLayout>
  );
}
