import { useState } from 'react';

import { getCsrfToken } from './posting-adapter-connection.js';

interface WorkspaceChoice {
  id: string;
  name: string;
  role: string;
}

async function responseData<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json()) as { data: T | null; error: string | null };
  if (!response.ok || !body.data) throw new Error(body.error ?? fallback);
  return body.data;
}

async function loadExposureSelections(accountId: string) {
  const [workspaceResponse, firstGrantResponse] = await Promise.all([
    fetch('/api/workspaces'),
    fetch(`/api/provider-accounts/${accountId}/exposures`),
  ]);
  const workspaces = await responseData<{ workspaces: WorkspaceChoice[] }>(
    workspaceResponse,
    'Workspaces could not be loaded',
  );
  let grantPage = await responseData<{ workspaceIds: string[]; nextCursor: string | null }>(
    firstGrantResponse,
    'Page sharing could not be loaded',
  );
  const selected = new Set(grantPage.workspaceIds);
  while (grantPage.nextCursor) {
    const response = await fetch(
      `/api/provider-accounts/${accountId}/exposures?cursor=${encodeURIComponent(grantPage.nextCursor)}`,
    );
    grantPage = await responseData<{ workspaceIds: string[]; nextCursor: string | null }>(
      response,
      'Page sharing could not be loaded',
    );
    grantPage.workspaceIds.forEach((id) => selected.add(id));
  }
  return { workspaces: workspaces.workspaces, selected };
}

export function FacebookPageExposureControl({
  accountId,
  accountName,
  originWorkspaceId,
}: {
  accountId: string;
  accountName: string;
  originWorkspaceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const openChoices = async (retry = false) => {
    if (open && !retry) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setLoading(true);
    setError(null);
    setWorkspaces([]);
    try {
      const choices = await loadExposureSelections(accountId);
      setWorkspaces(
        choices.workspaces.filter(
          (workspace) => workspace.id !== originWorkspaceId && workspace.role === 'owner',
        ),
      );
      setSelected(choices.selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Page sharing could not be loaded');
    } finally {
      setLoading(false);
    }
  };

  const updateChoice = async (workspace: WorkspaceChoice) => {
    if (savingId) return;
    const expose = !selected.has(workspace.id);
    setSavingId(workspace.id);
    setError(null);
    setAnnouncement(null);
    try {
      const response = await fetch(
        `/api/provider-accounts/${accountId}/exposures/${workspace.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
          body: JSON.stringify({ expose }),
        },
      );
      await responseData(response, 'Page sharing could not be changed');
      setSelected((current) => {
        const next = new Set(current);
        if (expose) next.add(workspace.id);
        else next.delete(workspace.id);
        return next;
      });
      setAnnouncement(`${accountName} ${expose ? 'shown in' : 'hidden from'} ${workspace.name}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Page sharing could not be changed');
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="page-exposure-control">
      <button
        type="button"
        className="secondary-button"
        aria-expanded={open}
        onClick={() => void openChoices()}
      >
        Share with workspaces
      </button>
      {open && (
        <div className="page-exposure-panel">
          <p>Show {accountName} in these workspaces. The Page uses its existing connection.</p>
          {loading && <p role="status">Loading workspaces…</p>}
          {!loading && !error && workspaces.length === 0 && (
            <p>No other workspaces you own are available.</p>
          )}
          {!loading && workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="page-exposure-choice"
              role="checkbox"
              aria-checked={selected.has(workspace.id)}
              disabled={savingId !== null}
              onClick={() => void updateChoice(workspace)}
            >
              <span className="page-exposure-check" aria-hidden="true">
                {selected.has(workspace.id) ? '✓' : ''}
              </span>
              <span>{workspace.name}</span>
              {savingId === workspace.id && <span className="sr-only">Saving</span>}
            </button>
          ))}
          {error && <p className="page-exposure-error" role="alert">{error}</p>}
          {error && workspaces.length === 0 && (
            <button type="button" className="secondary-button" onClick={() => void openChoices(true)}>
              Try again
            </button>
          )}
          <span className="sr-only" aria-live="polite">{announcement}</span>
        </div>
      )}
    </div>
  );
}
