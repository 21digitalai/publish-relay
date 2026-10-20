import { useEffect, useState } from 'react';

import { DefaultsSelect } from './defaults-select.js';
import { ConfirmationDialog } from './confirmation-dialog.js';

type EvidenceSource = 'provider_dashboard' | 'provider_support' | 'provider_api';
type FailureFinding = 'provider_rejected' | 'verified_absent';

export function SnapchatStoryResolution({
  jobId,
  attemptId,
  providerRequestId,
  csrfToken,
  onResolved,
}: {
  jobId: string;
  attemptId: string;
  providerRequestId: string;
  csrfToken: string;
  onResolved: () => Promise<void>;
}) {
  const [canManage, setCanManage] = useState(false);
  const [source, setSource] = useState<EvidenceSource | ''>('');
  const [finding, setFinding] = useState<FailureFinding | ''>('');
  const [reference, setReference] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth/session', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const envelope = (await response.json()) as {
          data?: { workspace?: { role?: string } };
        };
        if (!controller.signal.aborted)
          setCanManage(['owner', 'admin'].includes(envelope.data?.workspace?.role ?? ''));
      })
      .catch(() => {
        // The server remains the authority. No action is offered without a verified role.
      });
    return () => {
      controller.abort();
    };
  }, []);

  if (!canManage) return null;
  const ready = source !== '' && finding !== '' && reference.trim().length >= 8;
  const resolve = async () => {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/workflow/jobs/${encodeURIComponent(jobId)}/snapchat-story-resolution`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({
            outcome: 'failed',
            attemptId,
            providerRequestId,
            source,
            finding,
            reference: reference.trim(),
          }),
        },
      );
      const result = (await response.json()) as { data?: { outcome: string }; error?: string };
      if (!response.ok || result.data?.outcome !== 'failed')
        throw new Error(result.error ?? 'Story outcome could not be resolved.');
      await onResolved();
      setConfirming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Story outcome could not be resolved.');
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="story-resolution-form" aria-label="Resolve verified Story failure">
      <h3>Verified provider failure</h3>
      <p>
        Only record failure when Snapchat confirms rejection or absence. A request reference alone
        is not proof.
      </p>
      <DefaultsSelect
        label="Evidence source"
        name="story-evidence-source"
        value={source}
        options={[
          ['', 'Choose source'],
          ['provider_dashboard', 'Snapchat dashboard'],
          ['provider_support', 'Snapchat support'],
          ['provider_api', 'Snapchat API'],
        ]}
        onChange={(value) => {
          setSource(value as EvidenceSource | '');
        }}
      />
      <DefaultsSelect
        label="Provider finding"
        name="story-failure-finding"
        value={finding}
        options={[
          ['', 'Choose finding'],
          ['provider_rejected', 'Snapchat rejected the Story'],
          ['verified_absent', 'Snapchat verified the Story is absent'],
        ]}
        onChange={(value) => {
          setFinding(value as FailureFinding | '');
        }}
      />
      <label className="field-label">
        Provider evidence reference
        <input
          className="text-input"
          type="text"
          value={reference}
          maxLength={500}
          onChange={(event) => {
            setReference(event.target.value);
          }}
          placeholder="Support case or dashboard evidence"
        />
      </label>
      {reference.length > 0 && reference.trim().length < 8 && (
        <p className="inline-validation" role="alert">
          Enter at least 8 characters of provider evidence.
        </p>
      )}
      <button
        className="secondary-button"
        type="button"
        disabled={!ready || saving}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Record verified failure
      </button>
      {error && (
        <p className="mutation-error" role="alert">
          {error}
        </p>
      )}
      {confirming && (
        <ConfirmationDialog
          titleId="story-failure-confirm-title"
          title="Mark this Story attempt failed?"
          description="This records the supplied Snapchat evidence and ends the unknown outcome. It does not retry or publish a Story."
          cancelLabel="Keep Needs attention"
          confirmLabel={saving ? 'Recording…' : 'Confirm verified failure'}
          confirmTone="danger"
          disabled={saving}
          onCancel={() => {
            setConfirming(false);
          }}
          onConfirm={() => {
            void resolve();
          }}
        />
      )}
    </section>
  );
}
