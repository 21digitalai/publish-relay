// Optional browser hook for embedding hosts. Core never stores or transmits analytics.
export type AnalyticsAction =
  | 'magic_link_requested'
  | 'workspace_created'
  | 'provider_connect_attempted'
  | 'composer_opened'
  | 'user_error_shown';

export type AnalyticsErrorArea = 'auth' | 'connection' | 'composer' | 'scheduling' | 'publishing';
export type AnalyticsErrorCategory = 'validation' | 'network' | 'provider' | 'unknown';

export function emitAnalyticsAction(
  type: AnalyticsAction,
  properties: { provider?: string; area?: string; category?: string } = {},
): void {
  window.dispatchEvent(
    new CustomEvent('publish-relay-analytics', {
      detail: { type, properties },
    }),
  );
}

// Call at the visible error transition, never during render or state updater replay.
export function showAnalyticsError(
  setMessage: (message: string) => void,
  message: string,
  area: AnalyticsErrorArea,
  category: AnalyticsErrorCategory,
): void {
  emitAnalyticsAction('user_error_shown', { area, category });
  setMessage(message);
}
