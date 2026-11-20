import React from 'react';
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
    previewSrc: '/fanvue-vault-preview.svg',
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
  loadFolders() {
    return Promise.resolve([{ id: 'paid', name: 'Paid DMs' }]);
  },
  loadMedia({ folderId }) {
    if (scenario === 'vault-empty') return Promise.resolve({ items: [], nextCursor: null });
    if (scenario === 'folder-empty' && folderId)
      return Promise.resolve({ items: [], nextCursor: null });
    return Promise.resolve({ items, nextCursor: scenario === 'append-error' ? 'next' : null });
  },
  async savePrice({ priceUsd }) {
    if (scenario === 'save-error') throw new Error('Price was not saved. Retry.');
    await new Promise((resolve) => window.setTimeout(resolve, 180));
    return { priceUsd };
  },
};

const root = document.querySelector('#root');
if (!(root instanceof HTMLElement)) throw new Error('Fixture root is missing.');

createRoot(root).render(
  <React.StrictMode>
    <div style={{ padding: 40 }}>
      <FanvueVaultPriceControl
        accountId="fixture-account"
        accountName="Eli Gospodinova"
        adapter={adapter}
      />
    </div>
  </React.StrictMode>,
);
