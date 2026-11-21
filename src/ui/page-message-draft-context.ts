export interface PageMessage {
  id: string;
  text: string;
  createdAt: string;
  senderId: string | null;
}
export const DRAFT_DELAY_MS = 5 * 60_000;
const REPLY_WINDOW_MS = 24 * 60 * 60_000;
const WINDOW_MARGIN_MS = 2 * 60_000;

export function latestDraftMessage(messages: PageMessage[], participantId: string, now: number) {
  if (!participantId || messages.some((message) => !Number.isFinite(Date.parse(message.createdAt))))
    return null;
  const incoming = messages
    .filter((message) => message.senderId === participantId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  const latest = incoming[0];
  if (!latest?.text.trim() || latest.text.length > 5000) return null;
  const timestamp = Date.parse(latest.createdAt);
  if (
    timestamp > now ||
    timestamp + REPLY_WINDOW_MS - WINDOW_MARGIN_MS <= now + DRAFT_DELAY_MS ||
    incoming.some(
      (message) => message.id !== latest.id && Date.parse(message.createdAt) === timestamp,
    ) ||
    messages.some((message) => !message.senderId && Date.parse(message.createdAt) >= timestamp)
  )
    return null;
  return latest;
}
