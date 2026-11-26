import { useCallback, useEffect, useState } from 'react';

import { LiveRegion } from './feedback.js';

type GrantState = 'granted' | 'missing' | 'declined';
type PermissionState = Record<'instagram_basic' | 'instagram_manage_comments', GrantState>;
type CapabilityStatus = 'available' | 'needs_permission' | 'declined' | 'unknown';

interface CapabilityRow {
  label: string;
  detail: string;
  state: CapabilityStatus;
}

function stateLabel(state: CapabilityStatus): string {
  if (state === 'available') return 'Verified';
  if (state === 'needs_permission') return 'Permission needed';
  if (state === 'declined') return 'Declined';
  return 'Unknown';
}

function capabilityState(
  status: PermissionState | null,
  permission: keyof PermissionState,
): CapabilityStatus {
  if (!status) return 'unknown';
  if (status[permission] === 'granted') return 'available';
  if (status[permission] === 'declined') return 'declined';
  return 'needs_permission';
}

export function InstagramUnifiedCapabilityControl({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [permissions, setPermissions] = useState<PermissionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const loadPermissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/provider-accounts/${accountId}/instagram-unified/status`, {
        headers: { accept: 'application/json' },
      });
      const result = (await response.json()) as {
        data: PermissionState | null;
        error: string | null;
      };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Capability status unavailable');
      setPermissions(result.data);
      setAnnouncement(`Verified capability status refreshed for ${accountName}.`);
    } catch (cause) {
      setPermissions(null);
      setError(cause instanceof Error ? cause.message : 'Capability status unavailable');
    } finally {
      setLoading(false);
    }
  }, [accountId, accountName]);

  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);

  const rows: CapabilityRow[] = [
    {
      label: 'Posts and media',
      detail: 'Read-only access to posts owned by this Unified Instagram account.',
      state: capabilityState(permissions, 'instagram_basic'),
    },
    {
      label: 'Comments and replies',
      detail: 'Read-only access to comments after the provider grant is verified.',
      state: capabilityState(permissions, 'instagram_manage_comments'),
    },
    {
      label: 'Conversations and messages',
      detail: 'Available only after a separate messaging grant is verified when used.',
      state: permissions ? 'needs_permission' : 'unknown',
    },
  ];

  return (
    <section
      className="instagram-unified-capability-control"
      aria-label="Unified Instagram capabilities"
    >
      <div className="instagram-unified-capability-heading">
        <div>
          <strong>Unified Instagram access</strong>
          <small>Live provider checks; Connected does not prove permissions.</small>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void loadPermissions()}
          disabled={loading}
        >
          {loading ? 'Checking…' : 'Refresh status'}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="instagram-unified-capability-list">
        {rows.map((row) => (
          <div className="instagram-unified-capability-row" key={row.label}>
            <div>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </div>
            <span className={`status-badge ${row.state === 'available' ? 'success' : 'warning'}`}>
              {stateLabel(row.state)}
            </span>
          </div>
        ))}
      </div>
      <small className="instagram-unified-capability-note">
        Missing or declined access requires a reviewed reconnect. No send or reply controls are
        enabled here.
      </small>
      <LiveRegion message={announcement} />
    </section>
  );
}
