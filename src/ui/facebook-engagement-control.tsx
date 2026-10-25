import { useEffect, useState } from 'react';

import { LiveRegion } from './feedback.js';
import { getCsrfToken } from './posting-adapter-connection.js';

type Module = 'comments' | 'dms';
type GrantEvidence = 'unknown' | 'missing' | 'verified';
type State = Record<Module, { localEnabled: boolean; providerGrant: GrantEvidence }>;
type Capability =
  'comments:read' | 'comments:propose' | 'comments:send' | 'dms:read' | 'dms:propose' | 'dms:send';
interface Principal {
  kind: 'api-key' | 'delegated';
  id: string;
  label: string;
  capabilities: Capability[];
}
const capabilityChoices: { value: Capability; label: string }[] = [
  { value: 'comments:read', label: 'Read comments' },
  { value: 'comments:propose', label: 'Suggest comment replies' },
  { value: 'comments:send', label: 'Send comment replies' },
  { value: 'dms:read', label: 'Read Page DMs' },
  { value: 'dms:propose', label: 'Suggest DM replies' },
  { value: 'dms:send', label: 'Send Page DMs' },
];

export function FacebookEngagementControl({ accountId }: { accountId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [saving, setSaving] = useState<Module | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [showPrincipals, setShowPrincipals] = useState(false);
  const [principals, setPrincipals] = useState<Principal[] | null>(null);
  const [editing, setEditing] = useState<{
    principal: Principal;
    capabilities: Capability[];
  } | null>(null);
  const [savingGrants, setSavingGrants] = useState(false);

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

  async function loadPrincipals() {
    setError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/engagement/principals`);
      const result = (await response.json()) as { data: Principal[] | null; error: string | null };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Agent access could not be loaded');
      setPrincipals(result.data);
      setShowPrincipals(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent access could not be loaded');
    }
  }

  async function saveGrants() {
    if (!editing || savingGrants) return;
    setSavingGrants(true);
    setError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/engagement/grants`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({
          principalKind: editing.principal.kind,
          principalId: editing.principal.id,
          capabilities: editing.capabilities,
        }),
      });
      const result = (await response.json()) as { error: string | null };
      if (!response.ok) throw new Error(result.error ?? 'Agent access could not be saved');
      setPrincipals(
        (current) =>
          current?.map((principal) =>
            principal.kind === editing.principal.kind && principal.id === editing.principal.id
              ? { ...principal, capabilities: editing.capabilities }
              : principal,
          ) ?? null,
      );
      setAnnouncement(`Access for ${editing.principal.label} saved.`);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent access could not be saved');
    } finally {
      setSavingGrants(false);
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
      {state && (
        <div className="facebook-engagement-principals">
          <button
            type="button"
            className="secondary-button"
            aria-expanded={showPrincipals}
            onClick={() => {
              if (showPrincipals) setShowPrincipals(false);
              else void loadPrincipals();
            }}
          >
            {showPrincipals ? 'Hide agent access' : 'Manage agent access'}
          </button>
          {showPrincipals && principals && (
            <div className="facebook-engagement-principal-list">
              <small>
                Page-specific permissions only. Provider permission must also be verified before
                tools can act.
              </small>
              {principals.length === 0 && (
                <p>No active API keys or connected applications available.</p>
              )}
              {principals.map((principal) => (
                <div className="api-key-row" key={`${principal.kind}:${principal.id}`}>
                  <div>
                    <strong>{principal.label}</strong>
                    <small>
                      {principal.kind === 'api-key' ? 'API key' : 'Connected application'}
                    </small>
                  </div>
                  {editing?.principal.id === principal.id &&
                  editing.principal.kind === principal.kind ? (
                    <div className="api-key-permission-editor">
                      <div className="capability-grid">
                        {capabilityChoices.map((choice) => (
                          <button
                            type="button"
                            key={choice.value}
                            className={`capability-button ${editing.capabilities.includes(choice.value) ? 'active' : ''}`}
                            aria-pressed={editing.capabilities.includes(choice.value)}
                            disabled={savingGrants}
                            onClick={() => {
                              setEditing(
                                (current) =>
                                  current && {
                                    ...current,
                                    capabilities: current.capabilities.includes(choice.value)
                                      ? current.capabilities.filter(
                                          (value) => value !== choice.value,
                                        )
                                      : [...current.capabilities, choice.value],
                                  },
                              );
                            }}
                          >
                            {choice.label}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="primary-button"
                        disabled={savingGrants}
                        onClick={() => void saveGrants()}
                      >
                        {savingGrants ? 'Saving…' : 'Save access'}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={savingGrants}
                        onClick={() => {
                          setEditing(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setEditing({ principal, capabilities: [...principal.capabilities] });
                      }}
                    >
                      Edit Page access
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      <LiveRegion message={announcement} />
    </div>
  );
}
