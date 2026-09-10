import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function DefaultsSelect({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find(([option]) => option === value)?.[1] ?? value;

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const estimatedHeight = options.length * 38 + 10;
      const openAbove =
        rect.bottom + estimatedHeight > window.innerHeight && rect.top > estimatedHeight;
      setMenuPosition({
        left: rect.left,
        top: openAbove ? rect.top - estimatedHeight - 4 : rect.bottom + 4,
        width: rect.width,
      });
    };
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target))
        setOpen(false);
    };
    positionMenu();
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
      document.removeEventListener('pointerdown', closeOnOutsideClick);
    };
  }, [open, options.length]);

  const selectOption = (option: string) => {
    onChange(option);
    setOpen(false);
    triggerRef.current?.focus();
  };
  return (
    <div className="defaults-field">
      <span>{label}</span>
      <input name={name} type="hidden" value={value} />
      <button
        ref={triggerRef}
        type="button"
        className="defaults-select-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {selected} <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={listboxId}
            className="defaults-select-menu"
            role="listbox"
            aria-label={label}
            style={menuPosition}
          >
            {options.map(([option, text]) => (
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                className={`defaults-select-option${option === value ? ' selected' : ''}`}
                key={option}
                onClick={() => {
                  selectOption(option);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }
                }}
              >
                {text}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
