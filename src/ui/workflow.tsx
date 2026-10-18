import { useEffect, useMemo, useRef, useState } from 'react';
import { emitAnalyticsAction, showAnalyticsError } from './analytics-events.js';

import {
  weightedXPostLength,
  X_DECLARED_LONG_POST_LIMIT,
  X_STANDARD_POST_LIMIT,
} from '../modules/providers/x-text-length.js';
import { Rail } from './main.js';
import { LiveRegion, PublicationToastStack, type PublicationToast } from './feedback.js';
import { DefaultsSelect } from './defaults-select.js';
import { LinkedInExpiryNotice } from './linkedin-expiry-notice.js';
import { TikTokComposerForm, type ImportedDraftMedia } from './tiktok-composer.js';
import { localDateTimeValue, matchingLocalInstants, offsetLabel } from './schedule-time.js';
import { useCalendarMirror, type CalendarMirrorJob } from './calendar-mirror.js';
import { calendarDateKey, calendarTime, calendarZonedMidnight } from './calendar-time.js';

type JobState =
  | 'scheduled'
  | 'leased'
  | 'dispatching'
  | 'accepted_pending'
  | 'failed'
  | 'retrying'
  | 'published'
  | 'cancelled'
  | 'superseded';

interface Job {
  id: string;
  postId?: string | undefined;
  providerAccountId?: string | undefined;
  state: JobState;
  scheduledAt: string;
  text: string;
  account: string;
  handle: string;
  provider: string;
  media?: { count: number; previewUrl: string | null } | undefined;
  creator?: ActorDto | undefined;
  originWorkspaceName?: string | undefined;
}

interface ActorDto {
  type: 'user' | 'api_key' | 'legacy_unknown';
  id: string | null;
  label: string | null;
}

interface DetailMediaDto {
  id: string;
  position: number;
  mimeType: string;
  state: string;
  previewUrl: string | null;
}

interface AttemptDto {
  id: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: string | null;
  retryAt: string | null;
  error: string | null;
}

interface ActivityDto {
  id: string;
  fromState: string | null;
  toState: string;
  reason: string | null;
  createdAt: string;
}

const STATE_LABELS: Record<JobState, string> = {
  scheduled: 'Scheduled',
  failed: 'Failed',
  retrying: 'Retrying',
  published: 'Published',
  cancelled: 'Cancelled',
  leased: 'Preparing',
  dispatching: 'Dispatching',
  accepted_pending: 'Provider processing',
  superseded: 'Superseded',
};

interface QueueJobDto {
  id: string;
  postId?: string;
  state: string;
  scheduledAt: string;
  contentPreview: string;
  providerAccount: { id?: string; displayName: string; handle: string; provider: string };
  media?: { count: number; previewUrl: string | null };
  creator?: ActorDto;
}

interface JobDetailDto extends Omit<QueueJobDto, 'contentPreview' | 'media'> {
  content: { text?: string; kind?: string; posts?: string[] };
  media?: DetailMediaDto[];
  attempts?: AttemptDto[];
  activity?: ActivityDto[];
  providerResult?: { id: string; url: string | null } | null;
  creator?: ActorDto;
  lastMutator?: ActorDto;
}

const COLLISION_SPACING_MS = 15 * 60_000;
const COLLISION_PAGE_LIMIT = 100;
const COLLISION_MAX_PAGES_PER_ACCOUNT = 50;
const COLLISION_WINDOW_MS = 7 * 24 * 60 * 60_000;
const PUBLICATION_REFRESH_MS = 10_000;

function useVisiblePublicationJobs(errorMessage: string) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<PublicationToast[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    let previous: Map<string, JobState> | null = null;
    let busy = false;
    let loadFailureShown = false;
    const refresh = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const response = await fetch('/api/workflow/jobs?limit=100', { signal: controller.signal });
        const result = (await response.json()) as {
          data: { items: QueueJobDto[] } | null;
          error: string | null;
        };
        if (!response.ok || !result.data) throw new Error(result.error ?? errorMessage);
        const current = result.data.items.map(toJob);
        const changed = previous
          ? current.filter((job) => {
              const prior = previous?.get(job.id);
              return prior && prior !== job.state && ['published', 'failed'].includes(job.state);
            })
          : [];
        previous = new Map(current.map((job) => [job.id, job.state]));
        setJobs(current);
        setLoadError(null);
        loadFailureShown = false;
        for (const job of changed.slice(0, 3)) {
          let externalUrl: string | null | undefined;
          if (job.state === 'published') {
            const detailResponse = await fetch(`/api/workflow/jobs/${encodeURIComponent(job.id)}`, {
              signal: controller.signal,
            }).catch(() => null);
            if (detailResponse?.ok) {
              const detail = (await detailResponse.json()) as { data: JobDetailDto | null };
              if (detail.data?.state === job.state) externalUrl = detail.data.providerResult?.url;
            }
          }
          const safeExternalUrl =
            externalUrl && /^https:\/\//i.test(externalUrl) ? externalUrl : null;
          if (controller.signal.aborted) return;
          const toast: PublicationToast = {
            id: `${job.id}:${job.state}`,
            state: job.state === 'published' ? 'published' : 'failed',
            provider: job.provider,
            account: [job.handle, job.account].filter(Boolean).join(' · '),
            href: job.state === 'published' && safeExternalUrl ? safeExternalUrl : jobPath(job),
            external: Boolean(job.state === 'published' && safeExternalUrl),
          };
          setToasts((items) =>
            [toast, ...items.filter((item) => item.id !== toast.id)].slice(0, 3),
          );
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (previous === null && !loadFailureShown) {
          showAnalyticsError(
            setLoadError,
            error instanceof Error ? error.message : errorMessage,
            'publishing',
            'network',
          );
          loadFailureShown = true;
        }
      } finally {
        busy = false;
      }
    };
    const onFocus = () => void refresh();
    void refresh();
    const timer = window.setInterval(() => void refresh(), PUBLICATION_REFRESH_MS);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [errorMessage]);
  return {
    jobs,
    loadError,
    toasts,
    dismissToast: (id: string) => {
      setToasts((items) => items.filter((item) => item.id !== id));
    },
  };
}

function WorkflowLoading({
  kind,
  label,
}: {
  kind: 'queue' | 'calendar' | 'detail';
  label: string;
}) {
  const itemCount = kind === 'queue' ? 4 : kind === 'calendar' ? 5 : 3;
  return (
    <div className={`workflow-loading ${kind}-loading`} role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: itemCount }, (_, index) => (
        <span className="loading-shape" aria-hidden="true" key={index} />
      ))}
    </div>
  );
}

interface QueueCursor {
  beforeScheduledAt: string;
  beforeId: string;
}

interface ScheduleOccupancy {
  providerAccountId: string;
  scheduledAt: string;
  jobCount: number;
}

function nextCollisionFreeSchedule(
  candidate: Date,
  jobs: ScheduleOccupancy[],
  windowEnd: Date,
): Date | null {
  let next = candidate.getTime();
  const times = jobs.map((job) => new Date(job.scheduledAt).getTime()).filter(Number.isFinite);
  for (let attempt = 0; attempt <= times.length; attempt += 1) {
    const conflicts = times.filter((time) => Math.abs(time - next) < COLLISION_SPACING_MS);
    if (conflicts.length === 0)
      return next + COLLISION_SPACING_MS <= windowEnd.getTime() ? new Date(next) : null;
    next = Math.max(...conflicts) + COLLISION_SPACING_MS;
  }
  throw new Error('A collision-free schedule could not be calculated.');
}

async function loadScheduledJobsForAccounts(
  accountIds: string[],
  candidate: Date,
  accounts: ComposerDestination[],
): Promise<{ jobs: ScheduleOccupancy[]; windowEnd: Date }> {
  const windowStart = new Date(candidate.getTime() - COLLISION_SPACING_MS);
  const windowEnd = new Date(windowStart.getTime() + COLLISION_WINDOW_MS);
  const pages = await Promise.all(
    accountIds.map(async (accountId) => {
      const items: ScheduleOccupancy[] = [];
      const isSharedPage = accounts.some(
        (account) => account.id === accountId && account.destinationProvider === 'facebook_page',
      );
      let next: QueueCursor | null = null;
      let pageBeforeAt: string | null = null;
      for (let page = 0; page < COLLISION_MAX_PAGES_PER_ACCOUNT; page += 1) {
        if (isSharedPage) {
          const query = new URLSearchParams({
            startsAt: windowStart.toISOString(),
            endsAt: windowEnd.toISOString(),
            limit: String(COLLISION_PAGE_LIMIT),
          });
          if (pageBeforeAt) query.set('beforeScheduledAt', pageBeforeAt);
          const response = await fetch(
            `/api/workflow/accounts/${encodeURIComponent(accountId)}/occupancy?${query}`,
          );
          if (!response.ok) throw new Error('Page-wide schedule guidance could not be loaded.');
          const envelope = (await response.json()) as {
            data: {
              items: { scheduledAt: string; jobCount: number }[];
              next: { beforeScheduledAt: string } | null;
            };
          };
          items.push(
            ...envelope.data.items.map((item) => ({ ...item, providerAccountId: accountId })),
          );
          pageBeforeAt = envelope.data.next?.beforeScheduledAt ?? null;
          if (!pageBeforeAt) return items;
          continue;
        }
        const query = new URLSearchParams({
          limit: String(COLLISION_PAGE_LIMIT),
          states: 'scheduled',
          providerAccountId: accountId,
          scheduledAfter: windowStart.toISOString(),
          scheduledBefore: windowEnd.toISOString(),
        });
        if (next) {
          query.set('beforeScheduledAt', next.beforeScheduledAt);
          query.set('beforeId', next.beforeId);
        }
        const response = await fetch(`/api/workflow/jobs?${query.toString()}`);
        if (!response.ok) throw new Error('Schedule guidance could not be loaded.');
        const envelope = (await response.json()) as {
          data: { items: QueueJobDto[]; next: QueueCursor | null };
        };
        items.push(
          ...envelope.data.items.map((item) => ({
            providerAccountId: item.providerAccount.id ?? accountId,
            scheduledAt: item.scheduledAt,
            jobCount: 1,
          })),
        );
        next = envelope.data.next;
        if (!next) return items;
      }
      throw new Error('Schedule guidance is unavailable for this account history.');
    }),
  );
  return { jobs: pages.flat(), windowEnd };
}

function toJob(dto: QueueJobDto): Job {
  const knownStates: JobState[] = [
    'scheduled',
    'leased',
    'dispatching',
    'accepted_pending',
    'failed',
    'published',
    'cancelled',
    'superseded',
  ];
  const state: JobState =
    dto.state === 'retry_wait'
      ? 'retrying'
      : knownStates.includes(dto.state as JobState)
        ? (dto.state as JobState)
        : 'failed';
  return {
    id: dto.id,
    ...(dto.postId ? { postId: dto.postId } : {}),
    providerAccountId: dto.providerAccount.id,
    state,
    scheduledAt: dto.scheduledAt,
    text: dto.contentPreview,
    account: dto.providerAccount.displayName,
    handle: dto.providerAccount.handle
      ? dto.providerAccount.handle.startsWith('@')
        ? dto.providerAccount.handle
        : `@${dto.providerAccount.handle}`
      : '',
    provider: dto.providerAccount.provider.toUpperCase(),
    media: dto.media,
    creator: dto.creator,
  };
}

function detailToJob(dto: JobDetailDto): Job {
  return toJob({
    id: dto.id,
    ...(dto.postId ? { postId: dto.postId } : {}),
    state: dto.state,
    scheduledAt: dto.scheduledAt,
    contentPreview: contentParts(dto.content).join('\n\n'),
    providerAccount: dto.providerAccount,
    media: {
      count: dto.media?.length ?? 0,
      previewUrl: dto.media?.find((item) => item.previewUrl)?.previewUrl ?? null,
    },
    ...(dto.creator ? { creator: dto.creator } : {}),
  });
}

function contentParts(content: JobDetailDto['content']): string[] {
  if (Array.isArray(content.posts)) return content.posts.filter((part) => part.trim());
  return content.text?.trim() ? [content.text] : [];
}

function actorLabel(actor?: ActorDto): string {
  if (!actor || actor.type === 'legacy_unknown') return 'Legacy import · creator unknown';
  const kind = actor.type === 'api_key' ? 'API key' : 'User';
  return `${kind} · ${actor.label ?? 'Unknown'}`;
}

function formatTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

function workspacePath(): string {
  return window.location.pathname.split('/').slice(0, 3).join('/');
}

function openNativePicker(input: HTMLInputElement | null): void {
  if (!input) return;
  try {
    input.showPicker();
  } catch {
    input.focus();
  }
}

function consumeComposerNavigationIntent(): boolean {
  const key = 'publish-relay-open-composer';
  if (window.sessionStorage.getItem(key) !== 'true') return false;
  window.sessionStorage.removeItem(key);
  return true;
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(value: Date, months: number): Date {
  const targetMonth = value.getMonth() + months;
  const lastTargetDay = new Date(value.getFullYear(), targetMonth + 1, 0).getDate();
  return new Date(value.getFullYear(), targetMonth, Math.min(value.getDate(), lastTargetDay));
}

function startOfWeek(value: Date): Date {
  const day = value.getDay() || 7;
  return addDays(startOfDay(value), 1 - day);
}

function sameDay(left: Date, right: Date): boolean {
  return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function localDateKey(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function calendarDayMatches(value: string, day: Date, timeZone: string): boolean {
  return calendarDateKey(new Date(value), timeZone) === localDateKey(day);
}

function jobPath(job: Job): string {
  return job.originWorkspaceName
    ? `${workspacePath()}/calendar/exposed-pages/${job.id}`
    : `${workspacePath()}/jobs/${job.id}`;
}

function toCalendarMirrorJob(dto: CalendarMirrorJob): Job {
  return {
    id: dto.id,
    providerAccountId: dto.providerAccountId,
    state: dto.state === 'retry_wait' ? 'retrying' : (dto.state as JobState),
    scheduledAt: dto.scheduledAt,
    text: dto.contentPreview,
    account: dto.providerAccountName,
    handle: '',
    provider: 'FACEBOOK',
    media: { count: dto.mediaCount, previewUrl: null },
    originWorkspaceName: dto.originWorkspaceName,
  };
}

function cookieValue(name: string): string {
  const prefix = `${name}=`;
  return (
    document.cookie
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length) ?? ''
  );
}

function Status({ state }: { state: JobState }) {
  return (
    <span className={`job-status ${state}`}>
      <span aria-hidden="true">●</span>
      {STATE_LABELS[state]}
    </span>
  );
}

function CalendarPublishedMark() {
  return (
    <span className="calendar-published-mark">
      <span aria-hidden="true">✓</span> Published
    </span>
  );
}

type ComposerContentKind = 'text' | 'video' | 'single_image' | 'carousel' | 'link';

interface ComposerDestination {
  id: string;
  provider: string;
  destinationProvider: string;
  displayName: string;
  status: string;
  expiresAt?: string | null;
  availability: string;
  capabilityFreshness: 'fresh' | 'stale' | 'unknown';
  capabilitySnapshot: { contentKinds: ComposerContentKind[] };
  adapterDefaults: { madeForKids?: boolean };
  xLongPosts: { allowed: boolean; source: 'self_declared'; verified: false } | null;
}

function sharedContentKinds(destinations: readonly ComposerDestination[]): ComposerContentKind[] {
  const first = destinations[0];
  if (!first) return [];
  return first.capabilitySnapshot.contentKinds.filter((kind) =>
    destinations
      .slice(1)
      .every((destination) => destination.capabilitySnapshot.contentKinds.includes(kind)),
  );
}

function destinationName(destination: ComposerDestination): string {
  if (destination.destinationProvider === 'tiktok') return `TikTok · ${destination.displayName}`;
  if (destination.destinationProvider === 'instagram')
    return `Instagram · ${destination.displayName}`;
  if (destination.destinationProvider === 'facebook_page')
    return `Facebook · ${destination.displayName}`;
  return destination.displayName;
}

function normalizeComposerDestination(
  input: Partial<ComposerDestination> & { id: string; provider: string; displayName: string },
): ComposerDestination {
  const destinationProvider = input.destinationProvider ?? input.provider;
  const inferredKinds: ComposerContentKind[] =
    input.provider === 'instagram' && !input.destinationProvider
      ? ['text']
      : destinationProvider === 'youtube'
        ? ['video']
        : destinationProvider === 'tiktok'
          ? []
          : destinationProvider === 'instagram'
            ? ['single_image', 'carousel']
            : destinationProvider === 'facebook_page'
              ? ['link', 'single_image']
              : ['text'];
  return {
    id: input.id,
    provider: input.provider,
    destinationProvider,
    displayName: input.displayName,
    status: input.status ?? 'active',
    availability: input.availability ?? 'active',
    capabilityFreshness: input.capabilityFreshness ?? 'unknown',
    capabilitySnapshot: input.capabilitySnapshot ?? { contentKinds: inferredKinds },
    adapterDefaults: input.adapterDefaults ?? {},
    xLongPosts:
      destinationProvider === 'x'
        ? (input.xLongPosts ?? { allowed: false, source: 'self_declared', verified: false })
        : null,
  };
}

function Composer({ onClose }: { onClose: () => void }) {
  const draftId = /\/drafts\/([^/]+)$/.exec(window.location.pathname)?.[1] ?? null;
  const [accounts, setAccounts] = useState<ComposerDestination[]>([]);
  const [nextAccountCursor, setNextAccountCursor] = useState<string | null>(null);
  const [loadingMoreAccounts, setLoadingMoreAccounts] = useState(false);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduleOccupancy[]>([]);
  const [collisionGuidance, setCollisionGuidance] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const [collisionWindowEnd, setCollisionWindowEnd] = useState<Date | null>(null);
  const [body, setBody] = useState('');
  const [contentKind, setContentKind] = useState<ComposerContentKind>('text');
  const [linkUrl, setLinkUrl] = useState('');
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const [importedMedia, setImportedMedia] = useState<ImportedDraftMedia[]>([]);
  const draftMediaIds = importedMedia.map((item) => item.id);
  const [draftState, setDraftState] = useState<'loading' | 'ready' | 'error'>(
    draftId ? 'loading' : 'ready',
  );
  const [mediaFiles, setMediaFiles] = useState<File[]>([]);
  const [videoTitle, setVideoTitle] = useState('');
  const [videoDescription, setVideoDescription] = useState('');
  const [madeForKids, setMadeForKids] = useState<'default' | 'yes' | 'no'>('default');
  const [privacyStatus, setPrivacyStatus] = useState<'default' | 'public' | 'unlisted' | 'private'>(
    'default',
  );
  const [notifySubscribers, setNotifySubscribers] = useState<'default' | 'yes' | 'no'>('default');
  const [scheduled, setScheduled] = useState(true);
  const [receipt, setReceipt] = useState<{
    count: number;
    scheduledAt: string;
    effectiveProviderSettings: Record<string, unknown>[];
  } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [accountLoadState, setAccountLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [accountLoadAttempt, setAccountLoadAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasUncertainPost, setHasUncertainPost] = useState(false);
  const intentKey = useRef(crypto.randomUUID());
  const mediaBatchKey = useRef(crypto.randomUUID());
  const uploadedMediaIds = useRef<string[]>([]);
  const uploadedIntentKey = useRef<string | null>(null);
  const uploadedFiles = useRef<File[]>([]);
  const uncertainPost = useRef<{
    key: string;
    body: string;
    form: string;
    files: File[];
    scheduledAt: string;
    count: number;
  } | null>(null);
  const discardUpload = async (): Promise<boolean> => {
    for (const mediaId of [...uploadedMediaIds.current]) {
      try {
        const response = await fetch(`/api/workflow/media/${mediaId}`, {
          method: 'DELETE',
          headers: { 'x-csrf-token': cookieValue('publish_relay_csrf') },
        });
        const envelope = (await response.json()) as { data?: { deleted?: boolean } };
        if (response.ok && envelope.data?.deleted === true)
          uploadedMediaIds.current = uploadedMediaIds.current.filter((id) => id !== mediaId);
      } catch {
        // Keep the media identity so a retry can resume server-owned cleanup.
      }
    }
    return uploadedMediaIds.current.length === 0;
  };
  const closeComposer = async () => {
    if (state === 'saving') return;
    if (uncertainPost.current) {
      showAnalyticsError(
        setError,
        'The previous schedule request has an uncertain outcome. Retry it unchanged before closing.',
        'scheduling',
        'validation',
      );
      return;
    }
    if (await discardUpload()) onClose();
    else
      showAnalyticsError(
        setError,
        'Uploaded media is still being cleaned up. Try closing again.',
        'composer',
        'unknown',
      );
  };
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void closeComposer();
    };
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  });
  const initialSchedule = useMemo(() => new Date(Date.now() + 60 * 60 * 1000), []);
  const [localSchedule, setLocalSchedule] = useState(localDateTimeValue(initialSchedule));
  const scheduleDateRef = useRef<HTMLInputElement>(null);
  const scheduleTimeRef = useRef<HTMLInputElement>(null);
  const scheduleOptions = useMemo(() => matchingLocalInstants(localSchedule), [localSchedule]);
  const [scheduleOption, setScheduleOption] = useState(0);
  const scheduledAt = scheduleOptions[scheduleOption];
  const scheduledAtMillis = scheduledAt ? scheduledAt.getTime() : null;
  const selected = accounts.filter((account) => selectedAccounts.includes(account.id));
  const allowedKinds = sharedContentKinds(selected);
  const includesMeta = selected.some((account) => account.provider === 'meta');
  const allowedKindKey = allowedKinds.join(',');
  const isYouTube = selected.length === 1 && selected[0]?.provider === 'youtube';
  const isTikTok = selected.length === 1 && selected[0]?.destinationProvider === 'tiktok';
  const isX = selected.length > 0 && selected.every((account) => account.provider === 'x');
  const selectedX = selected.filter((account) => account.provider === 'x');
  const includesX = selectedX.length > 0;
  const xLimit =
    isX && selectedX.every((account) => account.xLongPosts?.allowed === true)
      ? X_DECLARED_LONG_POST_LIMIT
      : X_STANDARD_POST_LIMIT;
  const xWeightedLength = includesX ? weightedXPostLength(body) : 0;
  const includesYouTube = selected.some((account) => account.provider === 'youtube');
  const isLinkedInOnly =
    selected.length > 0 && selected.every((account) => account.provider === 'linkedin');
  const textLimit = isLinkedInOnly ? 3000 : 280;
  const bodyTooLong = includesX
    ? xWeightedLength > xLimit || (!isX && body.length > textLimit)
    : body.length > textLimit;
  const linkedinExpiresBeforeDispatch = selected.some(
    (account) =>
      account.provider === 'linkedin' &&
      (!account.expiresAt ||
        (scheduledAt && new Date(account.expiresAt).getTime() <= scheduledAt.getTime())),
  );
  const youtubeHasMadeForKids = selected[0]?.adapterDefaults.madeForKids !== undefined;
  const scheduleError =
    scheduled && (!localSchedule.split('T')[0] || !localSchedule.split('T')[1])
      ? 'Choose a date and time.'
      : scheduled && scheduleOptions.length === 0
        ? 'This local time does not exist because the clock changes. Choose another time.'
        : scheduled && scheduledAt && scheduledAt.getTime() <= Date.now()
          ? 'Choose a future publishing time.'
          : null;
  const collisions = scheduledAt
    ? scheduledJobs.filter(
        (job) =>
          selectedAccounts.includes(job.providerAccountId) &&
          new Date(job.scheduledAt).getTime() >= Date.now() &&
          Math.abs(new Date(job.scheduledAt).getTime() - scheduledAt.getTime()) <
            COLLISION_SPACING_MS,
      )
    : [];
  const invalid =
    isTikTok ||
    (isYouTube
      ? mediaFiles.length !== 1 ||
        !videoTitle.trim() ||
        (!youtubeHasMadeForKids && madeForKids === 'default')
      : !body.trim() || bodyTooLong) ||
    (includesYouTube && !isYouTube) ||
    (mediaFiles.length > 0 && !isYouTube && !isX && !includesMeta) ||
    (includesMeta && !allowedKinds.includes(contentKind)) ||
    (includesMeta &&
      contentKind === 'single_image' &&
      mediaFiles.length + draftMediaIds.length !== 1) ||
    (includesMeta &&
      contentKind === 'carousel' &&
      (mediaFiles.length + draftMediaIds.length < 2 ||
        mediaFiles.length + draftMediaIds.length > 10)) ||
    (includesMeta && contentKind === 'link' && !linkUrl.startsWith('https://')) ||
    selectedAccounts.length === 0 ||
    linkedinExpiresBeforeDispatch ||
    state !== 'ready' ||
    draftState !== 'ready' ||
    (scheduled && (!scheduledAt || Boolean(scheduleError)));
  const validationAlerts = {
    unsupportedShape: selected.length > 0 && !isYouTube && !isTikTok && allowedKinds.length === 0,
    bodyTooLong: includesX && bodyTooLong,
    mixedYouTube: includesYouTube && !isYouTube,
    linkedInExpiry: linkedinExpiresBeforeDispatch,
    scheduleError: Boolean(scheduleError),
  };
  const previousValidationAlerts = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [name, visible] of Object.entries(validationAlerts)) {
      if (visible && !previousValidationAlerts.current[name]) {
        emitAnalyticsAction('user_error_shown', {
          area: name === 'scheduleError' ? 'scheduling' : 'composer',
          category: name === 'linkedInExpiry' ? 'provider' : 'validation',
        });
      }
    }
    previousValidationAlerts.current = validationAlerts;
  });
  const formSnapshot = JSON.stringify({
    body,
    contentKind,
    linkUrl,
    localSchedule,
    madeForKids,
    notifySubscribers,
    privacyStatus,
    scheduleOption,
    scheduled,
    selectedAccounts,
    videoDescription,
    videoTitle,
  });
  useEffect(() => {
    if (allowedKinds.length > 0 && !allowedKinds.includes(contentKind))
      setContentKind(allowedKinds[0] ?? 'text');
  }, [allowedKindKey, allowedKinds, contentKind]);
  useEffect(() => {
    if (!draftId) return;
    void fetch(`/api/workflow/drafts/${draftId}`)
      .then(async (response) => {
        const envelope = (await response.json()) as {
          data?: {
            label: string | null;
            mediaIds: string[];
            media?: ImportedDraftMedia[];
            postId: string | null;
          };
          error?: string | null;
        };
        if (!response.ok || !envelope.data)
          throw new Error(envelope.error ?? 'Draft could not be loaded.');
        const draft = envelope.data;
        if (draft.postId) throw new Error('This draft has already been scheduled.');
        if (draft.mediaIds.length === 0) throw new Error('This draft has no attached media.');
        setDraftLabel(draft.label);
        setImportedMedia(
          draft.mediaIds.map(
            (id) =>
              draft.media?.find((item) => item.id === id) ?? {
                id,
                mimeType: null,
                byteSize: null,
                durationMs: null,
                ready: false,
                previewUrl: null,
              },
          ),
        );
        setDraftState('ready');
      })
      .catch((reason: unknown) => {
        setDraftState('error');
        showAnalyticsError(
          setError,
          reason instanceof Error ? reason.message : 'Draft could not be loaded.',
          'composer',
          'network',
        );
      });
  }, [draftId]);
  useEffect(() => {
    setAccountLoadState('loading');
    void fetch('/api/provider-accounts')
      .then(async (response) => {
        if (!response.ok) throw new Error('Connected accounts could not be loaded.');
        return response.json() as Promise<{
          data: {
            accounts: ComposerDestination[];
            nextCursor: string | null;
          };
        }>;
      })
      .then(({ data }) => {
        const destinations = data.accounts.map(normalizeComposerDestination);
        setAccounts(destinations);
        setNextAccountCursor(data.nextCursor);
        setSelectedAccounts(
          destinations.some((destination) => destination.provider === 'meta')
            ? []
            : destinations
                .filter(
                  (destination) =>
                    destination.status === 'active' &&
                    destination.availability === 'active' &&
                    destination.destinationProvider !== 'tiktok' &&
                    (!destination.expiresAt ||
                      new Date(destination.expiresAt).getTime() > Date.now()),
                )
                .map((destination) => destination.id),
        );
        setAccountLoadState('ready');
        setState('ready');
      })
      .catch((reason: unknown) => {
        showAnalyticsError(
          setError,
          reason instanceof Error ? reason.message : 'Connected accounts could not be loaded.',
          'composer',
          'network',
        );
        setAccountLoadState('error');
      });
  }, [accountLoadAttempt]);
  const loadMoreAccounts = () => {
    if (!nextAccountCursor || loadingMoreAccounts) return;
    setLoadingMoreAccounts(true);
    void fetch(`/api/provider-accounts?cursor=${encodeURIComponent(nextAccountCursor)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('More shared Pages could not be loaded.');
        return response.json() as Promise<{
          data: { accounts: ComposerDestination[]; nextCursor: string | null };
        }>;
      })
      .then(({ data }) => {
        setAccounts((current) => {
          const known = new Set(current.map((account) => account.id));
          return [
            ...current,
            ...data.accounts
              .map(normalizeComposerDestination)
              .filter((account) => !known.has(account.id)),
          ];
        });
        setNextAccountCursor(data.nextCursor);
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error ? reason.message : 'More shared Pages could not be loaded.',
        );
      })
      .finally(() => {
        setLoadingMoreAccounts(false);
      });
  };
  useEffect(() => {
    if (selectedAccounts.length === 0 || scheduledAtMillis === null) {
      setScheduledJobs([]);
      setCollisionGuidance('ready');
      return;
    }
    let active = true;
    setCollisionGuidance('loading');
    void loadScheduledJobsForAccounts(selectedAccounts, new Date(scheduledAtMillis), accounts)
      .then((result) => {
        if (!active) return;
        setScheduledJobs(result.jobs);
        setCollisionWindowEnd(result.windowEnd);
        setCollisionGuidance('ready');
      })
      .catch(() => {
        if (!active) return;
        setScheduledJobs([]);
        setCollisionGuidance('unavailable');
      });
    return () => {
      active = false;
    };
  }, [scheduledAtMillis, selectedAccounts, accounts]);
  useEffect(() => {
    intentKey.current = crypto.randomUUID();
  }, [
    body,
    contentKind,
    linkUrl,
    localSchedule,
    madeForKids,
    notifySubscribers,
    privacyStatus,
    scheduleOption,
    scheduled,
    selectedAccounts,
    mediaFiles,
    videoDescription,
    videoTitle,
  ]);
  const submit = async () => {
    if (draftState !== 'ready') return;
    const pending = uncertainPost.current;
    if (
      pending &&
      (pending.form !== formSnapshot ||
        pending.files.length !== mediaFiles.length ||
        pending.files.some((file, index) => file !== mediaFiles[index]))
    ) {
      showAnalyticsError(
        setError,
        'The previous schedule request may have succeeded. Restore the original content and files, then retry it unchanged before making a new post.',
        'scheduling',
        'validation',
      );
      return;
    }
    setState('saving');
    setError(null);
    const targetTime = scheduled ? scheduledAt : new Date();
    if (!targetTime) return;
    let postRequestStarted = false;
    let postResponseStatus: number | null = null;
    let requestSnapshot: typeof pending = pending;
    try {
      let mediaIds: string[] = draftMediaIds;
      if (!pending && mediaFiles.length === 0 && !(await discardUpload()))
        throw new Error('Previous media cleanup is still pending. Try again.');
      if (!pending && mediaFiles.length > 0) {
        if (
          uploadedIntentKey.current === mediaBatchKey.current &&
          uploadedMediaIds.current.length === mediaFiles.length &&
          uploadedFiles.current.every((file, index) => file === mediaFiles[index])
        ) {
          mediaIds = [...mediaIds, ...uploadedMediaIds.current];
        } else {
          if (!(await discardUpload()))
            throw new Error('Previous media cleanup is still pending. Try again.');
          mediaBatchKey.current = crypto.randomUUID();
          uploadedIntentKey.current = mediaBatchKey.current;
          uploadedFiles.current = [...mediaFiles];
          for (const [index, file] of mediaFiles.entries()) {
            const uploadResponse = await fetch('/api/workflow/media', {
              method: 'POST',
              headers: {
                'content-type': file.type,
                'x-file-name': file.name,
                'x-csrf-token': cookieValue('publish_relay_csrf'),
                'idempotency-key': `${mediaBatchKey.current}-media-${String(index)}`,
              },
              body: file,
            });
            const upload = (await uploadResponse.json()) as {
              data?: { id: string };
              error?: string | null;
            };
            if (!uploadResponse.ok || !upload.data)
              throw new Error(upload.error ?? 'The media could not be uploaded.');
            mediaIds = [...mediaIds, upload.data.id];
            uploadedMediaIds.current.push(upload.data.id);
          }
        }
      }
      const youtubeOverrides = {
        schemaVersion: 1,
        title: videoTitle.trim(),
        ...(videoDescription.trim() ? { description: videoDescription.trim() } : {}),
        ...(madeForKids === 'default' ? {} : { madeForKids: madeForKids === 'yes' }),
        ...(privacyStatus === 'default' ? {} : { privacyStatus }),
        ...(notifySubscribers === 'default'
          ? {}
          : { notifySubscribers: notifySubscribers === 'yes' }),
      };
      requestSnapshot ??= {
        key: intentKey.current,
        body: JSON.stringify({
          content: isYouTube
            ? { kind: 'video', text: '', providerOptions: { youtube: youtubeOverrides } }
            : includesMeta
              ? {
                  kind: contentKind,
                  text: body.trim(),
                  ...(contentKind === 'link' ? { linkUrl: linkUrl.trim() } : {}),
                }
              : { type: 'text', text: body.trim() },
          mediaIds,
          providerAccountIds: selectedAccounts,
          scheduledAt: targetTime.toISOString(),
          ...(draftId ? { externalDraftId: draftId } : {}),
        }),
        form: formSnapshot,
        files: [...mediaFiles],
        scheduledAt: targetTime.toISOString(),
        count: selectedAccounts.length,
      };
      postRequestStarted = true;
      const response = await fetch('/api/workflow/posts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': cookieValue('publish_relay_csrf'),
          'idempotency-key': requestSnapshot.key,
        },
        body: requestSnapshot.body,
      });
      postResponseStatus = response.status;
      const envelope = (await response.json()) as {
        data?: { jobs?: { effectiveProviderSettings?: Record<string, unknown> | null }[] };
        error?: string | null;
      };
      if (!response.ok) throw new Error(envelope.error ?? 'The post could not be scheduled.');
      uncertainPost.current = null;
      setHasUncertainPost(false);
      uploadedMediaIds.current = [];
      setReceipt({
        count: requestSnapshot.count,
        scheduledAt: requestSnapshot.scheduledAt,
        effectiveProviderSettings: (envelope.data?.jobs ?? []).flatMap((job) =>
          job.effectiveProviderSettings ? [job.effectiveProviderSettings] : [],
        ),
      });
    } catch (reason) {
      // An uncertain post response may have committed. Keep both media and post keys for safe replay.
      if (
        postRequestStarted &&
        (postResponseStatus === null || postResponseStatus < 400 || postResponseStatus >= 500)
      ) {
        uncertainPost.current = requestSnapshot;
        setHasUncertainPost(true);
      } else {
        uncertainPost.current = null;
        setHasUncertainPost(false);
        if (await discardUpload()) {
          uploadedIntentKey.current = null;
          uploadedFiles.current = [];
          mediaBatchKey.current = crypto.randomUUID();
        }
      }
      const detail = reason instanceof Error ? reason.message : 'The post could not be scheduled.';
      showAnalyticsError(
        setError,
        uncertainPost.current
          ? `${detail} Outcome uncertain; retry the same content and files before editing or closing.`
          : detail,
        'scheduling',
        'unknown',
      );
    } finally {
      setState('ready');
    }
  };
  return (
    <div
      className="sheet-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) void closeComposer();
      }}
    >
      <section
        className={`composer-sheet${isTikTok ? ' composer-sheet-tiktok' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
      >
        <header>
          <div>
            <p className="eyebrow">New publication</p>
            <h2 id="composer-title">Create post</h2>
          </div>
          <button
            className="icon-button"
            onClick={() => void closeComposer()}
            aria-label="Close composer"
            autoFocus
            disabled={state === 'saving'}
          >
            ×
          </button>
        </header>
        {receipt ? (
          <div className="composer-receipt" role="status">
            <span aria-hidden="true">✓</span>
            <h3>{receipt.count} posts scheduled</h3>
            <p>{formatTime(receipt.scheduledAt)}</p>
            {receipt.effectiveProviderSettings.map((settings, index) => (
              <dl key={index} className="receipt-settings" aria-label="YouTube settings">
                <div>
                  <dt>Visibility</dt>
                  <dd>
                    {typeof settings.privacyStatus === 'string'
                      ? settings.privacyStatus
                      : 'Not set'}
                  </dd>
                </div>
                <div>
                  <dt>Made for kids</dt>
                  <dd>{settings.madeForKids === true ? 'Yes' : 'No'}</dd>
                </div>
                <div>
                  <dt>Notify subscribers</dt>
                  <dd>{settings.notifySubscribers === true ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
            ))}
            <div>
              <a className="secondary-button" href={`${workspacePath()}/queue`}>
                Open Queue
              </a>
              <a className="primary-button" href={`${workspacePath()}/calendar`}>
                Open Calendar
              </a>
            </div>
          </div>
        ) : accountLoadState !== 'ready' || accounts.length === 0 ? (
          <div className="composer-account-gate" role="status">
            {accountLoadState === 'loading' ? (
              <p>Loading connected accounts…</p>
            ) : accountLoadState === 'error' ? (
              <>
                <h3>Connected accounts unavailable</h3>
                <p role="alert">{error}</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    setError(null);
                    setAccountLoadAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <h3>Connect an account to create a post</h3>
                <p>Choose a posting destination before composing content for this workspace.</p>
                <div className="composer-account-gate-actions">
                  <a className="primary-button" href={`${workspacePath()}/accounts`}>
                    Add Posting Adapter
                  </a>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void closeComposer()}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            {draftId && (
              <div className="imported-draft-banner" role="status">
                <strong>{draftLabel ?? 'Imported draft'}</strong>
                <span>
                  {draftState === 'loading'
                    ? 'Loading attached media…'
                    : draftState === 'ready'
                      ? `${String(draftMediaIds.length)} attached media item${draftMediaIds.length === 1 ? '' : 's'} selected`
                      : 'Imported media unavailable'}
                </span>
              </div>
            )}
            <fieldset className="account-picker" inert={hasUncertainPost}>
              <legend>1. Choose destination</legend>
              {accounts.map((account) => (
                <label key={account.id}>
                  <input
                    className="account-picker-checkbox"
                    type="checkbox"
                    disabled={account.availability !== 'active'}
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => {
                      setMediaFiles([]);
                      setSelectedAccounts((current) =>
                        current.includes(account.id)
                          ? current.filter((id) => id !== account.id)
                          : account.destinationProvider === 'tiktok'
                            ? [account.id]
                            : [
                                ...current.filter(
                                  (id) =>
                                    accounts.find((item) => item.id === id)?.destinationProvider !==
                                    'tiktok',
                                ),
                                account.id,
                              ],
                      );
                    }}
                  />
                  <span className="account-avatar">
                    {account.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{destinationName(account)}</strong>
                    <small>
                      {account.availability === 'active'
                        ? account.destinationProvider === 'tiktok'
                          ? 'Video · options checked after selection'
                          : `${account.capabilitySnapshot.contentKinds.join(' · ')} · ${account.capabilityFreshness}`
                        : account.availability === 'publishing_unavailable'
                          ? 'Connected · publishing is not yet available'
                          : `${account.availability.replaceAll('_', ' ')} · reconnect to schedule`}
                    </small>
                  </span>
                  {account.destinationProvider === 'tiktok' &&
                    account.availability !== 'active' && (
                      <a href={`${workspacePath()}/accounts`}>Reconnect</a>
                    )}
                </label>
              ))}
              {nextAccountCursor && (
                <button
                  className="secondary-button composer-load-more-accounts"
                  type="button"
                  disabled={loadingMoreAccounts}
                  onClick={loadMoreAccounts}
                >
                  {loadingMoreAccounts ? 'Loading accounts…' : 'Load more accounts'}
                </button>
              )}
            </fieldset>
            {selected.length > 0 && !isYouTube && !isTikTok && (
              <fieldset className="content-kind-picker" inert={hasUncertainPost}>
                <legend>2. Choose supported content</legend>
                {allowedKinds.map((kind) => (
                  <button
                    className={contentKind === kind ? 'selected' : ''}
                    key={kind}
                    type="button"
                    onClick={() => {
                      setContentKind(kind);
                    }}
                  >
                    {kind.replaceAll('_', ' ')}
                  </button>
                ))}
                {allowedKinds.length === 0 && (
                  <p className="inline-validation" role="alert">
                    These destinations do not share a supported content shape.
                  </p>
                )}
              </fieldset>
            )}
            {!isTikTok && (
              <label className="field-label composer-body-field" inert={hasUncertainPost}>
                <span className="composer-body-heading">
                  <span>{isYouTube ? 'Video title' : 'Post body'}</span>
                  <small>
                    {isYouTube
                      ? `${String(videoTitle.length)}/100`
                      : includesX
                        ? `${String(xWeightedLength)}/${String(xLimit)} weighted characters per X post`
                        : `${String(body.length)}/${String(textLimit)} characters`}
                  </small>
                </span>
                {isYouTube ? (
                  <input
                    className="text-input"
                    maxLength={100}
                    value={videoTitle}
                    onChange={(event) => {
                      setVideoTitle(event.target.value);
                    }}
                  />
                ) : (
                  <textarea
                    className="composer-body"
                    maxLength={includesX ? undefined : textLimit}
                    value={body}
                    onChange={(event) => {
                      setBody(event.target.value);
                    }}
                    placeholder="What should your audience know?"
                  />
                )}
                <small className="composer-body-hint">
                  {isYouTube
                    ? `${String(videoTitle.length)}/100`
                    : includesX
                      ? selectedX.some((account) => account.xLongPosts?.allowed)
                        ? 'Long-post access is self-declared, not verified. X may reject longer posts.'
                        : 'X uses weighted characters; undeclared accounts allow 280.'
                      : includesMeta
                        ? 'Shared caption or message for each destination'
                        : `${String(body.length)}/${String(textLimit)} characters`}
                </small>
                {includesX && bodyTooLong && (
                  <small className="composer-body-validation inline-validation" role="alert">
                    {isX
                      ? `X post exceeds the ${String(xLimit)} weighted-character limit for the selected accounts.`
                      : 'Post exceeds a selected destination limit.'}
                  </small>
                )}
              </label>
            )}
            {includesMeta && contentKind === 'link' && (
              <label className="field-label">
                HTTPS link
                <input
                  className="composer-link text-input"
                  type="url"
                  value={linkUrl}
                  onChange={(event) => {
                    setLinkUrl(event.target.value);
                  }}
                />
              </label>
            )}
            {isYouTube && (
              <div className="youtube-composer-options" inert={hasUncertainPost}>
                <label className="field-label">
                  Description
                  <textarea
                    className="composer-body"
                    maxLength={5000}
                    value={videoDescription}
                    onChange={(event) => {
                      setVideoDescription(event.target.value);
                    }}
                  />
                </label>
                <DefaultsSelect
                  label="Visibility"
                  name="privacyStatus"
                  value={privacyStatus}
                  options={[
                    ['default', 'Use channel default'],
                    ['public', 'Public'],
                    ['unlisted', 'Unlisted'],
                    ['private', 'Private'],
                  ]}
                  onChange={(value) => {
                    setPrivacyStatus(value as typeof privacyStatus);
                  }}
                />
                <DefaultsSelect
                  label="Made for kids"
                  name="madeForKids"
                  value={madeForKids}
                  options={[
                    ['default', 'Use channel default'],
                    ['yes', 'Yes'],
                    ['no', 'No'],
                  ]}
                  onChange={(value) => {
                    setMadeForKids(value as typeof madeForKids);
                  }}
                />
                <DefaultsSelect
                  label="Notify subscribers"
                  name="notifySubscribers"
                  value={notifySubscribers}
                  options={[
                    ['default', 'Use channel default'],
                    ['yes', 'Yes'],
                    ['no', 'No'],
                  ]}
                  onChange={(value) => {
                    setNotifySubscribers(value as typeof notifySubscribers);
                  }}
                />
              </div>
            )}
            <div className="media-dropzone" inert={hasUncertainPost}>
              <strong>Add media</strong>
              <span>
                {isTikTok
                  ? (mediaFiles[0]?.name ?? 'Choose exactly one MP4 video')
                  : isYouTube
                    ? mediaFiles[0]
                      ? mediaFiles[0].name
                      : 'Choose exactly one MP4 video'
                    : includesMeta && contentKind !== 'link'
                      ? `${String(mediaFiles.length + draftMediaIds.length)} image${mediaFiles.length + draftMediaIds.length === 1 ? '' : 's'} selected`
                      : isX
                        ? 'Up to four images, or one GIF or MP4 video'
                        : 'Select an account to add media'}
              </span>
              {(isTikTok || isYouTube || isX || (includesMeta && contentKind !== 'link')) && (
                <>
                  <label className="secondary-button" htmlFor="composer-media-upload">
                    Choose files
                  </label>
                  <input
                    id="composer-media-upload"
                    className="sr-only"
                    type="file"
                    accept={
                      isTikTok || isYouTube
                        ? 'video/mp4'
                        : includesMeta
                          ? 'image/jpeg,image/png,image/webp,image/gif'
                          : 'image/jpeg,image/png,image/webp,image/gif,video/mp4'
                    }
                    multiple={isX || (includesMeta && contentKind === 'carousel')}
                    onChange={(event) => {
                      if (uncertainPost.current) {
                        event.target.value = '';
                        showAnalyticsError(
                          setError,
                          'Confirm the previous request before replacing its media.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      const files = Array.from(event.target.files ?? []);
                      event.target.value = '';
                      const allowed =
                        isTikTok || isYouTube
                          ? ['video/mp4']
                          : includesMeta
                            ? ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
                            : ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'];
                      if (files.some((file) => !allowed.includes(file.type))) {
                        showAnalyticsError(
                          setError,
                          'Choose a supported image, GIF, or MP4 file.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      if ((isTikTok || isYouTube) && files.length !== 1) {
                        showAnalyticsError(
                          setError,
                          'Choose exactly one MP4 video.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      if (includesMeta && files.length > (contentKind === 'carousel' ? 10 : 1)) {
                        showAnalyticsError(
                          setError,
                          'Choose only the number of images supported by this destination.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      if (
                        isX &&
                        (files.length > 4 ||
                          (files.length > 1 &&
                            files.some(
                              (file) => file.type === 'video/mp4' || file.type === 'image/gif',
                            )))
                      ) {
                        showAnalyticsError(
                          setError,
                          'X accepts up to four images, or one GIF or MP4 video.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      if (
                        files.some(
                          (file) =>
                            file.size >
                            (file.type === 'video/mp4'
                              ? isYouTube || isTikTok
                                ? 2048
                                : 512
                              : file.type === 'image/gif'
                                ? 15
                                : 5) *
                              1024 *
                              1024,
                        )
                      ) {
                        showAnalyticsError(
                          setError,
                          'One or more files exceed the destination size limit.',
                          'composer',
                          'validation',
                        );
                        return;
                      }
                      setError(null);
                      if (isTikTok) {
                        setImportedMedia([]);
                      }
                      setMediaFiles(files);
                    }}
                  />
                </>
              )}
              {mediaFiles.map((file) => (
                <div
                  className="composer-media-attachment"
                  key={`${file.name}-${String(file.size)}`}
                >
                  <span>{file.name}</span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setMediaFiles((current) => current.filter((item) => item !== file));
                    }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              {importedMedia.map((item, index) => (
                <div className="composer-media-attachment" key={item.id}>
                  <span>
                    Imported{' '}
                    {item.mimeType === 'video/mp4'
                      ? 'MP4 video'
                      : item.mimeType?.startsWith('image/')
                        ? 'image'
                        : 'media'}{' '}
                    {index + 1}
                    {item.byteSize !== null
                      ? item.byteSize < 1024 * 1024
                        ? ` · ${String(Math.ceil(item.byteSize / 1024))} KB`
                        : ` · ${String(Math.ceil(item.byteSize / 1024 / 1024))} MB`
                      : ''}
                    {item.durationMs !== null
                      ? ` · ${String(Math.ceil(item.durationMs / 1000))} seconds`
                      : ''}
                  </span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => {
                      setImportedMedia((current) =>
                        current.filter((media) => media.id !== item.id),
                      );
                    }}
                  >
                    Remove from post
                  </button>
                </div>
              ))}
            </div>
            {isTikTok && (
              <TikTokComposerForm
                key={selected[0]?.id}
                accountId={selected[0]?.id ?? ''}
                caption={body}
                onCaptionChange={setBody}
                video={mediaFiles[0] ?? null}
                importedMedia={importedMedia}
                scheduled={scheduled}
                scheduledAt={scheduledAt}
              />
            )}
            {includesYouTube && !isYouTube && (
              <p className="inline-validation" role="alert">
                YouTube videos must target exactly one YouTube channel.
              </p>
            )}
            {isYouTube && !youtubeHasMadeForKids && madeForKids === 'default' && (
              <p className="inline-validation">Choose whether this video is made for kids.</p>
            )}
            {linkedinExpiresBeforeDispatch && (
              <p className="inline-validation" role="alert">
                LinkedIn access expires before this post. Reconnect the account or choose an earlier
                time.
              </p>
            )}
            <fieldset className="schedule-choice" inert={hasUncertainPost}>
              <legend>Publishing time</legend>
              <button
                className={!scheduled ? 'selected' : ''}
                onClick={() => {
                  setScheduled(false);
                }}
              >
                Now
              </button>
              <button
                className={scheduled ? 'selected' : ''}
                onClick={() => {
                  setScheduled(true);
                }}
              >
                Schedule
              </button>
            </fieldset>
            {scheduled && (
              <div className="schedule-fields" inert={hasUncertainPost}>
                <label className="field-label">
                  Date
                  <span className="schedule-picker-field">
                    <input
                      ref={scheduleDateRef}
                      className="text-input"
                      type="date"
                      aria-label="Date"
                      value={localSchedule.split('T')[0]}
                      onChange={(event) => {
                        setLocalSchedule(
                          `${event.target.value}T${localSchedule.split('T')[1] ?? ''}`,
                        );
                        setScheduleOption(0);
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Open date picker"
                      onClick={() => {
                        openNativePicker(scheduleDateRef.current);
                      }}
                    >
                      <span aria-hidden="true">▦</span>
                    </button>
                  </span>
                </label>
                <label className="field-label">
                  Time
                  <span className="schedule-picker-field">
                    <input
                      ref={scheduleTimeRef}
                      className="text-input"
                      type="time"
                      aria-label="Time"
                      step="60"
                      value={localSchedule.split('T')[1] ?? ''}
                      onChange={(event) => {
                        setLocalSchedule(
                          `${localSchedule.split('T')[0] ?? ''}T${event.target.value}`,
                        );
                        setScheduleOption(0);
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Open time picker"
                      onClick={() => {
                        openNativePicker(scheduleTimeRef.current);
                      }}
                    >
                      <span aria-hidden="true">◷</span>
                    </button>
                  </span>
                </label>
                <label className="field-label">
                  Timezone
                  <input
                    className="text-input"
                    value={Intl.DateTimeFormat().resolvedOptions().timeZone}
                    readOnly
                  />
                </label>
                {scheduleOptions.length > 1 && (
                  <fieldset className="schedule-offset-choice">
                    <legend>This time occurs twice. Choose the intended offset.</legend>
                    {scheduleOptions.map((option, index) => (
                      <label key={option.toISOString()}>
                        <input
                          className="schedule-offset-radio"
                          type="radio"
                          name="schedule-offset"
                          checked={scheduleOption === index}
                          onChange={() => {
                            setScheduleOption(index);
                          }}
                        />
                        {offsetLabel(option)}
                      </label>
                    ))}
                  </fieldset>
                )}
              </div>
            )}
            {scheduleError && (
              <p className="inline-validation" role="alert">
                {scheduleError}
              </p>
            )}
            {scheduled && scheduledAt && collisions.length > 0 && (
              <div className="schedule-collision-guidance" role="status" inert={hasUncertainPost}>
                <strong>
                  {collisions.reduce((total, item) => total + item.jobCount, 0)}{' '}
                  {collisions.reduce((total, item) => total + item.jobCount, 0) === 1
                    ? 'nearby publication'
                    : 'nearby publications'}{' '}
                  detected
                </strong>
                <p>Leave breathing room for this account or keep the exact minute intentionally.</p>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => {
                    const opening = collisionWindowEnd
                      ? nextCollisionFreeSchedule(scheduledAt, scheduledJobs, collisionWindowEnd)
                      : null;
                    if (!opening) {
                      setCollisionGuidance('unavailable');
                      return;
                    }
                    setLocalSchedule(localDateTimeValue(opening));
                    setScheduleOption(0);
                  }}
                >
                  Use next 15-minute opening
                </button>
              </div>
            )}
            {scheduled && collisionGuidance === 'unavailable' && (
              <p className="inline-validation" role="status">
                Nearby schedule guidance is unavailable. You can still choose a time intentionally.
              </p>
            )}
            {hasUncertainPost && (
              <p className="inline-validation" role="status">
                This request may already be scheduled. Editing is paused until the original request
                is confirmed by retry.
              </p>
            )}
            {state === 'loading' && (
              <p className="inline-validation">Loading connected accounts before scheduling.</p>
            )}
            {state === 'ready' && !isYouTube && !isTikTok && !body.trim() && (
              <p className="inline-validation">Add post text before scheduling.</p>
            )}
            {state === 'ready' && body.trim() && selectedAccounts.length === 0 && (
              <p className="inline-validation">Select at least one connected account.</p>
            )}
            {state === 'saving' && (
              <p className="inline-validation" role="status">
                Saving this publication…
              </p>
            )}
            {error && (
              <p className="inline-validation" role="alert">
                {error}
              </p>
            )}
            <footer>
              <button
                className="secondary-button"
                onClick={() => void closeComposer()}
                disabled={hasUncertainPost}
              >
                Close
              </button>
              <button
                className="primary-button"
                disabled={isTikTok || state === 'saving' || (invalid && !hasUncertainPost)}
                onClick={() => void submit()}
              >
                {isTikTok
                  ? 'TikTok scheduling unavailable'
                  : state === 'saving'
                    ? 'Scheduling…'
                    : hasUncertainPost
                      ? 'Confirm previous request'
                      : `Schedule ${String(selectedAccounts.length)} posts`}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

export function WorkspaceLayout({
  active,
  children,
  initialComposerOpen = false,
}: {
  active: 'queue' | 'calendar' | 'settings';
  children: React.ReactNode | ((openComposer: () => void) => React.ReactNode);
  initialComposerOpen?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(initialComposerOpen);
  const composerTrigger = useRef<HTMLElement | null>(null);
  const openComposer = () => {
    composerTrigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setComposerOpen(true);
    emitAnalyticsAction('composer_opened');
  };
  const closeComposer = () => {
    setComposerOpen(false);
    requestAnimationFrame(() => composerTrigger.current?.focus());
  };
  return (
    <div className="workspace-app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Rail
        open={menuOpen}
        onClose={() => {
          setMenuOpen(false);
        }}
        active={active}
        onCreate={openComposer}
      />
      <main className="main-content workflow-main" id="main-content">
        <header className="mobile-header">
          <button
            className="menu-button"
            onClick={() => {
              setMenuOpen(true);
            }}
            aria-label="Open navigation"
          >
            ☰
          </button>
          <span className="brand-lockup">
            <span className="brand-signal" /> Publish Relay
          </span>
        </header>
        <LinkedInExpiryNotice />
        {typeof children === 'function' ? children(openComposer) : children}
      </main>
      {menuOpen && (
        <button
          className="rail-backdrop"
          aria-label="Close navigation"
          onClick={() => {
            setMenuOpen(false);
          }}
        />
      )}
      {composerOpen && <Composer onClose={closeComposer} />}
    </div>
  );
}

export function ExternalDraftPage() {
  return (
    <WorkspaceLayout active="queue" initialComposerOpen>
      <section className="external-draft-loading" aria-label="Imported draft">
        <WorkflowLoading kind="detail" label="Loading imported draft" />
      </section>
    </WorkspaceLayout>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(([option]) => option === value)?.[1] ?? options[0]?.[1];
  return (
    <div className="filter-select">
      <button
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="filter-button"
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        {selected} <span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div className="filter-select-menu" role="listbox" aria-label={label}>
          {options.map(([option, text]) => (
            <button
              aria-selected={option === value}
              className={option === value ? 'selected' : ''}
              key={option}
              role="option"
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function QueuePage() {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [query, setQuery] = useState(initialParams.get('q') ?? '');
  const [view, setView] = useState(initialParams.get('view') ?? 'All');
  const [status, setStatus] = useState(initialParams.get('status') ?? 'any');
  const [provider, setProvider] = useState(initialParams.get('provider') ?? 'any');
  const [dateRange, setDateRange] = useState(initialParams.get('date') ?? 'any');
  const [sort, setSort] = useState(initialParams.get('sort') ?? 'priority');
  const {
    jobs: queueJobs,
    loadError,
    toasts,
    dismissToast,
  } = useVisiblePublicationJobs('Could not load the publication queue');
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (view !== 'All') params.set('view', view);
    if (status !== 'any') params.set('status', status);
    if (provider !== 'any') params.set('provider', provider);
    if (dateRange !== 'any') params.set('date', dateRange);
    if (sort !== 'priority') params.set('sort', sort);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    );
  }, [dateRange, provider, query, sort, status, view]);
  const jobs = useMemo(
    () =>
      (queueJobs ?? [])
        .filter(
          (job) =>
            `${job.text} ${job.account}`.toLowerCase().includes(query.toLowerCase()) &&
            (view === 'All' ||
              (view === 'Needs attention'
                ? ['failed', 'retrying'].includes(job.state)
                : view === 'Upcoming'
                  ? ['scheduled', 'leased', 'dispatching', 'accepted_pending'].includes(job.state)
                  : STATE_LABELS[job.state] === view)) &&
            (status === 'any' || job.state === status) &&
            (provider === 'any' || job.provider.toLowerCase() === provider) &&
            (dateRange === 'any' ||
              (dateRange === 'upcoming'
                ? new Date(job.scheduledAt).getTime() >= Date.now()
                : sameDay(new Date(job.scheduledAt), new Date()))),
        )
        .sort((left, right) => {
          const time = new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime();
          if (sort === 'oldest') return time;
          if (sort === 'newest') return -time;
          const group = (job: Job) =>
            ['failed', 'retrying'].includes(job.state)
              ? 0
              : ['scheduled', 'leased', 'dispatching', 'accepted_pending'].includes(job.state)
                ? 1
                : 2;
          const difference = group(left) - group(right);
          if (difference) return difference;
          return group(left) === 2 ? -time : time;
        }),
    [dateRange, provider, query, queueJobs, sort, status, view],
  );
  return (
    <WorkspaceLayout active="queue" initialComposerOpen={consumeComposerNavigationIntent()}>
      {(openComposer) => (
        <>
          <PublicationToastStack toasts={toasts} onDismiss={dismissToast} />
          <div className="page-heading">
            <div>
              <p className="eyebrow">Publishing operations</p>
              <h1>Queue</h1>
              <p>Every scheduled, active, and completed publication.</p>
            </div>
            <button className="primary-button" type="button" onClick={openComposer}>
              ＋ Create post
            </button>
          </div>
          <section className="queue-section" aria-labelledby="queue-title">
            <h2 id="queue-title" className="sr-only">
              Publication queue
            </h2>
            <div className="queue-views">
              {['All', 'Needs attention', 'Upcoming', 'Published'].map((label) => (
                <button
                  className={view === label ? 'active' : ''}
                  key={label}
                  onClick={() => {
                    setView(label);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="queue-toolbar">
              <label className="search-control">
                <span aria-hidden="true">⌕</span>
                <input
                  className="queue-search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                  }}
                  placeholder="Search posts or accounts"
                />
              </label>
              <FilterSelect
                label="Status filter"
                value={status}
                onChange={setStatus}
                options={[['any', 'Status: Any'], ...Object.entries(STATE_LABELS)]}
              />
              <FilterSelect
                label="Provider filter"
                value={provider}
                onChange={setProvider}
                options={[
                  ['any', 'Provider: Any'],
                  ...[...new Set((queueJobs ?? []).map((job) => job.provider.toLowerCase()))].map(
                    (value) => [value, value.toUpperCase()] as [string, string],
                  ),
                ]}
              />
              <FilterSelect
                label="Date filter"
                value={dateRange}
                onChange={setDateRange}
                options={[
                  ['any', 'Date: Any'],
                  ['today', 'Today'],
                  ['upcoming', 'Upcoming'],
                ]}
              />
              <FilterSelect
                label="Sort order"
                value={sort}
                onChange={setSort}
                options={[
                  ['priority', 'Sort: Priority'],
                  ['oldest', 'Oldest first'],
                  ['newest', 'Newest first'],
                ]}
              />
            </div>
            {loadError ? (
              <div className="filter-empty" role="alert">
                <h2>Queue unavailable</h2>
                <p>{loadError}</p>
              </div>
            ) : queueJobs === null ? (
              <WorkflowLoading kind="queue" label="Loading publication queue" />
            ) : jobs.length ? (
              <div className="queue-table">
                <div className="queue-header">
                  <span>Status</span>
                  <span>Scheduled time</span>
                  <span>Post</span>
                  <span>Account</span>
                  <span>Provider</span>
                  <span>Actions</span>
                </div>
                {jobs.map((job) => (
                  <a className="queue-row" href={`${workspacePath()}/jobs/${job.id}`} key={job.id}>
                    <Status state={job.state} />
                    <time dateTime={job.scheduledAt}>{formatTime(job.scheduledAt)}</time>
                    <span className="post-excerpt">
                      <span>
                        {job.text || (job.media?.count ? 'Media-only post' : 'Content unavailable')}
                      </span>
                      {job.media && job.media.count > 0 && (
                        <span className="queue-media">
                          {job.media.previewUrl ? (
                            <img src={job.media.previewUrl} alt="" loading="lazy" />
                          ) : (
                            <span aria-hidden="true">▧</span>
                          )}
                          <small>{job.media.count} media</small>
                        </span>
                      )}
                    </span>
                    <span className="queue-account">
                      <strong>{job.account}</strong>
                      <small>{job.handle}</small>
                      <small>{actorLabel(job.creator)}</small>
                    </span>
                    <span className="provider-chip">{job.provider}</span>
                    <span className="row-action" aria-label={`Open ${job.id}`}>
                      →
                    </span>
                  </a>
                ))}
              </div>
            ) : queueJobs.length === 0 &&
              !query &&
              view === 'All' &&
              status === 'any' &&
              provider === 'any' &&
              dateRange === 'any' &&
              sort === 'priority' ? (
              <div className="filter-empty">
                <h2>Nothing scheduled yet</h2>
                <p>Create a post to begin building this workspace’s queue.</p>
              </div>
            ) : (
              <div className="filter-empty">
                <h2>No jobs match these filters</h2>
                <p>Adjust the view or clear your search.</p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setQuery('');
                    setView('All');
                    setStatus('any');
                    setProvider('any');
                    setDateRange('any');
                    setSort('priority');
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </WorkspaceLayout>
  );
}

export function CalendarPage() {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [mode, setMode] = useState(initialParams.get('mode') ?? 'Week');
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [visibleDate, setVisibleDate] = useState(() => {
    const supplied = initialParams.get('date');
    const parsed = supplied ? new Date(`${supplied}T12:00:00`) : new Date();
    return Number.isFinite(parsed.getTime()) ? startOfDay(parsed) : startOfDay(new Date());
  });
  const { jobs, loadError, toasts, dismissToast } = useVisiblePublicationJobs(
    'Could not load the calendar',
  );
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/workspaces/current', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load workspace timezone');
        return response.json() as Promise<{
          data: { timezone: string } | null;
        }>;
      })
      .then((result) => {
        if (!result.data?.timezone) throw new Error('Workspace timezone is unavailable');
        setTimeZone(result.data.timezone);
        if (!initialParams.has('date')) {
          const key = calendarDateKey(new Date(), result.data.timezone);
          setVisibleDate(new Date(`${key}T12:00:00`));
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setSessionError(error instanceof Error ? error.message : 'Could not load workspace');
      });
    return () => {
      controller.abort();
    };
  }, [initialParams]);
  const mirrorWindow = useMemo(() => {
    if (!timeZone) return null;
    const first =
      mode === 'Month'
        ? startOfWeek(new Date(visibleDate.getFullYear(), visibleDate.getMonth(), 1))
        : mode === 'Week'
          ? startOfWeek(visibleDate)
          : visibleDate;
    const last = addDays(first, mode === 'Month' ? 42 : mode === 'Week' ? 7 : 1);
    return {
      startsAt: calendarZonedMidnight(localDateKey(first), timeZone).toISOString(),
      endsAt: calendarZonedMidnight(localDateKey(last), timeZone).toISOString(),
    };
  }, [mode, visibleDate, timeZone]);
  const mirror = useCalendarMirror(mirrorWindow?.startsAt ?? null, mirrorWindow?.endsAt ?? null);
  const calendarJobs = useMemo(() => {
    if (!jobs || !mirror.jobs) return null;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const item of mirror.jobs) {
      if (!byId.has(item.id)) byId.set(item.id, toCalendarMirrorJob(item));
    }
    return [...byId.values()];
  }, [jobs, mirror.jobs]);
  useEffect(() => {
    const params = new URLSearchParams({
      mode,
      date: localDateKey(visibleDate),
    });
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }, [mode, visibleDate]);
  const moveVisibleDate = (date: Date, direction: number) =>
    mode === 'Month'
      ? addMonths(date, direction)
      : addDays(date, direction * (mode === 'Week' ? 7 : 1));
  return (
    <WorkspaceLayout active="calendar">
      <PublicationToastStack toasts={toasts} onDismiss={dismissToast} />
      <div className="calendar-heading">
        <div>
          <p className="eyebrow">{timeZone ?? 'Loading timezone'}</p>
          <h1>{visibleDate.toLocaleDateString('en', { month: 'long', year: 'numeric' })}</h1>
        </div>
        <div className="calendar-actions">
          <button
            className="secondary-button"
            onClick={() => {
              const key = calendarDateKey(new Date(), timeZone ?? 'UTC');
              setVisibleDate(new Date(`${key}T12:00:00`));
            }}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous date"
            onClick={() => {
              setVisibleDate((date) => moveVisibleDate(date, -1));
            }}
          >
            ←
          </button>
          <button
            className="icon-button"
            aria-label="Next date"
            onClick={() => {
              setVisibleDate((date) => moveVisibleDate(date, 1));
            }}
          >
            →
          </button>
        </div>
      </div>
      <section className="calendar-section" aria-label={`${mode} calendar`}>
        <div className="calendar-toolbar">
          <div className="view-switcher">
            {['Month', 'Week', 'Day', 'Timeline'].map((label) => (
              <button
                className={mode === label ? 'active' : ''}
                key={label}
                onClick={() => {
                  setMode(label);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="filter-button">
            {
              new Set(
                (calendarJobs ?? []).map(
                  (job) => job.providerAccountId ?? `${job.provider}:${job.handle}`,
                ),
              ).size
            }{' '}
            accounts
          </button>
          <button className="filter-button">All statuses</button>
        </div>
        {loadError || mirror.error || sessionError ? (
          <div className="filter-empty" role="alert">
            <h2>Calendar unavailable</h2>
            <p>{loadError ?? mirror.error ?? sessionError}</p>
          </div>
        ) : calendarJobs === null || !timeZone ? (
          <WorkflowLoading kind="calendar" label="Loading publication calendar" />
        ) : mode === 'Month' ? (
          <MonthCalendar jobs={calendarJobs} anchor={visibleDate} timeZone={timeZone} />
        ) : mode === 'Timeline' ? (
          <TimelineCalendar jobs={calendarJobs} anchor={visibleDate} timeZone={timeZone} />
        ) : (
          <TimeCalendar
            dayOnly={mode === 'Day'}
            jobs={calendarJobs}
            anchor={visibleDate}
            timeZone={timeZone}
          />
        )}
      </section>
    </WorkspaceLayout>
  );
}

function MonthCalendar({
  jobs,
  anchor,
  timeZone,
}: {
  jobs: Job[];
  anchor: Date;
  timeZone: string;
}) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const visibleStart = startOfWeek(monthStart);
  return (
    <div className="month-calendar" role="grid">
      <div className="month-weekdays">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="month-days">
        {Array.from({ length: 42 }, (_, index) => {
          const date = addDays(visibleStart, index);
          const dayJobs = jobs
            .filter((job) => calendarDayMatches(job.scheduledAt, date, timeZone))
            .sort(
              (left, right) => Number(right.state === 'failed') - Number(left.state === 'failed'),
            );
          const isCurrentMonth = date.getMonth() === anchor.getMonth();
          return (
            <div
              className={
                localDateKey(date) === calendarDateKey(new Date(), timeZone)
                  ? 'today'
                  : isCurrentMonth
                    ? ''
                    : 'outside-month'
              }
              role="gridcell"
              aria-label={date.toLocaleDateString('en', { dateStyle: 'full' })}
              key={date.toISOString()}
            >
              <time dateTime={date.toISOString()}>{date.getDate()}</time>
              {dayJobs.slice(0, 3).map((job) => (
                <a
                  className={`calendar-job ${job.state}`}
                  href={jobPath(job)}
                  key={job.id}
                  aria-label={`${job.account}, ${STATE_LABELS[job.state]}, ${formatTime(job.scheduledAt, timeZone)}${job.originWorkspaceName ? `, from ${job.originWorkspaceName}` : ''}`}
                >
                  <strong>{formatTime(job.scheduledAt, timeZone).split(', ').at(-1)}</strong>
                  {job.account}
                  {job.originWorkspaceName && <span> · {job.originWorkspaceName}</span>}
                  {job.state === 'published' && <CalendarPublishedMark />}
                </a>
              ))}
              {dayJobs.length > 3 && (
                <span className="calendar-more">+{dayJobs.length - 3} more</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeCalendar({
  dayOnly,
  jobs,
  anchor,
  timeZone,
}: {
  dayOnly: boolean;
  jobs: Job[];
  anchor: Date;
  timeZone: string;
}) {
  const firstDay = dayOnly ? anchor : startOfWeek(anchor);
  const dates = Array.from({ length: dayOnly ? 1 : 7 }, (_, index) => addDays(firstDay, index));
  const hourStart = 8;
  const pixelsPerHour = 43;
  return (
    <div className={`time-calendar ${dayOnly ? 'day-only' : 'week-view'}`}>
      <div className="time-header">
        <span />
        {dates.map((date) => (
          <strong key={date.toISOString()}>
            {date.toLocaleDateString('en', { weekday: 'short', day: 'numeric' })}
          </strong>
        ))}
      </div>
      <div className="time-grid">
        <div className="time-labels">
          {['08:00', '10:00', '12:00', '14:00', '16:00'].map((time) => (
            <span key={time}>{time}</span>
          ))}
        </div>
        {dates.map((date) => (
          <div className="time-day" key={date.toISOString()}>
            {jobs
              .filter((job) => calendarDayMatches(job.scheduledAt, date, timeZone))
              .map((job) => {
                const scheduled = calendarTime(job.scheduledAt, timeZone);
                const top =
                  ((scheduled.hour - hourStart) * 60 + scheduled.minute) * (pixelsPerHour / 60);
                return (
                  <a
                    className={`calendar-block ${job.state}`}
                    style={{ top: `${String(Math.max(0, top))}px` }}
                    href={jobPath(job)}
                    key={job.id}
                    aria-label={`${job.account}, ${STATE_LABELS[job.state]}, ${formatTime(job.scheduledAt, timeZone)}${job.originWorkspaceName ? `, from ${job.originWorkspaceName}` : ''}`}
                  >
                    <strong>{job.account}</strong>
                    {job.originWorkspaceName && <span>From {job.originWorkspaceName}</span>}
                    <span>{job.text}</span>
                    {job.state === 'published' && <CalendarPublishedMark />}
                  </a>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineCalendar({
  jobs,
  anchor,
  timeZone,
}: {
  jobs: Job[];
  anchor: Date;
  timeZone: string;
}) {
  const visibleJobs = jobs.filter((job) => calendarDayMatches(job.scheduledAt, anchor, timeZone));
  const lanes = Array.from(
    visibleJobs.reduce((grouped, job) => {
      const key = `${job.provider}:${job.handle}`;
      grouped.set(key, [...(grouped.get(key) ?? []), job]);
      return grouped;
    }, new Map<string, Job[]>()),
  );
  const timelineStartHour = 9;
  return (
    <div className="timeline-calendar">
      <div className="timeline-hours">
        <span />
        {['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'].map((hour) => (
          <span className="timeline-hour" key={hour}>
            {hour}
          </span>
        ))}
      </div>
      {lanes.map(([accountKey, accountJobs]) => {
        const firstJob = accountJobs.at(0);
        if (!firstJob) return null;
        return (
          <div className="timeline-lane" key={accountKey}>
            <strong>{firstJob.account}</strong>
            {accountJobs.map((job, jobIndex) => {
              const scheduled = calendarTime(job.scheduledAt, timeZone);
              const minuteOffset = (scheduled.hour - timelineStartHour) * 60 + scheduled.minute;
              const column = Math.max(2, Math.min(25, 2 + Math.floor(minuteOffset / 15)));
              return (
                <a
                  className={`timeline-job ${job.state}`}
                  href={jobPath(job)}
                  style={{
                    gridColumn: `${String(column)} / span 2`,
                    gridRow: String(jobIndex + 1),
                  }}
                  key={job.id}
                  aria-label={`${job.account}, ${STATE_LABELS[job.state]}, ${formatTime(job.scheduledAt, timeZone)}${job.originWorkspaceName ? `, from ${job.originWorkspaceName}` : ''}`}
                >
                  {job.text}
                  {job.originWorkspaceName && <span> · From {job.originWorkspaceName}</span>}
                  {job.state === 'published' && <CalendarPublishedMark />}
                </a>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

interface CalendarMirrorDetail {
  id: string;
  providerAccountName: string;
  originWorkspaceName: string;
  state: string;
  scheduledAt: string;
  caption: string | null;
  linkUrl: string | null;
  media: { id: string; position: number; previewUrl: string | null }[];
}

export function CalendarMirrorDetailPage() {
  const jobId = window.location.pathname.split('/').at(-1) ?? '';
  const [detail, setDetail] = useState<CalendarMirrorDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/workflow/calendar/exposed-pages/${encodeURIComponent(jobId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          data: CalendarMirrorDetail | null;
          error: string | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error ?? 'Shared Page post is unavailable');
        setDetail(result.data);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Shared Page post is unavailable');
      });
    return () => {
      controller.abort();
    };
  }, [jobId]);
  return (
    <WorkspaceLayout active="calendar">
      <div className="detail-route">
        <a className="back-link" href={`${workspacePath()}/calendar`}>
          ← Back to calendar
        </a>
        {error ? (
          <div className="filter-empty" role="alert">
            <h1>Post unavailable</h1>
            <p>{error}</p>
          </div>
        ) : !detail ? (
          <WorkflowLoading kind="detail" label="Loading shared Page post" />
        ) : (
          <section className="job-detail">
            <header>
              <div>
                <Status state={detail.state as JobState} />
                <h1>{detail.providerAccountName}</h1>
                <p>From {detail.originWorkspaceName} · Read-only in this workspace</p>
              </div>
            </header>
            <div className="detail-grid">
              <section>
                <h2>Content</h2>
                <p className="detail-content">{detail.caption ?? 'No caption · media-only post'}</p>
                {detail.media.length > 0 && (
                  <div className="detail-media-gallery" aria-label="Post media">
                    {detail.media.map((media) =>
                      media.previewUrl ? (
                        <img
                          key={media.id}
                          src={media.previewUrl}
                          alt={`Post media ${String(media.position + 1)}`}
                        />
                      ) : (
                        <div className="missing-media" key={media.id}>
                          Media {String(media.position + 1)} unavailable
                        </div>
                      ),
                    )}
                  </div>
                )}
                <div className="detail-meta">
                  <span>
                    Scheduled<strong>{formatTime(detail.scheduledAt, 'UTC')}</strong>
                  </span>
                  <span>
                    Timezone<strong>UTC</strong>
                  </span>
                </div>
                {detail.linkUrl && /^https:\/\//i.test(detail.linkUrl) && (
                  <a
                    className="secondary-button"
                    href={detail.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View published post
                  </a>
                )}
              </section>
            </div>
          </section>
        )}
      </div>
    </WorkspaceLayout>
  );
}

export function JobDetailPage() {
  const jobId = window.location.pathname.split('/').at(-1) ?? '';
  const workspacePath = window.location.pathname.split('/').slice(0, 3).join('/');
  const [job, setJob] = useState<Job | null>(null);
  const [detail, setDetail] = useState<JobDetailDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);
  const [editSchedule, setEditSchedule] = useState('');
  const [editScheduleOption, setEditScheduleOption] = useState(0);
  const editScheduleIntentKey = useRef(crypto.randomUUID());
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [mutationAnnouncement, setMutationAnnouncement] = useState<string | null>(null);
  const reportedFailedJob = useRef<string | null>(null);
  useEffect(() => {
    if (job?.state === 'failed' && reportedFailedJob.current !== job.id) {
      reportedFailedJob.current = job.id;
      emitAnalyticsAction('user_error_shown', { area: 'publishing', category: 'provider' });
    }
  }, [job?.id, job?.state]);
  const invalidEditTime = isEditingSchedule && matchingLocalInstants(editSchedule).length === 0;
  const previousInvalidEditTime = useRef(false);
  useEffect(() => {
    if (invalidEditTime && !previousInvalidEditTime.current)
      emitAnalyticsAction('user_error_shown', { area: 'scheduling', category: 'validation' });
    previousInvalidEditTime.current = invalidEditTime;
  }, [invalidEditTime]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/workflow/jobs/${encodeURIComponent(jobId)}`, { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          data: JobDetailDto | null;
          error: string | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error ?? 'Could not load publication job');
        setDetail(result.data);
        setJob(detailToJob(result.data));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        showAnalyticsError(
          setLoadError,
          error instanceof Error ? error.message : 'Could not load publication job',
          'publishing',
          'network',
        );
      });
    return () => {
      controller.abort();
    };
  }, [jobId]);
  if (loadError)
    return (
      <WorkspaceLayout active="queue">
        <div className="filter-empty" role="alert">
          <h1>Job unavailable</h1>
          <p>{loadError}</p>
          <a className="secondary-button" href={`${workspacePath}/queue`}>
            Back to queue
          </a>
        </div>
      </WorkspaceLayout>
    );
  if (!job)
    return (
      <WorkspaceLayout active="queue">
        <WorkflowLoading kind="detail" label="Loading publication job" />
      </WorkspaceLayout>
    );
  return (
    <WorkspaceLayout active="queue">
      <LiveRegion message={mutationAnnouncement} />
      <div className="detail-route">
        <a className="back-link" href={`${workspacePath}/queue`}>
          ← Back to queue
        </a>
        <section className="job-detail">
          <header>
            <div>
              <Status state={job.state} />
              <h1>{job.account}</h1>
              <p>
                {job.id} · {job.provider}
              </p>
            </div>
          </header>
          <div className="detail-grid">
            <section>
              <h2>Content</h2>
              {detail && contentParts(detail.content).length > 0 ? (
                <ol className="detail-content-parts">
                  {contentParts(detail.content).map((part, index) => (
                    <li key={`${String(index)}-${part.slice(0, 20)}`}>
                      <span>Part {String(index + 1)}</span>
                      <p className="detail-content">{part}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="detail-content">No text · media-only post</p>
              )}
              {detail && (detail.media?.length ?? 0) > 0 && (
                <div className="detail-media-gallery" aria-label="Post media">
                  {(detail.media ?? []).map((media) =>
                    media.previewUrl ? (
                      <img
                        key={media.id}
                        src={media.previewUrl}
                        alt={`Post media ${String(media.position + 1)}`}
                      />
                    ) : (
                      <div className="missing-media" key={media.id}>
                        Media {String(media.position + 1)} unavailable ({media.state})
                      </div>
                    ),
                  )}
                </div>
              )}
              <div className="detail-meta">
                <span>
                  Account
                  <strong>
                    {job.account} · {job.handle}
                  </strong>
                </span>
                <span>
                  Scheduled<strong>{formatTime(job.scheduledAt)}</strong>
                </span>
                <span>
                  Timezone<strong>Shown in your workspace timezone</strong>
                </span>
                <span>
                  Created by<strong>{actorLabel(detail?.creator)}</strong>
                </span>
                {detail?.lastMutator && (
                  <span>
                    Last changed by<strong>{actorLabel(detail.lastMutator)}</strong>
                  </span>
                )}
              </div>
            </section>
            <aside>
              <h2>Execution timeline</h2>
              <ol className="execution-timeline">
                {(detail?.activity ?? []).map((event) => (
                  <li className={event.toState === 'failed' ? 'failed' : 'complete'} key={event.id}>
                    <strong>
                      {event.toState in STATE_LABELS
                        ? STATE_LABELS[event.toState as JobState]
                        : event.toState}
                    </strong>
                    <span>
                      {formatTime(event.createdAt)}
                      {event.reason ? ` · ${event.reason}` : ''}
                    </span>
                  </li>
                ))}
                {(detail?.activity?.length ?? 0) === 0 && (
                  <li className="complete">
                    <strong>Scheduled</strong>
                    <span>{formatTime(job.scheduledAt)}</span>
                  </li>
                )}
                {(detail?.attempts ?? []).map((attempt) => (
                  <li
                    className={attempt.outcome === 'failed' ? 'failed' : 'complete'}
                    key={attempt.id}
                  >
                    <strong>Delivery attempt {String(attempt.attemptNumber)}</strong>
                    <span>
                      {attempt.outcome ?? 'In progress'}
                      {attempt.error ? ` · ${attempt.error}` : ''}
                      {attempt.retryAt ? ` · Retry ${formatTime(attempt.retryAt)}` : ''}
                    </span>
                  </li>
                ))}
                {job.state === 'failed' && (
                  <li className="failed">
                    <strong>Dispatch failed</strong>
                    <span>Open technical details when provider evidence is available.</span>
                  </li>
                )}
                {job.state === 'retrying' && (
                  <li className="active">
                    <strong>Retry queued</strong>
                    <span>Waiting for the scheduler.</span>
                  </li>
                )}
              </ol>
            </aside>
          </div>
          {detail?.providerResult?.url && (
            <a className="primary-button external-result-link" href={detail.providerResult.url}>
              View on X
            </a>
          )}
          {job.state === 'failed' && (
            <div className="recovery-panel" role="alert">
              <div>
                <strong>Publishing failed</strong>
                <p>
                  This publication needs attention. Retrying uses the existing job rather than
                  creating a new visible job.
                </p>
                <details>
                  <summary>Technical details</summary>
                  <code>No provider diagnostic was supplied by this response.</code>
                </details>
              </div>
              <button
                className="primary-button"
                onClick={() => {
                  setDialog('retry');
                }}
              >
                Retry now
              </button>
            </div>
          )}
          <footer className="detail-actions">
            <button
              className="secondary-button"
              disabled={job.state !== 'scheduled'}
              onClick={() => {
                setEditSchedule(localDateTimeValue(new Date(job.scheduledAt)));
                setEditScheduleOption(0);
                editScheduleIntentKey.current = crypto.randomUUID();
                setIsEditingSchedule(true);
                setMutationError(null);
              }}
            >
              Edit schedule
            </button>
            <button
              className="danger-button"
              disabled={!['scheduled', 'retrying'].includes(job.state)}
              onClick={() => {
                setDialog('cancel');
              }}
            >
              Cancel job
            </button>
          </footer>
          {mutationError && (
            <p className="mutation-error" role="alert">
              {mutationError}
            </p>
          )}
        </section>
      </div>
      {isEditingSchedule && (
        <div className="dialog-backdrop">
          <section
            className="confirm-dialog edit-schedule-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-schedule-title"
          >
            <h2 id="edit-schedule-title">Edit publishing time</h2>
            <p>The existing post will be revised and its pending job safely superseded.</p>
            <label className="field-label">
              Date and time
              <input
                className="edit-schedule-date-time text-input"
                type="datetime-local"
                value={editSchedule}
                onChange={(event) => {
                  setEditSchedule(event.target.value);
                  setEditScheduleOption(0);
                  editScheduleIntentKey.current = crypto.randomUUID();
                }}
              />
            </label>
            {matchingLocalInstants(editSchedule).length === 0 && (
              <p className="inline-validation" role="alert">
                This local time does not exist because the clock changes.
              </p>
            )}
            {matchingLocalInstants(editSchedule).length > 1 && (
              <fieldset className="schedule-offset-choice">
                <legend>This time occurs twice. Choose the intended offset.</legend>
                {matchingLocalInstants(editSchedule).map((option, index) => (
                  <label key={option.toISOString()}>
                    <input
                      className="edit-schedule-offset-radio"
                      type="radio"
                      name="edit-schedule-offset"
                      checked={editScheduleOption === index}
                      onChange={() => {
                        setEditScheduleOption(index);
                      }}
                    />
                    {offsetLabel(option)}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="dialog-actions">
              <button
                className="secondary-button"
                autoFocus
                onClick={() => {
                  setIsEditingSchedule(false);
                }}
              >
                Keep current time
              </button>
              <button
                className="primary-button"
                disabled={
                  isMutating ||
                  matchingLocalInstants(editSchedule).length === 0 ||
                  (matchingLocalInstants(editSchedule)[editScheduleOption]?.getTime() ?? 0) <=
                    Date.now()
                }
                onClick={() => {
                  const target = matchingLocalInstants(editSchedule)[editScheduleOption];
                  if (!target || !job.postId) return;
                  setIsMutating(true);
                  setMutationError(null);
                  setMutationAnnouncement('Rescheduling publication');
                  void fetch(`/api/workflow/posts/${encodeURIComponent(job.postId)}/schedule`, {
                    method: 'PATCH',
                    headers: {
                      'content-type': 'application/json',
                      'x-csrf-token': cookieValue('publish_relay_csrf'),
                      'idempotency-key': editScheduleIntentKey.current,
                    },
                    body: JSON.stringify({
                      scheduledAt: target.toISOString(),
                    }),
                  })
                    .then(async (response) => {
                      const result = (await response.json()) as {
                        data: unknown;
                        error: string | null;
                      };
                      if (!response.ok || !result.data)
                        throw new Error(result.error ?? 'Could not update the publishing time');
                      setJob({ ...job, scheduledAt: target.toISOString() });
                      setIsEditingSchedule(false);
                      setMutationAnnouncement('Publication rescheduled successfully');
                    })
                    .catch((error: unknown) => {
                      const message =
                        error instanceof Error
                          ? error.message
                          : 'Could not update the publishing time';
                      showAnalyticsError(setMutationError, message, 'scheduling', 'unknown');
                      setMutationAnnouncement(`Reschedule failed: ${message}`);
                    })
                    .finally(() => {
                      setIsMutating(false);
                    });
                }}
              >
                {isMutating ? 'Updating…' : 'Update schedule'}
              </button>
            </div>
          </section>
        </div>
      )}
      {dialog && (
        <div className="dialog-backdrop">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="job-dialog-title"
          >
            <span className={dialog === 'cancel' ? 'danger-icon' : 'info-icon'}>
              {dialog === 'cancel' ? '!' : '↻'}
            </span>
            <h2 id="job-dialog-title">
              {dialog === 'cancel'
                ? `Cancel ${job.account} publication?`
                : 'Retry this publication now?'}
            </h2>
            <p>
              {dialog === 'cancel'
                ? 'It will be removed from dispatch. Published external content cannot be undone.'
                : 'The same publication job will be reused, preventing a duplicate post.'}
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                autoFocus
                onClick={() => {
                  setDialog(null);
                }}
              >
                Keep job
              </button>
              <button
                className={dialog === 'cancel' ? 'danger-button' : 'primary-button'}
                disabled={isMutating}
                onClick={() => {
                  const action = dialog;
                  setIsMutating(true);
                  setMutationError(null);
                  setMutationAnnouncement(
                    action === 'cancel' ? 'Cancelling publication' : 'Retrying publication',
                  );
                  void fetch(`/api/workflow/jobs/${encodeURIComponent(job.id)}/${action}`, {
                    method: 'POST',
                    headers: {
                      'x-csrf-token': cookieValue('publish_relay_csrf'),
                      'idempotency-key': crypto.randomUUID(),
                    },
                  })
                    .then(async (response) => {
                      const result = (await response.json()) as {
                        data: { state: string } | null;
                        error: string | null;
                      };
                      if (!response.ok || !result.data)
                        throw new Error(result.error ?? `Could not ${action} this job`);
                      setJob({ ...job, state: action === 'cancel' ? 'cancelled' : 'retrying' });
                      setDialog(null);
                      setMutationAnnouncement(
                        action === 'cancel'
                          ? 'Publication cancelled successfully'
                          : 'Publication retry queued successfully',
                      );
                    })
                    .catch((error: unknown) => {
                      const message =
                        error instanceof Error ? error.message : `Could not ${action} this job`;
                      showAnalyticsError(setMutationError, message, 'publishing', 'unknown');
                      setMutationAnnouncement(
                        `${action === 'cancel' ? 'Cancellation' : 'Retry'} failed: ${message}`,
                      );
                      setDialog(null);
                    })
                    .finally(() => {
                      setIsMutating(false);
                    });
                }}
              >
                {isMutating
                  ? dialog === 'cancel'
                    ? 'Cancelling…'
                    : 'Retrying…'
                  : dialog === 'cancel'
                    ? 'Cancel job'
                    : 'Retry safely'}
              </button>
            </div>
          </section>
        </div>
      )}
    </WorkspaceLayout>
  );
}
