import { useState } from 'react';

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
  const selected = options.find(([option]) => option === value)?.[1] ?? value;
  return (
    <div className="defaults-field">
      <span>{label}</span>
      <input name={name} type="hidden" value={value} />
      <button
        type="button"
        className="defaults-select-trigger"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {selected} <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="defaults-select-menu" role="listbox" aria-label={label}>
          {options.map(([option, text]) => (
            <button
              type="button"
              role="option"
              aria-selected={option === value}
              className={`defaults-select-option${option === value ? ' selected' : ''}`}
              key={option}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
