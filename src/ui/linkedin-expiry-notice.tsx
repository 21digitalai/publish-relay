import { useEffect, useRef, useState } from 'react';

import { showAnalyticsError } from './analytics-events.js';
import { linkedInExpiryWarning, type LinkedInAccount } from './linkedin-expiry.js';
import { beginAdapterConnection } from './posting-adapter-connection.js';
import { getPostingAdapter } from './posting-adapter-registry.js';

async function loadLinkedInHealthAccounts(): Promise<LinkedInAccount[]> {
  const accounts: LinkedInAccount[] = [];
  let cursor: string | null = null;
  do {
    const url = `/api/provider-accounts?provider=linkedin${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('LinkedIn connection health could not be loaded.');
    const result = (await response.json()) as {
      data: { accounts: LinkedInAccount[]; nextCursor: string | null };
    };
    accounts.push(...result.data.accounts);
    cursor = result.data.nextCursor;
  } while (cursor);
  return accounts;
}

export function LinkedInExpiryNotice() {
  const [accounts, setAccounts] = useState<LinkedInAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const healthErrorReported = useRef(false);
  useEffect(() => {
    let active = true;
    void loadLinkedInHealthAccounts()
      .then((loaded) => {
        if (active) setAccounts(loaded);
      })
      .catch(() => {
        if (active && !healthErrorReported.current) {
          healthErrorReported.current = true;
          showAnalyticsError(
            setError,
            'LinkedIn connection health could not be loaded.',
            'connection',
            'network',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  if (loading) return null;
  const warnings = accounts
    .map((account) => ({ account, text: linkedInExpiryWarning(account, Date.now()) }))
    .filter((item): item is { account: LinkedInAccount; text: string } => item.text !== null);
  if (!error && warnings.length === 0) return null;
  const adapter = getPostingAdapter('linkedin');
  return (
    <aside className="linkedin-expiry-notice" aria-label="LinkedIn connection warnings">
      <strong>In-app LinkedIn connection warning</strong>
      {error && <p role="alert">{error} Check Connected accounts.</p>}
      {warnings.map(({ account, text }) => (
        <div className="linkedin-expiry-item" key={account.id}>
          <p>{text} Reconnect before scheduling beyond the expiry date.</p>
          <button
            className="secondary-button"
            disabled={connecting !== null || !adapter}
            onClick={() => {
              if (!adapter) return;
              setConnecting(account.id);
              setError(null);
              void beginAdapterConnection(adapter).catch((connectionError: unknown) => {
                showAnalyticsError(
                  setError,
                  connectionError instanceof Error
                    ? connectionError.message
                    : 'LinkedIn reconnect could not start.',
                  'connection',
                  'provider',
                );
                setConnecting(null);
              });
            }}
          >
            {connecting === account.id ? 'Connecting…' : `Reconnect ${account.displayName}`}
          </button>
        </div>
      ))}
    </aside>
  );
}
