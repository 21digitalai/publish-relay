import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/ui/styles.css';
import { FanvueVaultPriceControl } from '../../src/ui/fanvue-vault-price-control.js';
import type {
  FanvueVaultMedia,
  FanvueVaultPriceAdapter,
} from '../../src/ui/fanvue-vault-price-model.js';

const scenario = new URLSearchParams(window.location.search).get('scenario') ?? 'populated';
const items: FanvueVaultMedia[] = [
  {
    id: 'media-one',
    name: 'FoxyAI portrait by the window',
    folderId: 'paid',
    folderName: 'Paid DMs',
    priceUsd: null,
    previewSrc:
      scenario === 'preview-error'
        ? '/missing-fanvue-vault-preview.svg'
        : '/fanvue-vault-preview.svg',
  },
  {
    id: 'media-two',
    name: 'Evening portrait',
    folderId: 'paid',
    folderName: 'Paid DMs',
    priceUsd: '4.00',
    previewSrc: null,
  },
];

const adapter: FanvueVaultPriceAdapter = {
  async loadFolders() {
    if (scenario === 'loading') await new Promise((resolve) => window.setTimeout(resolve, 700));
    return Promise.resolve([{ id: 'paid', name: 'Paid DMs' }]);
  },
  async loadMedia({ folderId, cursor }) {
    if (scenario === 'loading') await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (scenario === 'append-error' && cursor) throw new Error('More media could not be loaded.');
    if (scenario === 'vault-empty') return Promise.resolve({ items: [], nextCursor: null });
    if (scenario === 'folder-empty' && folderId)
      return Promise.resolve({ items: [], nextCursor: null });
    return Promise.resolve({ items, nextCursor: scenario === 'append-error' ? 'next' : null });
  },
  async savePrice({ accountId, priceUsd, signal }) {
    if (scenario === 'save-error') throw new Error('Price was not saved. Retry.');
    if (scenario === 'account-switch' && accountId === 'fixture-account')
      window.dispatchEvent(new Event('fixture-switch-account'));
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(resolve, scenario === 'account-switch' ? 700 : 180);
      signal.addEventListener('abort', () => {
        window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
    if (accountId === 'fixture-account-b') throw new Error('Unexpected save for account B.');
    return { priceUsd };
  },
  async refreshPreview({ signal }) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { previewSrc: '/fanvue-vault-preview.svg?refreshed=1' };
  },
};

const root = document.querySelector('#root');
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.');

function Fixture() {
  const [accountId, setAccountId] = useState('fixture-account');
  useEffect(() => {
    const switchAccount = () => {
      setAccountId('fixture-account-b');
    };
    window.addEventListener('fixture-switch-account', switchAccount);
    return () => {
      window.removeEventListener('fixture-switch-account', switchAccount);
    };
  }, []);
  return (
    <div style={{ padding: 40 }}>
      <FanvueVaultPriceControl
        accountId={accountId}
        accountName={accountId === 'fixture-account' ? 'Eli Gospodinova' : 'Account B'}
        adapter={adapter}
      />
    </div>
  );
}

createRoot(root).render(
  <React.StrictMode>
    <Fixture />
  </React.StrictMode>,
);
