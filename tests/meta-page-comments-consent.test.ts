import { describe, expect, it } from 'vitest';

import {
  MetaPageCommentsError,
  pageCommentsIntent,
  selectVerifiedCommentsPage,
} from '../src/modules/providers/meta-page-comments.service.js';

const intent = pageCommentsIntent(
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
  tasks: ['CREATE_CONTENT', 'MODERATE'],
};
const sibling = { ...selected, id: 'sibling-page' };

describe('selected Facebook Page Comments consent', () => {
  it('requires the exact user, Page and publishing task', () => {
    expect(selectVerifiedCommentsPage(intent, 'meta-user', [sibling, selected])).toBe(selected);
    expect(() => selectVerifiedCommentsPage(intent, 'other-user', [selected])).toThrow(
      new MetaPageCommentsError('account-mismatch'),
    );
    expect(() => selectVerifiedCommentsPage(intent, 'meta-user', [sibling])).toThrow(
      new MetaPageCommentsError('account-mismatch'),
    );
    expect(() =>
      selectVerifiedCommentsPage(intent, 'meta-user', [{ ...selected, tasks: [] }]),
    ).toThrow(new MetaPageCommentsError('permissions'));
  });

  it('requires the Page moderation task for reply authority', () => {
    expect(() =>
      selectVerifiedCommentsPage(intent, 'meta-user', [{ ...selected, tasks: ['CREATE_CONTENT'] }]),
    ).toThrow(new MetaPageCommentsError('permissions'));
  });

  it('rejects malformed one-use intent', () => {
    expect(() => pageCommentsIntent('{}')).toThrow();
    expect(() => pageCommentsIntent(null)).toThrow();
  });
});
