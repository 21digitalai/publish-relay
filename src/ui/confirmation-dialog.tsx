import { useEffect, useRef, type ReactNode } from 'react';

export function ConfirmationDialog({
  titleId,
  title,
  description,
  icon,
  cancelLabel,
  confirmLabel,
  confirmTone,
  disabled = false,
  returnFocusTo,
  onCancel,
  onConfirm,
}: {
  titleId: string;
  title: ReactNode;
  description: ReactNode;
  icon?: ReactNode;
  cancelLabel: string;
  confirmLabel: ReactNode;
  confirmTone: 'danger' | 'primary';
  disabled?: boolean;
  returnFocusTo: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape' && !disabled) {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(
        dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      );
      const first = buttons[0];
      const last = buttons.at(-1);
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
  }, [disabled, onCancel]);

  useEffect(
    () => () => {
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    },
    [returnFocusTo],
  );

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {icon}
        <h2 id={titleId}>{title}</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" autoFocus onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={confirmTone === 'danger' ? 'danger-button' : 'primary-button'}
            type="button"
            disabled={disabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
