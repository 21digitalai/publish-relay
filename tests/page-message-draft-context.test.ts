import { describe, expect, it } from 'vitest';
import { latestDraftMessage, type PageMessage } from '../src/ui/page-message-draft-context.js';

const now = Date.parse('2026-11-21T20:00:00Z');
const inbound: PageMessage = {
  id: 'incoming',
  text: 'Test',
  senderId: 'tester',
  createdAt: new Date(now - 60000).toISOString(),
};
describe('manual Page message draft context', () => {
  it('chooses recipient inbound rather than a newer Page reply', () => {
    expect(
      latestDraftMessage(
        [
          { ...inbound, id: 'outgoing', senderId: 'page', createdAt: new Date(now).toISOString() },
          inbound,
        ],
        'tester',
        now,
      )?.id,
    ).toBe('incoming');
  });
  it('rejects a closed or too-near window, future and invalid timestamps', () => {
    for (const createdAt of [
      new Date(now - 86400000).toISOString(),
      new Date(now - 86100000).toISOString(),
      new Date(now + 1000).toISOString(),
      'invalid',
    ])
      expect(latestDraftMessage([{ ...inbound, createdAt }], 'tester', now)).toBeNull();
  });
  it('fails closed for ambiguous inbound identity, ties and a newest textless message', () => {
    expect(latestDraftMessage([inbound, { ...inbound, id: 'tied' }], 'tester', now)).toBeNull();
    expect(
      latestDraftMessage([inbound, { ...inbound, id: 'unknown', senderId: null }], 'tester', now),
    ).toBeNull();
    expect(
      latestDraftMessage(
        [
          inbound,
          { ...inbound, id: 'attachment', text: '', createdAt: new Date(now).toISOString() },
        ],
        'tester',
        now,
      ),
    ).toBeNull();
  });
});
