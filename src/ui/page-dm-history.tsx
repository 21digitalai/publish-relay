import { useCallback, useEffect, useRef, useState } from 'react';

interface HistoryRow {
  id: string;
  kind: 'proposal' | 'send';
  accountId: string;
  accountDisplayName: string;
  conversationId: string;
  receiverLabel: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export function PageDmHistory() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const filterKey = `${accountId ?? ''}:${conversationId ?? ''}`;
  const filterKeyRef = useRef(filterKey);
  filterKeyRef.current = filterKey;

  const load = useCallback(
    async (generation: number, next?: string) => {
      const params = new URLSearchParams();
      if (accountId) params.set('accountId', accountId);
      if (conversationId) params.set('conversationId', conversationId);
      if (next) params.set('cursor', next);
      const response = await fetch(`/api/facebook-page-dm-history?${params.toString()}`);
      const body = (await response.json()) as {
        data: { items: HistoryRow[]; nextCursor: string | null } | null;
        error: string | null;
      };
      const result = body.data;
      if (!response.ok || !result) throw new Error(body.error ?? 'Could not load DM history');
      if (generationRef.current !== generation || filterKeyRef.current !== filterKey) return;
      setRows((current) => (next ? [...current, ...result.items] : result.items));
      setCursor(result.nextCursor);
    },
    [accountId, conversationId, filterKey],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    setRows([]);
    setCursor(null);
    setLoading(true);
    setError(null);
    void load(generation)
      .catch((failure: unknown) => {
        if (generationRef.current === generation && filterKeyRef.current === filterKey)
          setError(failure instanceof Error ? failure.message : 'Could not load DM history');
      })
      .finally(() => {
        if (generationRef.current === generation && filterKeyRef.current === filterKey)
          setLoading(false);
      });
    return () => {
      generationRef.current += 1;
    };
  }, [filterKey, load]);

  return (
    <section className="page-dm-history" aria-labelledby="page-dm-history-title">
      <h2 id="page-dm-history-title">Page DM history</h2>
      <p className="muted">
        Proposals and send attempts, newest first. Select a Page or recipient from a row to filter.
      </p>
      {(Boolean(accountId) || Boolean(conversationId)) && (
        <button
          className="secondary-button page-dm-history-clear"
          type="button"
          onClick={() => {
            setAccountId(null);
            setConversationId(null);
          }}
        >
          Clear filters
        </button>
      )}
      {loading && <p role="status">Loading DM history…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button
            className="secondary-button page-dm-history-retry"
            type="button"
            onClick={() => {
              const generation = ++generationRef.current;
              setLoading(true);
              void load(generation)
                .then(() => {
                  if (generationRef.current === generation && filterKeyRef.current === filterKey)
                    setError(null);
                })
                .catch((failure: unknown) => {
                  if (generationRef.current === generation && filterKeyRef.current === filterKey)
                    setError(
                      failure instanceof Error ? failure.message : 'Could not load DM history',
                    );
                })
                .finally(() => {
                  if (generationRef.current === generation && filterKeyRef.current === filterKey)
                    setLoading(false);
                });
            }}
          >
            Retry
          </button>
        </p>
      )}
      {!loading && !error && rows.length === 0 && <p>No Page DM activity matches these filters.</p>}
      {!error && rows.length > 0 && (
        <ul className="page-dm-history-rows">
          {rows.map((row) => (
            <li className="page-dm-history-row" key={`${row.kind}:${row.id}`}>
              <button
                className="secondary-button page-dm-history-page-filter"
                type="button"
                aria-pressed={accountId === row.accountId}
                onClick={() => {
                  setAccountId(row.accountId);
                  setConversationId(null);
                }}
              >
                {row.accountDisplayName}
              </button>
              <button
                className="secondary-button page-dm-history-receiver-filter"
                type="button"
                aria-pressed={conversationId === row.conversationId}
                onClick={() => {
                  setAccountId(row.accountId);
                  setConversationId(row.conversationId);
                }}
              >
                {row.receiverLabel ?? 'This recipient'}
              </button>
              <span className="page-dm-history-state">
                {row.kind === 'proposal' ? 'Proposal' : 'Send'} · {row.status}
              </span>
              <span className="page-dm-history-timestamps">
                <time dateTime={row.createdAt}>
                  Started{' '}
                  {new Date(row.createdAt).toLocaleString(undefined, { timeZoneName: 'short' })}
                </time>
                <time dateTime={row.updatedAt}>
                  Updated{' '}
                  {new Date(row.updatedAt).toLocaleString(undefined, { timeZoneName: 'short' })}
                </time>
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor && !loading && !error && (
        <button
          className="secondary-button page-dm-history-more"
          type="button"
          onClick={() => {
            const generation = generationRef.current;
            setLoading(true);
            void load(generation, cursor)
              .catch((failure: unknown) => {
                if (generationRef.current === generation && filterKeyRef.current === filterKey)
                  setError(
                    failure instanceof Error ? failure.message : 'Could not load more history',
                  );
              })
              .finally(() => {
                if (generationRef.current === generation && filterKeyRef.current === filterKey)
                  setLoading(false);
              });
          }}
        >
          Load more
        </button>
      )}
    </section>
  );
}
