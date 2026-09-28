import { useEffect, useState } from 'react';

import { linkedInExpiryWarning, type LinkedInAccount } from './linkedin-expiry.js';
import { beginAdapterConnection } from './posting-adapter-connection.js';
import { getPostingAdapter } from './posting-adapter-registry.js';

export function LinkedInExpiryNotice() {
  const [accounts, setAccounts] = useState<LinkedInAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/provider-accounts')
      .then(async (response) => {
        if (!response.ok) throw new Error('LinkedIn connection health could not be loaded.');
        return response.json() as Promise<{
          data: { accounts: (LinkedInAccount & { provider: string })[] };
        }>;
      })
      .then(({ data }) => {
        if (active) setAccounts(data.accounts.filter((account) => account.provider === 'linkedin'));
      })
      .catch(() => {
        if (active) setError('LinkedIn connection health could not be loaded.');
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
                setError(
                  connectionError instanceof Error
                    ? connectionError.message
                    : 'LinkedIn reconnect could not start.',
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
