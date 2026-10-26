import type { PostingAdapterConfig } from './posting-adapter-registry.js';
import { emitAnalyticsAction } from './analytics-events.js';

export function getCsrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((value) => value.startsWith('publish_relay_csrf='));
  return entry ? (entry.split('=')[1] ?? '') : '';
}

export async function beginAdapterConnection(
  adapter: PostingAdapterConfig,
  accountId?: string,
  option?: 'read-chat' | 'send-chat' | 'read-payments' | 'read-audience' | 'messages' | 'comments',
): Promise<void> {
  emitAnalyticsAction('provider_connect_attempted', { provider: adapter.id });
  const response = await fetch(
    (option === 'messages' || option === 'comments') && adapter.id === 'facebook_page'
      ? `/api/oauth/meta/facebook-page-${option}`
      : adapter.auth.startPath,
    {
      method: 'POST',
      headers: { 'x-csrf-token': getCsrfToken(), 'content-type': 'application/json' },
      body: JSON.stringify(
        (option === 'messages' || option === 'comments') &&
          adapter.id === 'facebook_page' &&
          accountId
          ? { accountId }
          : option === 'read-chat' && adapter.id === 'fanvue' && accountId
            ? { readChatAccountId: accountId }
            : option === 'send-chat' && adapter.id === 'fanvue' && accountId
              ? { sendChatAccountId: accountId }
              : option === 'read-payments' && adapter.id === 'fanvue' && accountId
                ? { paymentAccountId: accountId }
                : option === 'read-audience' && adapter.id === 'fanvue' && accountId
                  ? { audienceAccountId: accountId }
                  : accountId && adapter.id === 'linkedin'
                    ? { accountId }
                    : {},
      ),
    },
  );
  const result = (await response.json()) as {
    data: { authorizationUrl: string } | null;
    error: string | null;
  };
  if (!response.ok || !result.data)
    throw new Error(result.error ?? `Could not start ${adapter.label} connection`);
  window.location.href = result.data.authorizationUrl;
}
