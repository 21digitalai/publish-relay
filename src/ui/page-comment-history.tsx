import { useCallback, useEffect, useRef, useState } from 'react';

interface CommentHistoryRow {
  id: string;
  kind: 'send' | 'scheduled';
  accountId: string;
  accountDisplayName: string;
  targetExcerpt: string | null;
  outboundText: string | null;
  status: string;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  postUrl: string | null;
}

const statuses = ['all', 'pending', 'confirmed', 'failed', 'unknown', 'cancelled'] as const;

function localTime(value: string) {
  return new Date(value).toLocaleString(undefined, { timeZoneName: 'short' });
}

export function PageCommentHistory() {
  const [rows, setRows] = useState<CommentHistoryRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const filterKey = `${accountId ?? ''}:${status}`;

  const load = useCallback(
    async (generation: number, next?: string) => {
      const params = new URLSearchParams();
      if (accountId) params.set('accountId', accountId);
      if (status !== 'all') params.set('status', status);
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/facebook-page-comment-history?${params.toString()}`);
      const body = (await response.json()) as {
        data: { items: CommentHistoryRow[]; nextCursor: string | null } | null;
        error: string | null;
      };
      if (!response.ok || !body.data)
        throw new Error(body.error ?? 'Could not load comment history');
      if (generationRef.current !== generation) return;
      setRows((current) => (next ? [...current, ...body.data!.items] : body.data!.items));
      setCursor(body.data.nextCursor);
    },
    [accountId, status],
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
          setError(failure instanceof Error ? failure.message : 'Could not load comment history');
      })
      .finally(() => {
        if (generationRef.current === generation) setLoading(false);
      });
    return () => {
      generationRef.current += 1;
    };
  }, [filterKey, load]);

  return (
    <section className="page-comment-history page-dm-history" aria-labelledby="page-comment-history-title">
      <h2 id="page-comment-history-title">Page comment reply history</h2>
      <p className="muted">Direct and scheduled replies, newest first. Scheduled is not sent.</p>
      <div className="page-comment-history-filters" aria-label="Filter comment reply status">
        {statuses.map((choice) => (
          <button
            key={choice}
            type="button"
            className="secondary-button"
            aria-pressed={status === choice}
            onClick={() => setStatus(choice)}
          >
            {choice === 'all' ? 'All statuses' : choice}
          </button>
        ))}
        {accountId && (
          <button type="button" className="secondary-button" onClick={() => setAccountId(null)}>
            Clear Page filter
          </button>
        )}
      </div>
      {loading && <p role="status">Loading comment replies…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              const generation = ++generationRef.current;
              setLoading(true);
              void load(generation)
                .then(() => setError(null))
                .catch((failure: unknown) =>
                  setError(failure instanceof Error ? failure.message : 'Could not load replies'),
                )
                .finally(() => setLoading(false));
            }}
          >
            Retry
          </button>
        </p>
      )}
      {!loading && !error && rows.length === 0 && <p>No comment replies match these filters.</p>}
      {!error && rows.length > 0 && (
        <ul className="page-dm-history-rows">
          {rows.map((row) => (
            <li className="page-dm-history-row" key={`${row.kind}:${row.id}`}>
              <button
                type="button"
                className="secondary-button"
                aria-pressed={accountId === row.accountId}
                onClick={() => setAccountId(row.accountId)}
              >
                {row.accountDisplayName}
              </button>
              <strong>{row.kind === 'scheduled' && row.status === 'pending' ? 'Scheduled' : row.status}</strong>
              <p>{row.targetExcerpt ? `In reply to: ${row.targetExcerpt}` : 'Original comment text unavailable'}</p>
              <p className="page-dm-history-text">
                {row.outboundText ?? 'Reply text unavailable for this older action'}
              </p>
              {row.postUrl ? (
                <a href={row.postUrl} target="_blank" rel="noopener noreferrer">
                  Open post on Facebook
                </a>
              ) : (
                <span className="muted">Post link unavailable</span>
              )}
              <span className="page-dm-history-timestamps">
                {row.dueAt && <time dateTime={row.dueAt}>Due {localTime(row.dueAt)}</time>}
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
          className="secondary-button"
          onClick={() => {
            const generation = generationRef.current;
            setLoading(true);
            void load(generation, cursor)
              .catch((failure: unknown) =>
                setError(failure instanceof Error ? failure.message : 'Could not load more replies'),
              )
              .finally(() => setLoading(false));
          }}
        >
          Load more replies
        </button>
      )}
    </section>
  );
}
