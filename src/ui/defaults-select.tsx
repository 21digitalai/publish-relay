import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MENU_GAP = 4;
const VIEWPORT_PADDING = 8;
const ESTIMATED_OPTION_HEIGHT = 38;
const MENU_VERTICAL_PADDING = 10;

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
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<React.CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listboxId = useId();
  const selected = options.find(([option]) => option === value)?.[1] ?? value;

  useEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const estimatedHeight = options.length * ESTIMATED_OPTION_HEIGHT + MENU_VERTICAL_PADDING;
      const availableBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_PADDING;
      const availableAbove = rect.top - MENU_GAP - VIEWPORT_PADDING;
      const openAbove = availableBelow < estimatedHeight && availableAbove > availableBelow;
      const availableHeight = Math.max(openAbove ? availableAbove : availableBelow, 0);
      const menuHeight = Math.min(estimatedHeight, availableHeight);
      setMenuPosition({
        left: rect.left,
        top: openAbove ? rect.top - menuHeight - MENU_GAP : rect.bottom + MENU_GAP,
        width: rect.width,
        maxHeight: availableHeight,
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

  useEffect(() => {
    if (open) optionRefs.current[activeIndex]?.focus();
  }, [activeIndex, open]);

  const openMenu = (direction: 'first' | 'last' | 'selected' = 'selected') => {
    const selectedIndex = options.findIndex(([option]) => option === value);
    setActiveIndex(
      direction === 'first'
        ? 0
        : direction === 'last'
          ? options.length - 1
          : Math.max(selectedIndex, 0),
    );
    setOpen(true);
  };

  const moveActiveOption = (offset: number) => {
    setActiveIndex((current) => (current + offset + options.length) % options.length);
  };

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
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu('first');
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            openMenu('last');
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
            {options.map(([option, text], index) => (
              <button
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
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
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveActiveOption(1);
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveActiveOption(-1);
                  }
                  if (event.key === 'Home') {
                    event.preventDefault();
                    setActiveIndex(0);
                  }
                  if (event.key === 'End') {
                    event.preventDefault();
                    setActiveIndex(options.length - 1);
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
