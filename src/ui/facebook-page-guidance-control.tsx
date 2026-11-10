import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getCsrfToken } from './posting-adapter-connection.js';

interface Guidance {
  profile: string;
  dmGuidance: string;
  commentGuidance: string;
}

const EMPTY: Guidance = { profile: '', dmGuidance: '', commentGuidance: '' };
const LIMIT = 10_000;
const FIELDS: { key: keyof Guidance; label: string; hint: string }[] = [
  {
    key: 'profile',
    label: 'Shared Page profile',
    hint: 'Facts and background shared by both channels. Do not invent missing facts.',
  },
  {
    key: 'dmGuidance',
    label: 'DM guidance',
    hint: 'Optional private-message instructions. Blank uses the DM baseline plus the shared profile.',
  },
  {
    key: 'commentGuidance',
    label: 'Public-comment guidance',
    hint: 'Optional public-reply instructions. Blank uses the comment baseline plus the shared profile.',
  },
];

export function FacebookPageGuidanceControl({
  accountId,
  accountName,
}: {
  accountId: string;
  accountName: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="facebook-guidance-open secondary-button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Page guidance
      </button>
      {open &&
        createPortal(
          <GuidanceDialog
            accountId={accountId}
            accountName={accountName}
            onClose={() => {
              setOpen(false);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
          />,
          document.body,
        )}
    </>
  );
}

function GuidanceDialog({
  accountId,
  accountName,
  onClose,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
}) {
  const [value, setValue] = useState<Guidance>(EMPTY);
  const [saved, setSaved] = useState<Guidance>(EMPTY);
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [activeField, setActiveField] = useState<keyof Guidance>('profile');
  const dialog = useRef<HTMLElement>(null);
  const endpoint = `/api/facebook-pages/${encodeURIComponent(accountId)}/guidance`;
  const dirty = FIELDS.some(({ key }) => value[key] !== saved[key]);
  const overLimit = FIELDS.some(({ key }) => Array.from(value[key]).length > LIMIT);

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Page guidance could not be loaded. Retry.');
        return response.json() as Promise<{ data: Guidance }>;
      })
      .then(({ data }) => {
        if (!active) return;
        setValue(data);
        setSaved(data);
        setState('ready');
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Page guidance could not be loaded.');
        setState('error');
      });
    return () => {
      active = false;
    };
  }, [endpoint, loadAttempt]);

  const requestClose = () => {
    if (state === 'saving') return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)'),
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (
        event.shiftKey &&
        (document.activeElement === first || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !root.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  });

  const save = async () => {
    if (state !== 'ready' || overLimit || !dirty) return;
    setState('saving');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify(value),
      });
      if (!response.ok) throw new Error('Page guidance was not saved. Retry.');
      const result = (await response.json()) as { data: Guidance };
      setSaved(result.data);
      setValue(result.data);
      setNotice('Page guidance saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Page guidance was not saved.');
    } finally {
      setState('ready');
    }
  };

  return (
    <div className="dialog-backdrop facebook-guidance-backdrop" role="presentation">
      <section
        ref={dialog}
        className="facebook-guidance-dialog fanvue-guidance-dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="facebook-guidance-title"
      >
        <div className="facebook-guidance-heading fanvue-guidance-heading">
          <h2 id="facebook-guidance-title">Page guidance · {accountName}</h2>
          <button
            type="button"
            className="facebook-guidance-close icon-button"
            aria-label="Close Page guidance"
            autoFocus
            onClick={requestClose}
            disabled={state === 'saving'}
          >
            ×
          </button>
        </div>
        <p>
          Context for authorized agents. Relay stores it with this Page; it does not send it to
          Facebook or automatically answer people.
        </p>
        <p className="facebook-guidance-state" role="status" aria-live="polite">
          {state === 'saving' ? 'Saving' : error ? 'Error' : dirty ? 'Unsaved changes' : 'Saved'}
        </p>
        {state === 'loading' && <p role="status">Loading Page guidance…</p>}
        {state === 'error' && (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              className="facebook-guidance-retry secondary-button"
              onClick={() => {
                setState('loading');
                setLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Retry
            </button>
          </p>
        )}
        {(state === 'ready' || state === 'saving') && (
          <>
            <div
              className="facebook-guidance-tabs"
              role="tablist"
              aria-label="Page guidance section"
            >
              {FIELDS.map(({ key, label }, index) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`facebook-guidance-tab-${key}-${accountId}`}
                  aria-selected={activeField === key}
                  aria-controls={`facebook-guidance-panel-${key}-${accountId}`}
                  tabIndex={activeField === key ? 0 : -1}
                  onClick={() => {
                    setActiveField(key);
                  }}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? FIELDS.length - 1
                          : (index + (event.key === 'ArrowRight' ? 1 : -1) + FIELDS.length) %
                            FIELDS.length;
                    const field = FIELDS[next];
                    if (!field) return;
                    setActiveField(field.key);
                    dialog.current
                      ?.querySelector<HTMLElement>(
                        `#facebook-guidance-tab-${field.key}-${accountId}`,
                      )
                      ?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {FIELDS.filter(({ key }) => key === activeField).map(({ key, label, hint }) => (
              <div
                className="facebook-guidance-field"
                role="tabpanel"
                id={`facebook-guidance-panel-${key}-${accountId}`}
                aria-labelledby={`facebook-guidance-tab-${key}-${accountId}`}
                key={key}
              >
                <label htmlFor={`facebook-guidance-${key}-${accountId}`}>{label}</label>
                <p className="facebook-guidance-hint">{hint}</p>
                <textarea
                  id={`facebook-guidance-${key}-${accountId}`}
                  className="facebook-guidance-editor"
                  rows={key === 'profile' ? 7 : 5}
                  value={value[key]}
                  disabled={state === 'saving'}
                  onChange={(event) => {
                    setValue({ ...value, [key]: event.target.value });
                    setNotice(null);
                    setConfirmDiscard(false);
                  }}
                />
                <span aria-live="polite">
                  {Array.from(value[key]).length.toLocaleString()} / {LIMIT.toLocaleString()}{' '}
                  characters
                </span>
                {Array.from(value[key]).length > LIMIT && (
                  <p role="alert">{label} must be at most 10,000 characters.</p>
                )}
              </div>
            ))}
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="facebook-guidance-cancel secondary-button"
                onClick={requestClose}
                disabled={state === 'saving'}
              >
                Close
              </button>
              <button
                type="button"
                className="facebook-guidance-save primary-button"
                onClick={() => void save()}
                disabled={state === 'saving' || overLimit || !dirty}
              >
                {state === 'saving' ? 'Saving…' : 'Save Page guidance'}
              </button>
            </div>
            {confirmDiscard && (
              <div className="facebook-guidance-discard fanvue-guidance-discard" role="alert">
                <p>Discard unsaved Page guidance changes?</p>
                <div className="dialog-actions">
                  <button
                    type="button"
                    className="facebook-guidance-keep secondary-button"
                    onClick={() => {
                      setConfirmDiscard(false);
                    }}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="facebook-guidance-discard-action danger-button"
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
