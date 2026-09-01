import { useMemo, useState } from 'react';

import { Rail } from './main.js';

type JobState = 'scheduled' | 'failed' | 'retrying' | 'published' | 'cancelled';

interface Job {
  id: string;
  state: JobState;
  scheduledAt: string;
  text: string;
  account: string;
  handle: string;
  provider: string;
}

const JOBS: Job[] = [
  {
    id: 'job-2048',
    state: 'failed',
    scheduledAt: '2026-09-01T09:30:00+03:00',
    text: 'The clearest plans leave room for the unexpected.',
    account: 'Daily Viber',
    handle: '@dailyviber',
    provider: 'X',
  },
  {
    id: 'job-2049',
    state: 'scheduled',
    scheduledAt: '2026-09-01T11:15:00+03:00',
    text: 'New release notes are ready. Here is what changed.',
    account: 'Atlas Studio',
    handle: '@atlasstudio',
    provider: 'X',
  },
  {
    id: 'job-2050',
    state: 'retrying',
    scheduledAt: '2026-09-01T14:00:00+03:00',
    text: 'A short field guide to calmer publishing operations.',
    account: 'Mira Editorial',
    handle: '@miraeditorial',
    provider: 'X',
  },
  {
    id: 'job-2051',
    state: 'published',
    scheduledAt: '2026-09-02T08:45:00+03:00',
    text: 'Yesterday’s dispatch completed successfully.',
    account: 'Daily Viber',
    handle: '@dailyviber',
    provider: 'X',
  },
];

const STATE_LABELS: Record<JobState, string> = {
  scheduled: 'Scheduled',
  failed: 'Failed',
  retrying: 'Retrying',
  published: 'Published',
  cancelled: 'Cancelled',
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
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
  const jobs = useMemo(
    () =>
      JOBS.filter(
        (job) =>
          `${job.text} ${job.account}`.toLowerCase().includes(query.toLowerCase()) &&
          (view === 'All' ||
            (view === 'Needs attention'
              ? ['failed', 'retrying'].includes(job.state)
              : STATE_LABELS[job.state] === view)),
      ),
    [query, view],
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
            {jobs.length ? (
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
          <button className="filter-button">3 accounts</button>
          <button className="filter-button">All statuses</button>
        </div>
        {mode === 'Month' ? (
          <MonthCalendar />
        ) : mode === 'Timeline' ? (
          <TimelineCalendar />
        ) : (
          <TimeCalendar dayOnly={mode === 'Day'} />
        )}
      </section>
    </WorkspaceLayout>
  );
}

function MonthCalendar() {
  return (
    <div className="month-calendar" role="grid">
      <div className="month-weekdays">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="month-days">
        {Array.from({ length: 35 }, (_, index) => {
          const day = index + 1;
          return (
            <div className={day === 1 ? 'today' : ''} role="gridcell" key={day}>
              <time>{day}</time>
              {day === 1 &&
                JOBS.slice(0, 3).map((job) => (
                  <a
                    className={`calendar-job ${job.state}`}
                    href={`/w/atlas/jobs/${job.id}`}
                    key={job.id}
                  >
                    <strong>{formatTime(job.scheduledAt).split(', ').at(-1)}</strong>
                    {job.account}
                  </a>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeCalendar({ dayOnly }: { dayOnly: boolean }) {
  const days = dayOnly ? ['Tue 1'] : ['Mon 31', 'Tue 1', 'Wed 2', 'Thu 3', 'Fri 4'];
  return (
    <div className="time-calendar">
      <div className="time-header">
        <span />
        {days.map((day) => (
          <strong key={day}>{day}</strong>
        ))}
      </div>
      <div className="time-grid">
        <div className="time-labels">
          {['08:00', '10:00', '12:00', '14:00', '16:00'].map((time) => (
            <span key={time}>{time}</span>
          ))}
        </div>
        {days.map((day, index) => (
          <div className="time-day" key={day}>
            {(dayOnly || index === 1) &&
              JOBS.slice(0, 3).map((job, jobIndex) => (
                <a
                  className={`calendar-block ${job.state}`}
                  style={{ top: `${String(42 + jobIndex * 72)}px` }}
                  href={`/w/atlas/jobs/${job.id}`}
                  key={job.id}
                >
                  <strong>{job.account}</strong>
                  <span>{job.text}</span>
                </a>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineCalendar() {
  return (
    <div className="timeline-calendar">
      <div className="timeline-hours">
        <span />
        {['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'].map((hour) => (
          <span key={hour}>{hour}</span>
        ))}
      </div>
      {JOBS.slice(0, 3).map((job) => (
        <div className="timeline-lane" key={job.account}>
          <strong>{job.account}</strong>
          <a className={`timeline-job ${job.state}`} href={`/w/atlas/jobs/${job.id}`}>
            {job.text}
          </a>
        </div>
      ))}
    </div>
  );
}

export function JobDetailPage() {
  const initial = JOBS.find((job) => window.location.pathname.endsWith(job.id)) ?? JOBS.at(0);
  if (!initial) throw new Error('Job fixture is unavailable');
  const [job, setJob] = useState(initial);
  const [dialog, setDialog] = useState<'cancel' | 'retry' | null>(null);
  return (
    <WorkspaceLayout active="queue">
      <div className="detail-route">
        <a className="back-link" href="/w/atlas/queue">
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
            {job.state === 'published' && (
              <a className="secondary-button" href="https://x.com" rel="noreferrer">
                Open external post ↗
              </a>
            )}
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
                  Timezone<strong>Europe/Sofia (EEST, UTC+3)</strong>
                </span>
              </div>
            </section>
            <aside>
              <h2>Execution timeline</h2>
              <ol className="execution-timeline">
                <li className="complete">
                  <strong>Post created</strong>
                  <span>Aug 31 · 4:18 PM</span>
                </li>
                <li className="complete">
                  <strong>Scheduled</strong>
                  <span>Sep 1 · 9:30 AM</span>
                </li>
                {job.state === 'failed' && (
                  <li className="failed">
                    <strong>Dispatch failed</strong>
                    <span>Provider temporarily unavailable</span>
                  </li>
                )}
                {job.state === 'retrying' && (
                  <li className="active">
                    <strong>Retry queued</strong>
                    <span>Next attempt in 4 minutes</span>
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
                  X returned a temporary service error. Retrying is safe and will not create a
                  duplicate visible job.
                </p>
                <details>
                  <summary>Technical details</summary>
                  <code>provider_unavailable · attempt 2 of 5</code>
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
                onClick={() => {
                  setJob({ ...job, state: dialog === 'cancel' ? 'cancelled' : 'retrying' });
                  setDialog(null);
                }}
              >
                {dialog === 'cancel' ? 'Cancel job' : 'Retry safely'}
              </button>
            </div>
          </section>
        </div>
      )}
    </WorkspaceLayout>
  );
}
