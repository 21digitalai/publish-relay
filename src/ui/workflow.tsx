import { useEffect, useMemo, useState } from 'react';

import { Rail } from './main.js';

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
  state: string;
  scheduledAt: string;
  contentPreview: string;
  providerAccount: { displayName: string; handle: string; provider: string };
}

interface JobDetailDto extends Omit<QueueJobDto, 'contentPreview'> {
  content: { text?: string };
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

function calendarAnchor(jobs: Job[]): Date {
  const firstJob = jobs.at(0);
  return firstJob ? startOfDay(new Date(firstJob.scheduledAt)) : startOfDay(new Date());
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
  const [body, setBody] = useState('');
  const [scheduled, setScheduled] = useState(true);
  const [receipt, setReceipt] = useState(false);
  const invalid = !body.trim();
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
            <h3>2 posts scheduled</h3>
            <p>Sep 1 at 11:15 AM EEST</p>
            <div>
              <a className="secondary-button" href="/w/atlas/queue">
                Open Queue
              </a>
              <a className="primary-button" href="/w/atlas/calendar">
                Open Calendar
              </a>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="account-picker">
              <legend>Publish to</legend>
              <label>
                <input type="checkbox" defaultChecked />
                <span className="account-avatar">DV</span>
                <span>
                  <strong>Daily Viber</strong>
                  <small>@dailyviber · X</small>
                </span>
              </label>
              <label>
                <input type="checkbox" defaultChecked />
                <span className="account-avatar">AS</span>
                <span>
                  <strong>Atlas Studio</strong>
                  <small>@atlasstudio · X</small>
                </span>
              </label>
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
                  Date
                  <input className="text-input" value="Sep 1, 2026" readOnly />
                </label>
                <label className="field-label">
                  Time
                  <input className="text-input" value="11:15" readOnly />
                </label>
                <label className="field-label">
                  Timezone
                  <select className="health-filter" defaultValue="Europe/Sofia">
                    <option>Europe/Sofia (EEST, UTC+3)</option>
                  </select>
                </label>
              </div>
            )}
            {invalid && <p className="inline-validation">Add post text before scheduling.</p>}
            <footer>
              <button className="secondary-button" onClick={onClose}>
                Save draft
              </button>
              <button
                className="primary-button"
                disabled={invalid}
                onClick={() => {
                  setReceipt(true);
                }}
              >
                Schedule 2 posts
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
  const [query, setQuery] = useState('');
  const [view, setView] = useState('All');
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
  const jobs = useMemo(
    () =>
      (queueJobs ?? []).filter(
        (job) =>
          `${job.text} ${job.account}`.toLowerCase().includes(query.toLowerCase()) &&
          (view === 'All' ||
            (view === 'Needs attention'
              ? ['failed', 'retrying'].includes(job.state)
              : STATE_LABELS[job.state] === view)),
      ),
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
                  <a className="queue-row" href={`/w/atlas/jobs/${job.id}`} key={job.id}>
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
  const [mode, setMode] = useState('Week');
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
  return (
    <WorkspaceLayout active="calendar">
      <div className="calendar-heading">
        <div>
          <p className="eyebrow">Europe/Sofia · EEST</p>
          <h1>September 2026</h1>
        </div>
        <div className="calendar-actions">
          <button className="secondary-button">Today</button>
          <button className="icon-button" aria-label="Previous date">
            ←
          </button>
          <button className="icon-button" aria-label="Next date">
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
          <MonthCalendar jobs={jobs} />
        ) : mode === 'Timeline' ? (
          <TimelineCalendar jobs={jobs} />
        ) : (
          <TimeCalendar dayOnly={mode === 'Day'} jobs={jobs} />
        )}
      </section>
    </WorkspaceLayout>
  );
}

function MonthCalendar({ jobs }: { jobs: Job[] }) {
  const anchor = calendarAnchor(jobs);
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

function TimeCalendar({ dayOnly, jobs }: { dayOnly: boolean; jobs: Job[] }) {
  const anchor = calendarAnchor(jobs);
  const firstDay = dayOnly ? anchor : startOfWeek(anchor);
  const dates = Array.from({ length: dayOnly ? 1 : 5 }, (_, index) => addDays(firstDay, index));
  const hourStart = 8;
  const pixelsPerHour = 43;
  return (
    <div className={`time-calendar ${dayOnly ? 'day-only' : ''}`}>
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

function TimelineCalendar({ jobs }: { jobs: Job[] }) {
  const anchor = calendarAnchor(jobs);
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
          <span key={hour}>{hour}</span>
        ))}
      </div>
      {lanes.map(([accountKey, accountJobs]) => {
        const firstJob = accountJobs.at(0);
        if (!firstJob) return null;
        return (
          <div className="timeline-lane" key={accountKey}>
            <strong>{firstJob.account}</strong>
            {accountJobs.map((job) => {
              const scheduled = new Date(job.scheduledAt);
              const hourOffset = scheduled.getHours() - timelineStartHour;
              const column = Math.max(2, Math.min(7, 2 + hourOffset));
              return (
                <a
                  className={`timeline-job ${job.state}`}
                  href={jobPath(job)}
                  style={{ gridColumn: `${String(column)} / span 1` }}
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
            <button className="secondary-button" disabled={job.state !== 'scheduled'}>
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
