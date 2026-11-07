import { useState } from 'react';

interface PageDmConversationLinkProps {
  kind: 'proposal' | 'send';
  rowId: string;
}

type LinkState =
  { status: 'unchecked' | 'loading' | 'unavailable' | 'error' } | { status: 'ready'; url: string };

export function PageDmConversationLink({ kind, rowId }: PageDmConversationLinkProps) {
  const [state, setState] = useState<LinkState>({ status: 'unchecked' });
  const endpoint = `/api/facebook-page-dm-link/${kind}/${encodeURIComponent(rowId)}`;

  async function openConversation() {
    // Open synchronously from the click so browsers permit the eventual Graph destination.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setState({ status: 'loading' });
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('Facebook link check failed');
      const result = (await response.json()) as { data?: { link?: string | null } };
      const link = result.data?.link;
      if (!link) {
        tab?.close();
        setState({ status: 'unavailable' });
        return;
      }
      setState({ status: 'ready', url: link });
      if (tab) tab.location.replace(link);
    } catch {
      tab?.close();
      setState({ status: 'error' });
    }
  }

  if (state.status === 'ready')
    return (
      <a
        className="page-dm-open-link secondary-button"
        href={state.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open conversation on Facebook
      </a>
    );
  if (state.status === 'unavailable')
    return (
      <span
        className="page-dm-link-unavailable muted"
        title="Facebook did not provide a direct link for this conversation"
      >
        Link unavailable
      </span>
    );
  return (
    <button
      className="page-dm-open-link secondary-button"
      type="button"
      disabled={state.status === 'loading'}
      onClick={() => void openConversation()}
    >
      {state.status === 'loading'
        ? 'Checking Facebook link…'
        : state.status === 'error'
          ? 'Retry Facebook link'
          : 'Open conversation on Facebook'}
    </button>
  );
}
