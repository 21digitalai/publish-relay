import { describe, expect, it } from 'vitest';

import {
  MetaPageMessagesError,
  pageMessagesIntent,
  selectVerifiedMessagesPage,
} from '../src/modules/providers/meta-page-messages.service.js';

const intent = pageMessagesIntent(
  JSON.stringify({
    accountId: '00000000-0000-4000-8000-000000000001',
    pageId: 'selected-page',
    connectionId: '00000000-0000-4000-8000-000000000002',
    subjectId: 'meta-user',
    credentialId: '00000000-0000-4000-8000-000000000003',
  }),
);
const selected = {
  id: 'selected-page',
  name: 'Selected',
  accessToken: 'token',
  tasks: ['CREATE_CONTENT', 'MESSAGING'],
};
const sibling = {
  id: 'sibling-page',
  name: 'Sibling',
  accessToken: 'other',
  tasks: ['CREATE_CONTENT', 'MESSAGING'],
};

describe('selected Facebook Page Messages consent', () => {
  it('accepts only the exact Page with publishing and messaging tasks', () => {
    expect(selectVerifiedMessagesPage(intent, 'meta-user', [sibling, selected])).toBe(selected);
    expect(() => selectVerifiedMessagesPage(intent, 'other-user', [selected])).toThrow(
      new MetaPageMessagesError('account-mismatch'),
    );
    expect(() => selectVerifiedMessagesPage(intent, 'meta-user', [sibling])).toThrow(
      new MetaPageMessagesError('account-mismatch'),
    );
    for (const tasks of [[], ['CREATE_CONTENT'], ['MESSAGING']])
      expect(() =>
        selectVerifiedMessagesPage(intent, 'meta-user', [{ ...selected, tasks }]),
      ).toThrow(new MetaPageMessagesError('permissions'));
  });

  it('rejects malformed one-use selected-account intent', () => {
    expect(() => pageMessagesIntent('{}')).toThrow();
    expect(() => pageMessagesIntent(null)).toThrow();
  });
});
