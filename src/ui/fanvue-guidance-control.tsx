import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getCsrfToken } from './posting-adapter-connection.js';

const LIMIT = 10_000;

export function FanvueGuidanceControl({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="secondary-button fanvue-guidance-open"
        onClick={() => {
          setOpen(true);
        }}
      >
        DM guidance
      </button>
      {open &&
        createPortal(
          <FanvueGuidanceDialog
            accountId={accountId}
            accountName={accountName}
            onClose={() => {
              setOpen(false);
              requestAnimationFrame(() => triggerRef.current?.focus());
            }}
          />,
          document.body,
        )}
    </>
  );
}

function FanvueGuidanceDialog({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
}) {
  const [guidance, setGuidance] = useState('');
  const [saved, setSaved] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const endpoint = `/api/fanvue/accounts/${encodeURIComponent(accountId)}/guidance`;
  const dirty = guidance !== saved;

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('DM guidance could not be loaded. Retry.');
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
        setError(reason instanceof Error ? reason.message : 'DM guidance could not be loaded.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, [endpoint, loadAttempt]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (state !== 'saving') {
          if (dirty) setConfirmDiscard(true);
          else onClose();
        }
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)'),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [dirty, onClose, state]);

  const count = Array.from(guidance).length;
  const requestClose = () => {
    if (state === 'saving') return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
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
      if (!response.ok) throw new Error('DM guidance was not saved. Retry.');
      const result = (await response.json()) as { data: { guidance: string } };
      setSaved(result.data.guidance);
      setGuidance(result.data.guidance);
      setNotice('DM guidance saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'DM guidance was not saved.');
    } finally {
      setState('ready');
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="fanvue-guidance-dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fanvue-guidance-title"
      >
        <div className="fanvue-guidance-heading">
          <h2 id="fanvue-guidance-title">DM guidance · {accountName}</h2>
          <button
            type="button"
            className="fanvue-guidance-close icon-button"
            aria-label="Close DM guidance"
            autoFocus
            onClick={requestClose}
            disabled={state === 'saving'}
          >
            ×
          </button>
        </div>
        <p>
          Context for agents messaging this account. Relay does not enforce it or send it to Fanvue.
        </p>
        {state === 'loading' && <p role="status">Loading DM guidance…</p>}
        {state === 'error' && (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              className="fanvue-guidance-retry secondary-button"
              onClick={() => {
                setError(null);
                setState('loading');
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </button>
          </p>
        )}
        {state !== 'loading' && state !== 'error' && (
          <>
            <label htmlFor={`fanvue-guidance-${accountId}`}>DM guidance</label>
            <textarea
              className="fanvue-guidance-editor"
              id={`fanvue-guidance-${accountId}`}
              value={guidance}
              rows={10}
              onChange={(event) => {
                setGuidance(event.target.value);
                setNotice(null);
                setConfirmDiscard(false);
              }}
              disabled={state === 'saving'}
            />
            <span aria-live="polite">
              {count.toLocaleString()} / {LIMIT.toLocaleString()} characters
            </span>
            {count > LIMIT && <p role="alert">DM guidance must be at most 10,000 characters.</p>}
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="fanvue-guidance-cancel secondary-button"
                onClick={requestClose}
                disabled={state === 'saving'}
              >
                Close
              </button>
              <button
                type="button"
                className="fanvue-guidance-save primary-button"
                disabled={state === 'saving' || count > LIMIT || !dirty}
                onClick={() => void save()}
              >
                {state === 'saving' ? 'Saving…' : 'Save DM guidance'}
              </button>
            </div>
            {confirmDiscard && (
              <div className="fanvue-guidance-discard" role="alert">
                <p>Discard unsaved DM guidance changes?</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="fanvue-guidance-keep secondary-button"
                    onClick={() => {
                      setConfirmDiscard(false);
                    }}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="fanvue-guidance-discard-action danger-button"
                    onClick={onClose}
                  >
                    Discard changes
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
