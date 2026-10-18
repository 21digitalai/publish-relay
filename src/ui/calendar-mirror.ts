import { useEffect, useState } from 'react';

export interface CalendarMirrorJob {
  id: string;
  providerAccountId: string;
  providerAccountName: string;
  originWorkspaceName: string;
  state: string;
  scheduledAt: string;
  contentPreview: string;
  mediaCount: number;
}

interface CalendarMirrorPage {
  data: {
    items: CalendarMirrorJob[];
    next: { afterScheduledAt: string; afterId: string } | null;
  } | null;
  error: string | null;
}

export async function fetchCalendarMirror(
  startsAt: string,
  endsAt: string,
  signal: AbortSignal,
): Promise<CalendarMirrorJob[]> {
  const items: CalendarMirrorJob[] = [];
  let next: { afterScheduledAt: string; afterId: string } | null = null;
  for (let page = 0; page < 50; page += 1) {
    const query = new URLSearchParams({ startsAt, endsAt, limit: '100' });
    if (next) {
      query.set('afterScheduledAt', next.afterScheduledAt);
      query.set('afterId', next.afterId);
    }
    const response = await fetch(`/api/workflow/calendar/exposed-pages?${query}`, { signal });
    const result = (await response.json()) as CalendarMirrorPage;
    if (!response.ok || !result.data)
      throw new Error(result.error ?? 'Could not load shared Page posts');
    items.push(...result.data.items);
    next = result.data.next;
    if (!next) return items;
  }
  throw new Error('Too many shared Page posts for this calendar window');
}

export function useCalendarMirror(startsAt: string | null, endsAt: string | null) {
  const [jobs, setJobs] = useState<CalendarMirrorJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!startsAt || !endsAt) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const rows = await fetchCalendarMirror(startsAt, endsAt, controller.signal);
        if (!controller.signal.aborted) {
          setJobs(rows);
          setError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setJobs(null);
          setError(failure instanceof Error ? failure.message : 'Could not load shared Page posts');
        }
      } finally {
        busy = false;
      }
    };
    setJobs(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [startsAt, endsAt]);
  return { jobs, error };
}
