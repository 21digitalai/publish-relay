import { useCallback, useEffect, useState } from 'react';

type AudienceKind = 'followers' | 'subscribers';
interface Fan {
  uuid: string;
  handle: string;
  displayName: string;
  relationship: 'follower' | 'subscriber';
  subscriptionStatus: 'active' | 'cancelled' | 'pending_confirmation' | 'paused' | null;
}
interface AudiencePage {
  data: Fan[];
  pagination: { page: number; size: number; hasMore: boolean; nextCursor?: string | null };
}

function AudienceList({ accountId, kind }: { accountId: string; kind: AudienceKind }) {
  const [fans, setFans] = useState<Fan[]>([]);
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    async (next: boolean, requestedPage: number, requestedCursor: string | null) => {
      setLoading(true);
      setError(null);
      const query = new URLSearchParams({ size: '15' });
      if (next && kind === 'subscribers' && requestedCursor) query.set('cursor', requestedCursor);
      else query.set('page', String(requestedPage));
      try {
        const response = await fetch(
          `/api/fanvue/accounts/${encodeURIComponent(accountId)}/${kind}?${query}`,
          { cache: 'no-store' },
        );
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? 'Reconnect this account to allow Audience access.'
              : 'Audience could not be loaded. Retry.',
          );
        const result = (await response.json()) as { data: AudiencePage };
        setFans((current) => (next ? [...current, ...result.data.data] : result.data.data));
        setPage(result.data.pagination.page);
        setCursor(result.data.pagination.nextCursor ?? null);
        setHasMore(result.data.pagination.hasMore);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Audience could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [accountId, kind],
  );
  useEffect(() => {
    void load(false, 1, null);
  }, [load]);
  return (
    <div className="fanvue-audience-list">
      <h4>{kind === 'followers' ? 'Followers (not active subscribers)' : 'Subscribers'}</h4>
      {loading && fans.length === 0 ? <p role="status">Loading {kind}…</p> : null}
      {error ? (
        <p role="alert">
          {error}{' '}
          <button
            className="fanvue-audience-retry secondary-button"
            onClick={() => {
              void load(fans.length > 0, fans.length > 0 ? page + 1 : 1, cursor);
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {!loading && !error && fans.length === 0 ? <p>No {kind} found.</p> : null}
      <ul>
        {fans.map((fan) => (
          <li key={fan.uuid}>
            <strong>{fan.displayName}</strong> @{fan.handle} ·{' '}
            {fan.relationship === 'follower'
              ? 'Follower'
              : `Subscriber: ${fan.subscriptionStatus ?? 'status unavailable'}`}
          </li>
        ))}
      </ul>
      {hasMore ? (
        <button
          className="fanvue-audience-load-more secondary-button"
          disabled={loading}
          onClick={() => {
            void load(true, page + 1, cursor);
          }}
        >
          Load more {kind}
        </button>
      ) : null}
    </div>
  );
}

export function FanvueAudienceControl({ accountId }: { accountId: string }) {
  return (
    <section className="fanvue-audience-control" aria-label="Fanvue Audience">
      <h3>Audience</h3>
      <p>Followers excludes active subscribers. These are separate Fanvue relationship lists.</p>
      <AudienceList accountId={accountId} kind="followers" />
      <AudienceList accountId={accountId} kind="subscribers" />
    </section>
  );
}
