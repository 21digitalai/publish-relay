// Optional browser hook for embedding hosts. Core never stores or transmits analytics.
export type AnalyticsAction =
  | 'magic_link_requested'
  | 'workspace_created'
  | 'provider_connect_attempted'
  | 'composer_opened'
  | 'user_error_shown';

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
