import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface CalendarFilterOption {
  id: string;
  label: string;
  detail?: string;
  group?: string;
  state?: string;
}

interface CalendarCheckboxFilterProps {
  title: string;
  summary: string;
  options: CalendarFilterOption[];
  selected: string[] | null;
  onChange: (selected: string[] | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function positionMenu(trigger: HTMLElement, menu: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  const useAbove = below < 220 && above > below;
  const available = Math.max(120, (useAbove ? above : below) - 20);
  menu.style.width = `${String(width)}px`;
  menu.style.left = `${String(left)}px`;
  menu.style.maxHeight = `${String(available)}px`;
  if (useAbove) {
    menu.style.top = 'auto';
    menu.style.bottom = `${String(window.innerHeight - rect.top + 6)}px`;
  } else {
    menu.style.bottom = 'auto';
    menu.style.top = `${String(rect.bottom + 6)}px`;
  }
}

export function CalendarCheckboxFilter({
  title,
  summary,
  options,
  selected,
  onChange,
  open,
  onOpenChange,
  loading,
  error,
  onRetry,
}: CalendarCheckboxFilterProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [positioned, setPositioned] = useState(false);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const reposition = () => {
      if (trigger.current && menu.current) positionMenu(trigger.current, menu.current);
      setPositioned(true);
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      setPositioned(false);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (
        trigger.current?.contains(event.target as Node) ||
        menu.current?.contains(event.target as Node)
      )
        return;
      onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onOpenChange(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);
  let currentGroup: string | undefined;
  const rows = options.map((option) => {
    const heading = option.group && option.group !== currentGroup ? option.group : null;
    currentGroup = option.group;
    return (
      <div key={option.id}>
        {heading && <div className="calendar-filter-group">{heading}</div>}
        <label className="calendar-filter-row">
          <input
            type="checkbox"
            aria-label={[option.group, option.label, option.detail].filter(Boolean).join(' · ')}
            checked={selected === null || selected.includes(option.id)}
            onChange={(event) => {
              const next = selected ?? options.map((item) => item.id);
              const changed = event.target.checked
                ? [...next, option.id]
                : next.filter((id) => id !== option.id);
              onChange(changed.length === options.length ? null : changed);
            }}
          />
          <span>
            <strong>
              {option.state && (
                <span className={`job-status ${option.state}`} aria-hidden="true">
                  ●
                </span>
              )}
              {option.label}
            </strong>
            {option.detail && <small>{option.detail}</small>}
          </span>
        </label>
      </div>
    );
  });
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="filter-button"
        aria-label={`${title}: ${summary}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        {summary} <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={id}
            className="calendar-filter-menu"
            style={{ visibility: positioned ? 'visible' : 'hidden' }}
          >
            <div className="calendar-filter-head">
              <strong>{title}</strong>
              <button
                type="button"
                onClick={() => {
                  onChange(null);
                }}
                disabled={Boolean(loading) || Boolean(error)}
              >
                Select all
              </button>
            </div>
            {loading ? (
              <p role="status">Loading accounts…</p>
            ) : error ? (
              <div role="alert">
                <p>{error}</p>
                <button type="button" onClick={onRetry}>
                  Try again
                </button>
              </div>
            ) : (
              <div role="group" aria-label={title}>
                {rows}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
