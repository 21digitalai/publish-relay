import { useEffect, useState } from 'react';

import { LiveRegion } from './feedback.js';
import { getCsrfToken } from './posting-adapter-connection.js';

type Module = 'comments' | 'dms';
type GrantEvidence = 'unknown' | 'missing' | 'verified';
type State = Record<Module, { localEnabled: boolean; providerGrant: GrantEvidence }>;

export function FacebookEngagementControl({ accountId }: { accountId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState<Module | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void fetch(`/api/provider-accounts/${accountId}/engagement`)
      .then(async (response) => {
        if (!response.ok) throw new Error('Page modules could not be loaded');
        return (await response.json()) as { data: State };
      })
      .then((result) => {
        if (current) setState(result.data);
      })
      .catch(() => {
        if (current) setError('Page modules could not be loaded');
      });
    return () => {
      current = false;
    };
  }, [accountId]);

  async function toggle(module: Module) {
    if (!state || saving) return;
    setSaving(module);
    setError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/engagement`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ module, enabled: !state[module].localEnabled }),
      });
      const result = (await response.json()) as { data: State | null; error: string | null };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Page module could not be saved');
      setState(result.data);
      setAnnouncement(`${module === 'comments' ? 'Comments' : 'DMs'} local setting saved.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Page module could not be saved');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="x-long-post-setting" aria-label="Facebook Page engagement modules">
      <strong>Optional Page modules</strong>
      <small>Local settings only. Provider permissions are shown separately.</small>
      {state &&
        (['comments', 'dms'] as const).map((module) => (
          <div key={module}>
            <button
              type="button"
              className="defaults-toggle"
              role="switch"
              aria-checked={state[module].localEnabled}
              disabled={saving !== null}
              onClick={() => void toggle(module)}
            >
              <span className="toggle-track" aria-hidden="true">
                <span />
              </span>
              {module === 'comments' ? 'Comments' : 'Page DMs'}
            </button>
            <small>
              Provider grant: {state[module].providerGrant}.{' '}
              {state[module].providerGrant !== 'verified' &&
                'No agent access until grant verification.'}
            </small>
          </div>
        ))}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      <LiveRegion message={announcement} />
    </div>
  );
}
