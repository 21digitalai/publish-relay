import { useEffect, useState } from 'react';

import { getCsrfToken } from './posting-adapter-connection.js';

const LIMIT = 10_000;

export function FanvueGuidanceControl({ accountId }: { accountId: string }) {
  const [guidance, setGuidance] = useState('');
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const endpoint = `/api/fanvue/accounts/${encodeURIComponent(accountId)}/guidance`;

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Agent guidance could not be loaded. Retry.');
        return response.json() as Promise<{ data: { guidance: string } }>;
      })
      .then((result) => {
        if (!active) return;
        setGuidance(result.data.guidance);
        setSaved(result.data.guidance);
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Agent guidance could not be loaded.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, [endpoint, loadAttempt]);

  const count = Array.from(guidance).length;
  const save = async () => {
    if (count > LIMIT || state !== 'ready') return;
    setState('saving');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ guidance }),
      });
      if (!response.ok) throw new Error('Agent guidance was not saved. Retry.');
      const result = (await response.json()) as { data: { guidance: string } };
      setSaved(result.data.guidance);
      setGuidance(result.data.guidance);
      setNotice('Agent guidance saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Agent guidance was not saved.');
    } finally {
      setState('ready');
    }
  };

  return (
    <section className="fanvue-guidance-control" aria-label="Agent guidance">
      <label htmlFor={`fanvue-guidance-${accountId}`}>Agent guidance</label>
      <p>
        Context for agents managing this account. Relay does not enforce it or send it to Fanvue.
      </p>
      {state === 'loading' ? <p role="status">Loading guidance…</p> : null}
      {state === 'error' ? (
        <p role="alert">
          {error}{' '}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setState('loading');
              setError(null);
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            Retry
          </button>
        </p>
      ) : null}
      {state !== 'loading' && state !== 'error' ? (
        <>
          <textarea
            id={`fanvue-guidance-${accountId}`}
            value={guidance}
            rows={6}
            onChange={(event) => {
              setGuidance(event.target.value);
              setNotice(null);
            }}
            disabled={state === 'saving'}
          />
          <div className="fanvue-guidance-actions">
            <span aria-live="polite">
              {count.toLocaleString()} / {LIMIT.toLocaleString()} characters
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={state === 'saving' || count > LIMIT || guidance === saved}
              onClick={() => {
                void save();
              }}
            >
              {state === 'saving' ? 'Saving…' : 'Save guidance'}
            </button>
          </div>
          {count > LIMIT ? <p role="alert">Guidance must be at most 10,000 characters.</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
        </>
      ) : null}
    </section>
  );
}
