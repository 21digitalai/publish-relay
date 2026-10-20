import type { ReactNode } from 'react';

export function ConfirmationDialog({
  titleId,
  title,
  description,
  icon,
  cancelLabel,
  confirmLabel,
  confirmTone,
  disabled = false,
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
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
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
