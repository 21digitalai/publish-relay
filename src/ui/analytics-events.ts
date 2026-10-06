// Optional browser hook for embedding hosts. Core never stores or transmits analytics.
export type AnalyticsAction =
  'magic_link_requested' | 'provider_connect_attempted' | 'composer_opened';

export function emitAnalyticsAction(
  type: AnalyticsAction,
  properties: { provider?: string } = {},
): void {
  window.dispatchEvent(
    new CustomEvent('publish-relay-analytics', {
      detail: { type, properties },
    }),
  );
}
