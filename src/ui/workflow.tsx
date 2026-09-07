import { useEffect, useMemo, useRef, useState } from 'react';

import { Rail } from './main.js';
import { localDateTimeValue, matchingLocalInstants, offsetLabel } from './schedule-time.js';

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
}

interface JobDetailDto extends Omit<QueueJobDto, 'contentPreview'> {
  content: { text?: string };
}

const COLLISION_SPACING_MS = 15 * 60_000;
const COLLISION_PAGE_LIMIT = 100;
const COLLISION_MAX_PAGES_PER_ACCOUNT = 50;
const COLLISION_WINDOW_MS = 7 * 24 * 60 * 60_000;

interface QueueCursor {
  beforeScheduledAt: string;
  beforeId: string;
}

function nextCollisionFreeSchedule(
  candidate: Date,
  jobs: QueueJobDto[],
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
): Promise<{ jobs: QueueJobDto[]; windowEnd: Date }> {
  const windowStart = new Date(candidate.getTime() - COLLISION_SPACING_MS);
  const windowEnd = new Date(windowStart.getTime() + COLLISION_WINDOW_MS);
  const pages = await Promise.all(
    accountIds.map(async (accountId) => {
      const items: QueueJobDto[] = [];
      let next: QueueCursor | null = null;
      for (let page = 0; page < COLLISION_MAX_PAGES_PER_ACCOUNT; page += 1) {
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
        items.push(...envelope.data.items);
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
    postId: dto.postId,
    providerAccountId: dto.providerAccount.id,
    state,
    scheduledAt: dto.scheduledAt,
    text: dto.contentPreview,
    account: dto.providerAccount.displayName,
    handle: dto.providerAccount.handle.startsWith('@')
      ? dto.providerAccount.handle
      : `@${dto.providerAccount.handle}`,
    provider: dto.providerAccount.provider.toUpperCase(),
  };
}

function detailToJob(dto: JobDetailDto): Job {
  return toJob({ ...dto, contentPreview: dto.content.text ?? '' });
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function workspacePath(): string {
  return window.location.pathname.split('/').slice(0, 3).join('/');
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfWeek(value: Date): Date {
  const day = value.getDay() || 7;
  return addDays(startOfDay(value), 1 - day);
}

function sameDay(left: Date, right: Date): boolean {
  return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function jobPath(job: Job): string {
  return `${workspacePath()}/jobs/${job.id}`;
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

function Composer({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<
    { id: string; provider: string; displayName: string; status: string }[]
  >([]);
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<QueueJobDto[]>([]);
  const [collisionGuidance, setCollisionGuidance] = useState<'loading' | 'ready' | 'unavailable'>(
    'loading',
  );
  const [collisionWindowEnd, setCollisionWindowEnd] = useState<Date | null>(null);
  const [body, setBody] = useState('');
  const [scheduled, setScheduled] = useState(true);
  const [receipt, setReceipt] = useState<{ count: number; scheduledAt: string } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [error, setError] = useState<string | null>(null);
  const intentKey = useRef(crypto.randomUUID());
  const initialSchedule = useMemo(() => new Date(Date.now() + 60 * 60 * 1000), []);
  const [localSchedule, setLocalSchedule] = useState(localDateTimeValue(initialSchedule));
  const scheduleOptions = useMemo(() => matchingLocalInstants(localSchedule), [localSchedule]);
  const [scheduleOption, setScheduleOption] = useState(0);
  const scheduledAt = scheduleOptions[scheduleOption];
  const scheduledAtMillis = scheduledAt ? scheduledAt.getTime() : null;
  const scheduleError =
    scheduled && scheduleOptions.length === 0
      ? 'This local time does not exist because the clock changes. Choose another time.'
      : scheduled && scheduledAt && scheduledAt.getTime() <= Date.now()
        ? 'Choose a future publishing time.'
        : null;
  const collisions = scheduledAt
    ? scheduledJobs.filter(
        (job) =>
          Boolean(job.providerAccount.id) &&
          selectedAccounts.includes(job.providerAccount.id ?? '') &&
          new Date(job.scheduledAt).getTime() >= Date.now() &&
          Math.abs(new Date(job.scheduledAt).getTime() - scheduledAt.getTime()) <
            COLLISION_SPACING_MS,
      )
    : [];
  const invalid =
    !body.trim() ||
    selectedAccounts.length === 0 ||
    state !== 'ready' ||
    (scheduled && (!scheduledAt || Boolean(scheduleError)));
  useEffect(() => {
    void fetch('/api/provider-accounts')
      .then(async (response) => {
        if (!response.ok) throw new Error('Connected accounts could not be loaded.');
        return response.json() as Promise<{
          data: {
            accounts: { id: string; provider: string; displayName: string; status: string }[];
          };
        }>;
      })
      .then(({ data }) => {
        const active = data.accounts.filter((account) => account.status === 'active');
        setAccounts(active);
        setSelectedAccounts(active.map((account) => account.id));
        setState('ready');
      })
      .catch((reason: unknown) => {
        setError(
          reason instanceof Error ? reason.message : 'Connected accounts could not be loaded.',
        );
        setState('ready');
      });
  }, []);
  useEffect(() => {
    if (selectedAccounts.length === 0 || scheduledAtMillis === null) {
      setScheduledJobs([]);
      setCollisionGuidance('ready');
      return;
    }
    let active = true;
    setCollisionGuidance('loading');
    void loadScheduledJobsForAccounts(selectedAccounts, new Date(scheduledAtMillis))
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
  }, [scheduledAtMillis, selectedAccounts]);
  useEffect(() => {
    intentKey.current = crypto.randomUUID();
  }, [body, localSchedule, scheduleOption, scheduled, selectedAccounts]);
  const submit = async () => {
    setState('saving');
    setError(null);
    const targetTime = scheduled ? scheduledAt : new Date();
    if (!targetTime) return;
    try {
      const response = await fetch('/api/workflow/posts', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': cookieValue('publish_relay_csrf'),
          'idempotency-key': intentKey.current,
        },
        body: JSON.stringify({
          content: { type: 'text', text: body.trim() },
          providerAccountIds: selectedAccounts,
          scheduledAt: targetTime.toISOString(),
        }),
      });
      const envelope = (await response.json()) as { error?: string | null };
      if (!response.ok) throw new Error(envelope.error ?? 'The post could not be scheduled.');
      setReceipt({ count: selectedAccounts.length, scheduledAt: targetTime.toISOString() });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The post could not be scheduled.');
    } finally {
      setState('ready');
    }
  };
  return (
    <div className="sheet-backdrop">
      <section
        className="composer-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
      >
        <header>
          <div>
            <p className="eyebrow">New publication</p>
            <h2 id="composer-title">Create post</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close composer">
            ×
          </button>
        </header>
        {receipt ? (
          <div className="composer-receipt" role="status">
            <span aria-hidden="true">✓</span>
            <h3>{receipt.count} posts scheduled</h3>
            <p>{formatTime(receipt.scheduledAt)}</p>
            <div>
              <a className="secondary-button" href={`${workspacePath()}/queue`}>
                Open Queue
              </a>
              <a className="primary-button" href={`${workspacePath()}/calendar`}>
                Open Calendar
              </a>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="account-picker">
              <legend>Publish to</legend>
              {state === 'loading' && <p>Loading connected accounts…</p>}
              {state !== 'loading' && accounts.length === 0 && (
                <p>Connect an account before scheduling.</p>
              )}
              {accounts.map((account) => (
                <label key={account.id}>
                  <input
                    className="account-picker-checkbox"
                    type="checkbox"
                    checked={selectedAccounts.includes(account.id)}
                    onChange={() => {
                      setSelectedAccounts((current) =>
                        current.includes(account.id)
                          ? current.filter((id) => id !== account.id)
                          : [...current, account.id],
                      );
                    }}
                  />
                  <span className="account-avatar">
                    {account.displayName.slice(0, 2).toUpperCase()}
                  </span>
                  <span>
                    <strong>{account.displayName}</strong>
                    <small>{account.provider.toUpperCase()}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="field-label">
              Post body
              <textarea
                className="composer-body"
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                }}
                placeholder="What should your audience know?"
              />
              <small>{body.length}/280 per X post</small>
            </label>
            <div className="media-dropzone">
              <strong>Add media</strong>
              <span>Drop images or video here, or choose files</span>
              <label className="secondary-button" htmlFor="composer-media-upload">
                Choose files
              </label>
              <input id="composer-media-upload" className="sr-only" type="file" multiple />
            </div>
            <fieldset className="schedule-choice">
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
              <div className="schedule-fields">
                <label className="field-label">
                  Date and time
                  <input
                    className="schedule-date-time text-input"
                    type="datetime-local"
                    value={localSchedule}
                    onChange={(event) => {
                      setLocalSchedule(event.target.value);
                      setScheduleOption(0);
                    }}
                  />
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
              <div className="schedule-collision-guidance" role="status">
                <strong>
                  {collisions.length}{' '}
                  {collisions.length === 1 ? 'nearby publication' : 'nearby publications'} detected
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
            {state === 'loading' && (
              <p className="inline-validation">Loading connected accounts before scheduling.</p>
            )}
            {state === 'ready' && !body.trim() && (
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
              <button className="secondary-button" onClick={onClose}>
                Save draft
              </button>
              <button className="primary-button" disabled={invalid} onClick={() => void submit()}>
                {state === 'saving'
                  ? 'Scheduling…'
                  : `Schedule ${String(selectedAccounts.length)} posts`}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

function WorkspaceLayout({
  active,
  children,
}: {
  active: 'queue' | 'calendar';
  children: React.ReactNode | ((openComposer: () => void) => React.ReactNode);
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
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
        onCreate={() => {
          setComposerOpen(true);
        }}
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
        {typeof children === 'function'
          ? children(() => {
              setComposerOpen(true);
            })
          : children}
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
      {composerOpen && (
        <Composer
          onClose={() => {
            setComposerOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function QueuePage() {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const [query, setQuery] = useState(initialParams.get('q') ?? '');
  const [view, setView] = useState(initialParams.get('view') ?? 'All');
  const [queueJobs, setQueueJobs] = useState<Job[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/workflow/jobs?limit=100', { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          data: { items: QueueJobDto[] } | null;
          error: string | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error ?? 'Could not load the publication queue');
        setQueueJobs(result.data.items.map(toJob));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(
          error instanceof Error ? error.message : 'Could not load the publication queue',
        );
      });
    return () => {
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (view !== 'All') params.set('view', view);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    );
  }, [query, view]);
  const jobs = useMemo(
    () =>
      (queueJobs ?? [])
        .filter(
          (job) =>
            `${job.text} ${job.account}`.toLowerCase().includes(query.toLowerCase()) &&
            (view === 'All' ||
              (view === 'Needs attention'
                ? ['failed', 'retrying'].includes(job.state)
                : STATE_LABELS[job.state] === view)),
        )
        .sort((left, right) => {
          const group = (job: Job) =>
            ['failed', 'retrying'].includes(job.state)
              ? 0
              : ['scheduled', 'leased', 'dispatching', 'accepted_pending'].includes(job.state)
                ? 1
                : 2;
          const difference = group(left) - group(right);
          if (difference) return difference;
          const time = new Date(left.scheduledAt).getTime() - new Date(right.scheduledAt).getTime();
          return group(left) === 2 ? -time : time;
        }),
    [query, queueJobs, view],
  );
  return (
    <WorkspaceLayout active="queue">
      {(openComposer) => (
        <>
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
              {['All', 'Needs attention', 'Scheduled', 'Published'].map((label) => (
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
              <button className="filter-button">Status: Any</button>
              <button className="filter-button">Provider: Any</button>
              <button className="filter-button">Date: This week</button>
            </div>
            {loadError ? (
              <div className="filter-empty" role="alert">
                <h2>Queue unavailable</h2>
                <p>{loadError}</p>
              </div>
            ) : queueJobs === null ? (
              <div className="filter-empty" role="status">
                <h2>Loading publication queue</h2>
                <p>Fetching the latest job states…</p>
              </div>
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
                    <span className="post-excerpt">{job.text}</span>
                    <span className="queue-account">
                      <strong>{job.account}</strong>
                      <small>{job.handle}</small>
                    </span>
                    <span className="provider-chip">{job.provider}</span>
                    <span className="row-action" aria-label={`Open ${job.id}`}>
                      →
                    </span>
                  </a>
                ))}
              </div>
            ) : queueJobs.length === 0 && !query && view === 'All' ? (
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
  const [visibleDate, setVisibleDate] = useState(() => {
    const supplied = initialParams.get('date');
    const parsed = supplied ? new Date(`${supplied}T12:00:00`) : new Date();
    return Number.isFinite(parsed.getTime()) ? startOfDay(parsed) : startOfDay(new Date());
  });
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/workflow/jobs?limit=100', { signal: controller.signal })
      .then(async (response) => {
        const result = (await response.json()) as {
          data: { items: QueueJobDto[] } | null;
          error: string | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error ?? 'Could not load the publication calendar');
        setJobs(result.data.items.map(toJob));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Could not load the calendar');
      });
    return () => {
      controller.abort();
    };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams({
      mode,
      date: `${visibleDate.getFullYear()}-${String(visibleDate.getMonth() + 1).padStart(2, '0')}-${String(visibleDate.getDate()).padStart(2, '0')}`,
    });
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  }, [mode, visibleDate]);
  const step = mode === 'Month' ? 30 : mode === 'Week' ? 7 : 1;
  return (
    <WorkspaceLayout active="calendar">
      <div className="calendar-heading">
        <div>
          <p className="eyebrow">Europe/Sofia · EEST</p>
          <h1>{visibleDate.toLocaleDateString('en', { month: 'long', year: 'numeric' })}</h1>
        </div>
        <div className="calendar-actions">
          <button
            className="secondary-button"
            onClick={() => setVisibleDate(startOfDay(new Date()))}
          >
            Today
          </button>
          <button
            className="icon-button"
            aria-label="Previous date"
            onClick={() => setVisibleDate((date) => addDays(date, -step))}
          >
            ←
          </button>
          <button
            className="icon-button"
            aria-label="Next date"
            onClick={() => setVisibleDate((date) => addDays(date, step))}
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
            {new Set((jobs ?? []).map((job) => `${job.provider}:${job.handle}`)).size} accounts
          </button>
          <button className="filter-button">All statuses</button>
        </div>
        {loadError ? (
          <div className="filter-empty" role="alert">
            <h2>Calendar unavailable</h2>
            <p>{loadError}</p>
          </div>
        ) : jobs === null ? (
          <div className="filter-empty" role="status">
            <h2>Loading publication calendar</h2>
            <p>Fetching scheduled job positions…</p>
          </div>
        ) : mode === 'Month' ? (
          <MonthCalendar jobs={jobs} anchor={visibleDate} />
        ) : mode === 'Timeline' ? (
          <TimelineCalendar jobs={jobs} anchor={visibleDate} />
        ) : (
          <TimeCalendar dayOnly={mode === 'Day'} jobs={jobs} anchor={visibleDate} />
        )}
      </section>
    </WorkspaceLayout>
  );
}

function MonthCalendar({ jobs, anchor }: { jobs: Job[]; anchor: Date }) {
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
            .filter((job) => sameDay(new Date(job.scheduledAt), date))
            .sort(
              (left, right) => Number(right.state === 'failed') - Number(left.state === 'failed'),
            );
          const isCurrentMonth = date.getMonth() === anchor.getMonth();
          return (
            <div
              className={
                sameDay(date, new Date()) ? 'today' : isCurrentMonth ? '' : 'outside-month'
              }
              role="gridcell"
              aria-label={date.toLocaleDateString('en', { dateStyle: 'full' })}
              key={date.toISOString()}
            >
              <time dateTime={date.toISOString()}>{date.getDate()}</time>
              {dayJobs.slice(0, 3).map((job) => (
                <a className={`calendar-job ${job.state}`} href={jobPath(job)} key={job.id}>
                  <strong>{formatTime(job.scheduledAt).split(', ').at(-1)}</strong>
                  {job.account}
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

function TimeCalendar({ dayOnly, jobs, anchor }: { dayOnly: boolean; jobs: Job[]; anchor: Date }) {
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
              .filter((job) => sameDay(new Date(job.scheduledAt), date))
              .map((job) => {
                const scheduled = new Date(job.scheduledAt);
                const top =
                  ((scheduled.getHours() - hourStart) * 60 + scheduled.getMinutes()) *
                  (pixelsPerHour / 60);
                return (
                  <a
                    className={`calendar-block ${job.state}`}
                    style={{ top: `${String(Math.max(0, top))}px` }}
                    href={jobPath(job)}
                    key={job.id}
                    aria-label={`${job.account}, ${STATE_LABELS[job.state]}, ${formatTime(job.scheduledAt)}`}
                  >
                    <strong>{job.account}</strong>
                    <span>{job.text}</span>
                  </a>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineCalendar({ jobs, anchor }: { jobs: Job[]; anchor: Date }) {
  const visibleJobs = jobs.filter((job) => sameDay(new Date(job.scheduledAt), anchor));
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
              const scheduled = new Date(job.scheduledAt);
              const minuteOffset =
                (scheduled.getHours() - timelineStartHour) * 60 + scheduled.getMinutes();
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
                  aria-label={`${job.account}, ${STATE_LABELS[job.state]}, ${formatTime(job.scheduledAt)}`}
                >
                  {job.text}
                </a>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function JobDetailPage() {
  const jobId = window.location.pathname.split('/').at(-1) ?? '';
  const workspacePath = window.location.pathname.split('/').slice(0, 3).join('/');
  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);
  const [editSchedule, setEditSchedule] = useState('');
  const [editScheduleOption, setEditScheduleOption] = useState(0);
  const editScheduleIntentKey = useRef(crypto.randomUUID());
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [isMutating, setIsMutating] = useState(false);
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
        setJob(detailToJob(result.data));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Could not load publication job');
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
        <div className="filter-empty" role="status">
          <h1>Loading publication job</h1>
          <p>Fetching the latest execution state…</p>
        </div>
      </WorkspaceLayout>
    );
  return (
    <WorkspaceLayout active="queue">
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
              <p className="detail-content">{job.text}</p>
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
              </div>
            </section>
            <aside>
              <h2>Execution timeline</h2>
              <ol className="execution-timeline">
                <li className="complete">
                  <strong>Post created</strong>
                  <span>Recorded by Publish Relay</span>
                </li>
                <li className="complete">
                  <strong>Scheduled</strong>
                  <span>{formatTime(job.scheduledAt)}</span>
                </li>
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
                    })
                    .catch((error: unknown) => {
                      setMutationError(
                        error instanceof Error
                          ? error.message
                          : 'Could not update the publishing time',
                      );
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
                    })
                    .catch((error: unknown) => {
                      setMutationError(
                        error instanceof Error ? error.message : `Could not ${action} this job`,
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
