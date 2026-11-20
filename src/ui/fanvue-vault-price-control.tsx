import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DefaultsSelect } from './defaults-select.js';
import { LiveRegion } from './feedback.js';
import {
  mergeFanvueMedia,
  normalizeFanvueUsdPrice,
  type FanvueVaultFolder,
  type FanvueVaultMedia,
  type FanvueVaultPriceAdapter,
} from './fanvue-vault-price-model.js';

export function FanvueVaultPriceControl({
  accountId,
  accountName,
  adapter,
}: {
  accountId: string;
  accountName: string;
  adapter: FanvueVaultPriceAdapter;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="fanvue-vault-price-open secondary-button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Vault media prices
      </button>
      {open &&
        createPortal(
          <FanvueVaultPriceDialog
            accountId={accountId}
            accountName={accountName}
            adapter={adapter}
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

function FanvueVaultPriceDialog({
  accountId,
  accountName,
  adapter,
  onClose,
}: {
  accountId: string;
  accountName: string;
  adapter: FanvueVaultPriceAdapter;
  onClose: () => void;
}) {
  const [folders, setFolders] = useState<FanvueVaultFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [media, setMedia] = useState<FanvueVaultMedia[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [canonicalPrices, setCanonicalPrices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [savedRows, setSavedRows] = useState<Set<string>>(new Set());
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [appending, setAppending] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [previewUnavailable, setPreviewUnavailable] = useState<Set<string>>(new Set());
  const [previewRefreshing, setPreviewRefreshing] = useState<Set<string>>(new Set());
  const [previewAttempts, setPreviewAttempts] = useState<Record<string, number>>({});
  const dialogRef = useRef<HTMLElement>(null);
  const requestId = useRef(0);
  const saveControllers = useRef(new Map<string, AbortController>());
  const previewControllers = useRef(new Map<string, AbortController>());
  const scopeRef = useRef({ accountId, generation: 0, mounted: true });
  if (scopeRef.current.accountId !== accountId) {
    scopeRef.current = {
      accountId,
      generation: scopeRef.current.generation + 1,
      mounted: true,
    };
  }

  const dirtyIds = useMemo(
    () =>
      Object.entries(drafts)
        .filter(([mediaId, draft]) => draft !== (canonicalPrices[mediaId] ?? ''))
        .map(([mediaId]) => mediaId),
    [canonicalPrices, drafts],
  );
  const dirty = dirtyIds.length > 0;

  useEffect(() => {
    const activeSaveControllers = saveControllers.current;
    const activePreviewControllers = previewControllers.current;
    scopeRef.current.mounted = true;
    return () => {
      scopeRef.current.mounted = false;
      for (const controller of activeSaveControllers.values()) controller.abort();
      for (const controller of activePreviewControllers.values()) controller.abort();
    };
  }, []);

  useEffect(() => {
    for (const controller of saveControllers.current.values()) controller.abort();
    for (const controller of previewControllers.current.values()) controller.abort();
    saveControllers.current.clear();
    previewControllers.current.clear();
    setDrafts({});
    setCanonicalPrices({});
    setSaving(new Set());
    setSavedRows(new Set());
    setRowErrors({});
    setPreviewUnavailable(new Set());
    setPreviewRefreshing(new Set());
    setPreviewAttempts({});
  }, [accountId]);

  useEffect(() => {
    const controller = new AbortController();
    const id = ++requestId.current;
    setState('loading');
    setLoadError(null);
    setAppendError(null);
    void Promise.all([
      adapter.loadFolders(accountId, controller.signal),
      adapter.loadMedia({ accountId, folderId, cursor: null, signal: controller.signal }),
    ])
      .then(([loadedFolders, page]) => {
        if (id !== requestId.current) return;
        setFolders(loadedFolders);
        setMedia(page.items);
        setCanonicalPrices((current) => {
          const next = { ...current };
          for (const item of page.items) next[item.id] = item.priceUsd ?? '';
          return next;
        });
        setNextCursor(page.nextCursor);
        setState('ready');
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || id !== requestId.current) return;
        setLoadError(reason instanceof Error ? reason.message : 'Vault media could not be loaded.');
        setState('error');
      });
    return () => {
      controller.abort();
    };
  }, [accountId, adapter, folderId, loadAttempt]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (saving.size === 0) {
          if (dirty) setConfirmDiscard(true);
          else onClose();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
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
  }, [dirty, onClose, saving.size]);

  const requestClose = () => {
    if (saving.size > 0) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const save = async (item: FanvueVaultMedia) => {
    const draft = drafts[item.id] ?? canonicalPrices[item.id] ?? item.priceUsd ?? '';
    let normalized: string | null;
    try {
      normalized = normalizeFanvueUsdPrice(draft);
    } catch (reason) {
      setRowErrors((current) => ({
        ...current,
        [item.id]: reason instanceof Error ? reason.message : 'Enter a valid USD amount.',
      }));
      return;
    }
    saveControllers.current.get(item.id)?.abort();
    const controller = new AbortController();
    saveControllers.current.set(item.id, controller);
    const scope = { ...scopeRef.current };
    setSaving((current) => new Set(current).add(item.id));
    setRowErrors((current) => ({ ...current, [item.id]: '' }));
    try {
      const result = await adapter.savePrice({
        accountId,
        mediaId: item.id,
        priceUsd: normalized,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !scopeRef.current.mounted ||
        scope.accountId !== scopeRef.current.accountId ||
        scope.generation !== scopeRef.current.generation
      )
        return;
      setMedia((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, priceUsd: result.priceUsd } : entry,
        ),
      );
      setCanonicalPrices((current) => ({ ...current, [item.id]: result.priceUsd ?? '' }));
      setDrafts((current) => ({ ...current, [item.id]: result.priceUsd ?? '' }));
      setSavedRows((current) => new Set(current).add(item.id));
      setAnnouncement(`Price saved for ${item.name}`);
    } catch (reason) {
      if (controller.signal.aborted || scope.accountId !== scopeRef.current.accountId) return;
      setRowErrors((current) => ({
        ...current,
        [item.id]: reason instanceof Error ? reason.message : 'Price was not saved. Retry.',
      }));
    } finally {
      if (saveControllers.current.get(item.id) === controller)
        saveControllers.current.delete(item.id);
      if (
        scopeRef.current.mounted &&
        scope.accountId === scopeRef.current.accountId &&
        scope.generation === scopeRef.current.generation
      ) {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
  };

  const refreshPreview = async (item: FanvueVaultMedia) => {
    const attempts = previewAttempts[item.id] ?? 0;
    if (attempts >= 2 || previewRefreshing.has(item.id)) return;
    previewControllers.current.get(item.id)?.abort();
    const controller = new AbortController();
    previewControllers.current.set(item.id, controller);
    const scope = { ...scopeRef.current };
    setPreviewRefreshing((current) => new Set(current).add(item.id));
    setPreviewAttempts((current) => ({ ...current, [item.id]: attempts + 1 }));
    try {
      const result = await adapter.refreshPreview({
        accountId,
        mediaId: item.id,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        !scopeRef.current.mounted ||
        scope.accountId !== scopeRef.current.accountId ||
        scope.generation !== scopeRef.current.generation
      )
        return;
      setMedia((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, previewSrc: result.previewSrc } : entry,
        ),
      );
      setPreviewUnavailable((current) => {
        const next = new Set(current);
        if (result.previewSrc?.startsWith('/')) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    } catch {
      if (!controller.signal.aborted && scope.accountId === scopeRef.current.accountId)
        setPreviewUnavailable((current) => new Set(current).add(item.id));
    } finally {
      if (previewControllers.current.get(item.id) === controller)
        previewControllers.current.delete(item.id);
      if (
        scopeRef.current.mounted &&
        scope.accountId === scopeRef.current.accountId &&
        scope.generation === scopeRef.current.generation
      ) {
        setPreviewRefreshing((current) => {
          const next = new Set(current);
          next.delete(item.id);
          return next;
        });
      }
    }
  };

  const loadMore = async () => {
    if (!nextCursor || appending) return;
    const controller = new AbortController();
    const id = requestId.current;
    setAppending(true);
    setAppendError(null);
    try {
      const page = await adapter.loadMedia({
        accountId,
        folderId,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (id !== requestId.current) return;
      setMedia((current) => mergeFanvueMedia(current, page.items));
      setCanonicalPrices((current) => {
        const next = { ...current };
        for (const item of page.items) next[item.id] = item.priceUsd ?? '';
        return next;
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setAppendError(reason instanceof Error ? reason.message : 'More media could not be loaded.');
    } finally {
      setAppending(false);
    }
  };

  return (
    <div
      className="dialog-backdrop fanvue-vault-price-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={dialogRef}
        className="fanvue-vault-price-dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fanvue-vault-price-title"
      >
        <header className="fanvue-vault-price-heading">
          <div>
            <h2 id="fanvue-vault-price-title">Vault media prices · {accountName}</h2>
            <p>
              Set the saved USD price agents can read for this media. A price does not authorize a
              send.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close vault media prices"
            autoFocus
            onClick={requestClose}
            disabled={saving.size > 0}
          >
            ×
          </button>
        </header>
        {state === 'loading' && (
          <div
            className="fanvue-vault-price-skeleton"
            role="status"
            aria-label="Loading vault media"
          >
            {[0, 1, 2].map((key) => (
              <span key={key} />
            ))}
          </div>
        )}
        {state === 'error' && (
          <div className="fanvue-vault-price-state" role="alert">
            <p>{loadError}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                setLoadAttempt((value) => value + 1);
              }}
            >
              Retry
            </button>
          </div>
        )}
        {state === 'ready' && (
          <>
            <div className="fanvue-vault-price-toolbar">
              <DefaultsSelect
                label="Vault folder"
                name="fanvueVaultFolder"
                value={folderId ?? ''}
                options={[
                  ['', 'All folders'],
                  ...folders.map((folder): [string, string] => [folder.id, folder.name]),
                ]}
                onChange={(value) => {
                  setFolderId(value || null);
                }}
              />
            </div>
            {media.length === 0 ? (
              <div className="fanvue-vault-price-state">
                <p>{folderId ? 'No media in this folder.' : 'This account has no vault media.'}</p>
                {folderId && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setFolderId(null);
                    }}
                  >
                    Show all folders
                  </button>
                )}
              </div>
            ) : (
              <ul className="fanvue-vault-price-list">
                {media.map((item) => {
                  const value = drafts[item.id] ?? canonicalPrices[item.id] ?? item.priceUsd ?? '';
                  const changed = value !== (canonicalPrices[item.id] ?? item.priceUsd ?? '');
                  const busy = saving.has(item.id);
                  const error = rowErrors[item.id];
                  return (
                    <li key={item.id} className="fanvue-vault-price-row">
                      <div className="fanvue-vault-price-preview">
                        {item.previewSrc?.startsWith('/') && !previewUnavailable.has(item.id) ? (
                          <img
                            src={item.previewSrc}
                            alt={`Preview of ${item.name}`}
                            loading="lazy"
                            onError={(event) => {
                              event.currentTarget.hidden = true;
                              setPreviewUnavailable((current) => new Set(current).add(item.id));
                            }}
                          />
                        ) : null}
                        <span
                          hidden={
                            Boolean(item.previewSrc?.startsWith('/')) &&
                            !previewUnavailable.has(item.id)
                          }
                        >
                          Preview unavailable
                        </span>
                        {previewUnavailable.has(item.id) && (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={
                              previewRefreshing.has(item.id) || (previewAttempts[item.id] ?? 0) >= 2
                            }
                            onClick={() => void refreshPreview(item)}
                          >
                            {previewRefreshing.has(item.id)
                              ? 'Refreshing…'
                              : (previewAttempts[item.id] ?? 0) >= 2
                                ? 'Preview unavailable'
                                : 'Refresh preview'}
                          </button>
                        )}
                      </div>
                      <div className="fanvue-vault-price-identity">
                        <strong title={item.name}>{item.name}</strong>
                        {item.folderName && <span>{item.folderName}</span>}
                      </div>
                      <label className="fanvue-vault-price-field">
                        <span>USD price for {item.name}</span>
                        <span className="fanvue-vault-price-input">
                          <b aria-hidden="true">$</b>
                          <input
                            inputMode="decimal"
                            value={value}
                            placeholder="Unset"
                            aria-invalid={Boolean(error)}
                            aria-describedby={
                              error ? `fanvue-vault-price-error-${item.id}` : undefined
                            }
                            disabled={busy}
                            onChange={(event) => {
                              setDrafts((current) => ({
                                ...current,
                                [item.id]: event.target.value,
                              }));
                              setSavedRows((current) => {
                                const next = new Set(current);
                                next.delete(item.id);
                                return next;
                              });
                              setRowErrors((current) => ({ ...current, [item.id]: '' }));
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' && changed && !busy) {
                                event.preventDefault();
                                void save(item);
                              }
                            }}
                          />
                        </span>
                      </label>
                      <div className="fanvue-vault-price-action">
                        <button
                          type="button"
                          className="primary-button"
                          disabled={!changed || busy}
                          onClick={() => void save(item)}
                        >
                          {busy ? 'Saving…' : 'Save'}
                        </button>
                        <span className={changed ? 'unsaved' : 'saved'}>
                          {changed
                            ? 'Unsaved'
                            : savedRows.has(item.id)
                              ? '✓ Saved'
                              : item.priceUsd === null
                                ? 'Unset'
                                : 'Saved'}
                        </span>
                      </div>
                      {error && (
                        <p
                          id={`fanvue-vault-price-error-${item.id}`}
                          className="fanvue-vault-price-error"
                          role="alert"
                        >
                          {error}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {appendError && (
              <p className="fanvue-vault-price-append-error" role="alert">
                {appendError}
              </p>
            )}
            {nextCursor && (
              <button
                type="button"
                className="fanvue-vault-price-more secondary-button"
                disabled={appending}
                onClick={() => void loadMore()}
              >
                {appending ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}
        {confirmDiscard && (
          <div className="fanvue-vault-price-discard" role="alert">
            <p>Discard unsaved price changes?</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setConfirmDiscard(false);
                }}
              >
                Keep editing
              </button>
              <button type="button" className="danger-button" onClick={onClose}>
                Discard changes
              </button>
            </div>
          </div>
        )}
        <LiveRegion message={announcement} />
      </section>
    </div>
  );
}
