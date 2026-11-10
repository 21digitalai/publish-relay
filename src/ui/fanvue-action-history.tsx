import { useCallback, useEffect, useRef, useState } from 'react';

interface FanvueHistoryRow {
  id: string;
  accountId: string;
  accountDisplayName: string;
  kind: 'message' | 'comment';
  targetLabel: string | null;
  outboundText: string | null;
  mediaCount: number | null;
  priceCents: number | null;
  status: string;
  dueAt: string | null;
  providerReceipt: string | null;
  createdAt: string;
  updatedAt: string;
  destinationUrl: string | null;
}

function localTime(value: string) {
  return new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
}

const statusLabels: Record<string, string> = {
  pending: 'Scheduled',
  claimed: 'Dispatching',
  cancelled: 'Cancelled',
  reserved: 'Sending',
  confirmed: 'Sent',
  failed: 'Failed',
  unknown: 'Outcome unknown',
};

export function FanvueActionHistory() {
  const [rows, setRows] = useState<FanvueHistoryRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | 'message' | 'comment'>('all');
  const [status, setStatus] = useState<
    'all' | 'pending' | 'claimed' | 'cancelled' | 'reserved' | 'confirmed' | 'failed' | 'unknown'
  >('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const filterKey = `${accountId ?? ''}:${kind}:${status}`;

  const load = useCallback(
    async (generation: number, next?: string) => {
      const params = new URLSearchParams();
      if (accountId) params.set('accountId', accountId);
      if (kind !== 'all') params.set('kind', kind);
      if (status !== 'all') params.set('status', status);
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/fanvue-engagement-history?${params.toString()}`);
      const body = (await response.json()) as {
        data: { items: FanvueHistoryRow[]; nextCursor: string | null } | null;
        error: string | null;
      };
      if (!response.ok || !body.data)
        throw new Error(body.error ?? 'Could not load Fanvue history');
      if (generationRef.current !== generation) return;
      const result = body.data;
      setRows((current) => (next ? [...current, ...result.items] : result.items));
      setCursor(result.nextCursor);
    },
    [accountId, kind, status],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setRows([]);
    setCursor(null);
    setLoading(true);
    setError(null);
    void load(generation)
      .catch((failure: unknown) => {
        if (generationRef.current === generation)
          setError(failure instanceof Error ? failure.message : 'Could not load Fanvue history');
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
    return () => {
      generationRef.current += 1;
    };
  }, [filterKey, load]);

  return (
    <section
      className="fanvue-action-history page-dm-history"
      aria-labelledby="fanvue-history-title"
    >
      <h2 id="fanvue-history-title">Fanvue engagement history</h2>
      <p className="muted">Scheduled actions and send attempts; a proposal alone is not a send.</p>
      <div className="fanvue-action-history-filters" aria-label="Filter Fanvue channel">
        {(['all', 'message', 'comment'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            className="fanvue-action-history-channel secondary-button"
            aria-pressed={kind === choice}
            onClick={() => {
              setKind(choice);
            }}
          >
            {choice === 'all' ? 'All channels' : choice === 'message' ? 'DMs' : 'Comments'}
          </button>
        ))}
        {accountId && (
          <button
            type="button"
            className="fanvue-action-history-clear-account secondary-button"
            onClick={() => {
              setAccountId(null);
            }}
          >
            Clear account filter
          </button>
        )}
      </div>
      <div
        className="fanvue-action-history-status-filters"
        aria-label="Filter Fanvue action status"
      >
        {(
          [
            'all',
            'pending',
            'claimed',
            'cancelled',
            'reserved',
            'confirmed',
            'failed',
            'unknown',
          ] as const
        ).map((choice) => (
          <button
            key={choice}
            type="button"
            className="fanvue-action-history-status secondary-button"
            aria-pressed={status === choice}
            onClick={() => {
              setStatus(choice);
            }}
          >
            {choice === 'all' ? 'All statuses' : statusLabels[choice]}
          </button>
        ))}
      </div>
      {loading && <p role="status">Loading Fanvue history…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="fanvue-action-history-retry secondary-button"
            onClick={() => {
              const generation = ++generationRef.current;
              setLoading(true);
              void load(generation)
                .then(() => {
                  setError(null);
                })
                .catch((failure: unknown) => {
                  setError(failure instanceof Error ? failure.message : 'Could not load history');
                })
                .finally(() => {
                  setLoading(false);
                });
            }}
          >
            Retry
          </button>
        </p>
      )}
      {!loading && !error && rows.length === 0 && <p>No Fanvue actions match these filters.</p>}
      {!error && rows.length > 0 && (
        <ul className="fanvue-action-history-rows page-dm-history-rows">
          {rows.map((row) => (
            <li className="fanvue-action-history-row page-dm-history-row" key={row.id}>
              <button
                type="button"
                className="fanvue-action-history-account secondary-button"
                aria-pressed={accountId === row.accountId}
                onClick={() => {
                  setAccountId(row.accountId);
                }}
              >
                {row.accountDisplayName}
              </button>
              <strong>
                {row.kind === 'message' ? 'DM' : 'Comment'} ·{' '}
                {statusLabels[row.status] ?? row.status}
              </strong>
              <p className="fanvue-action-history-target">
                {row.kind === 'message' ? 'To: ' : 'On post: '}
                {row.targetLabel ?? 'Target label unavailable for this action'}
              </p>
              <p className="fanvue-action-history-text page-dm-history-text">
                {row.outboundText ??
                  (row.mediaCount ? 'Media-only send' : 'Text unavailable for this older action')}
              </p>
              {row.mediaCount !== null && row.mediaCount > 0 && (
                <span>
                  {row.mediaCount} media attachment{row.mediaCount === 1 ? '' : 's'}
                </span>
              )}
              {row.priceCents !== null && (
                <span>
                  Price{' '}
                  {new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
                    row.priceCents / 100,
                  )}
                </span>
              )}
              {row.dueAt && (
                <time className="fanvue-action-history-due" dateTime={row.dueAt}>
                  Planned {localTime(row.dueAt)}
                </time>
              )}
              {row.destinationUrl ? (
                <a
                  className="fanvue-action-history-link"
                  href={row.destinationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open on Fanvue
                </a>
              ) : (
                <span className="muted">Link unavailable</span>
              )}
              {row.providerReceipt && (
                <details>
                  <summary>Provider receipt</summary>
                  <code>{row.providerReceipt}</code>
                </details>
              )}
              <span className="page-dm-history-timestamps">
                <time dateTime={row.createdAt}>Started {localTime(row.createdAt)}</time>
                <time dateTime={row.updatedAt}>Updated {localTime(row.updatedAt)}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor && !loading && !error && (
        <button
          type="button"
          className="fanvue-action-history-load-more secondary-button"
          onClick={() => {
            const generation = generationRef.current;
            setLoading(true);
            void load(generation, cursor)
              .catch((failure: unknown) => {
                setError(
                  failure instanceof Error ? failure.message : 'Could not load more actions',
                );
              })
              .finally(() => {
                setLoading(false);
              });
          }}
        >
          Load more actions
        </button>
      )}
    </section>
  );
}
