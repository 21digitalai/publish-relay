import { useEffect, useRef, useState } from 'react';

export function LiveRegion({ message }: { message: string | null }) {
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message ?? ''}
    </p>
  );
}

export interface PublicationToast {
  id: string;
  state: 'published' | 'failed';
  provider: string;
  account: string;
  href: string;
  external: boolean;
}

function PublicationToastCard({
  toast,
  onDismiss,
}: {
  toast: PublicationToast;
  onDismiss: (id: string) => void;
}) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(6_000);
  useEffect(() => {
    if (toast.state !== 'published' || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(() => {
      onDismiss(toast.id);
    }, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [onDismiss, paused, toast.id, toast.state]);
  const headline =
    toast.state === 'published' ? `Published on ${toast.provider}` : 'Post needs attention';
  return (
    <article
      className={`publication-toast ${toast.state}`}
      onMouseEnter={() => {
        setPaused(true);
      }}
      onMouseLeave={() => {
        setPaused(false);
      }}
      onFocus={() => {
        setPaused(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <span className="publication-toast-icon" aria-hidden="true">
        {toast.state === 'published' ? '✓' : '!'}
      </span>
      <div className="publication-toast-body">
        <strong>{headline}</strong>
        {toast.account && <span>{toast.account}</span>}
        <a
          className="publication-toast-action"
          href={toast.href}
          {...(toast.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          onClick={() => {
            onDismiss(toast.id);
          }}
        >
          {toast.external ? 'View post' : 'View details'}
        </a>
      </div>
      <button
        className="publication-toast-dismiss"
        type="button"
        aria-label="Dismiss publication notification"
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        ×
      </button>
    </article>
  );
}

export function PublicationToastStack({
  toasts,
  onDismiss,
}: {
  toasts: PublicationToast[];
  onDismiss: (id: string) => void;
}) {
  const latest = toasts[0];
  return (
    <>
      <LiveRegion
        key={latest?.id}
        message={latest?.state === 'published' ? `Published on ${latest.provider}` : null}
      />
      {latest?.state === 'failed' && (
        <p className="sr-only" role="alert">
          Post needs attention
        </p>
      )}
      <div className="publication-toast-stack" aria-label="Publication notifications">
        {toasts.map((toast) => (
          <PublicationToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </div>
    </>
  );
}
