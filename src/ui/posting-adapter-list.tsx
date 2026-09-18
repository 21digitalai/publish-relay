import {
  getEnabledPostingAdapters,
  POSTING_ADAPTERS,
  type PostingAdapterConfig,
} from './posting-adapter-registry.js';

export function PostingAdapterList({
  adapters = POSTING_ADAPTERS,
  onSelect,
}: {
  adapters?: readonly PostingAdapterConfig[];
  onSelect: (adapter: PostingAdapterConfig) => void;
}) {
  return (
    <div className="adapter-picker-list" aria-label="Available posting adapters">
      {getEnabledPostingAdapters(adapters).map((adapter) => (
        <button
          className="adapter-picker-option"
          type="button"
          key={adapter.id}
          onClick={() => {
            onSelect(adapter);
          }}
        >
          <span className={`adapter-icon adapter-icon-${adapter.id}`} aria-hidden="true">
            <svg viewBox={adapter.icon.viewBox} focusable="false">
              {adapter.icon.paths.map((path) => (
                <path d={path} key={path} />
              ))}
            </svg>
          </span>
          <span>
            <strong>{adapter.label}</strong>
            <small>{adapter.description}</small>
          </span>
          <span aria-hidden="true">→</span>
        </button>
      ))}
    </div>
  );
}
