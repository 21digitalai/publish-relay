import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

interface Account {
  id: string;
  provider: 'X' | 'Instagram';
  name: string;
  handle: string;
  health: 'Connected' | 'Reconnect required';
  capabilities: string;
  lastSync: string;
}

const accounts: Account[] = [
  {
    id: 'x-daily',
    provider: 'X',
    name: 'Daily Viber',
    handle: '@dailyviber',
    health: 'Connected',
    capabilities: 'Posts · Media',
    lastSync: 'Today, 18:42 EEST',
  },
  {
    id: 'x-studio',
    provider: 'X',
    name: 'Studio Notes',
    handle: '@studionotes',
    health: 'Reconnect required',
    capabilities: 'Posts',
    lastSync: 'Aug 29, 11:08 EEST',
  },
  {
    id: 'ig-mira',
    provider: 'Instagram',
    name: 'Mira Studio',
    handle: '@mirastudio',
    health: 'Connected',
    capabilities: 'Posts · Reels',
    lastSync: 'Today, 18:39 EEST',
  },
];

function formText(fields: FormData, name: string): string {
  const value = fields.get(name);
  return typeof value === 'string' ? value : '';
}

function Mark({ provider }: { provider: Account['provider'] }) {
  return (
    <span className={`provider-mark ${provider === 'X' ? 'x' : 'instagram'}`} aria-hidden="true">
      {provider === 'X' ? 'X' : '◎'}
    </span>
  );
}

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isRegister = mode === 'register';
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        <a className="brand-lockup" href="/login">
          <span className="brand-signal" /> Publish Relay
        </a>
        <p className="eyebrow">{isRegister ? 'Create your workspace' : 'Welcome back'}</p>
        <h1 id="auth-title">
          {isRegister ? 'Start scheduling clearly' : 'Sign in to your cockpit'}
        </h1>
        <p className="auth-intro">
          Manage every account, schedule, and recovery path in one focused place.
        </p>
        {error && (
          <div className="form-summary" role="alert">
            {error}
          </div>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            void (async () => {
              setError(null);
              setIsSubmitting(true);
              const fields = new FormData(form);
              const workspaceName = formText(fields, 'workspaceName');
              const payload = isRegister
                ? {
                    displayName: formText(fields, 'displayName'),
                    email: formText(fields, 'email'),
                    password: formText(fields, 'password'),
                    workspaceName,
                  }
                : {
                    email: formText(fields, 'email'),
                    password: formText(fields, 'password'),
                  };
              try {
                const response = await fetch(
                  isRegister ? '/api/auth/register' : '/api/auth/login',
                  {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                  },
                );
                const result = (await response.json()) as { error: string | null };
                if (!response.ok) throw new Error(result.error ?? 'Authentication failed');
                if (isRegister) {
                  sessionStorage.setItem('publish-relay-workspace-name', workspaceName);
                  window.location.href = '/onboarding/workspace';
                } else window.location.href = '/app';
              } catch (submissionError) {
                setError(
                  submissionError instanceof Error
                    ? submissionError.message
                    : 'Authentication failed',
                );
                setIsSubmitting(false);
              }
            })();
          }}
          noValidate
        >
          {isRegister && (
            <label className="field-label">
              Name
              <input className="text-input" name="displayName" autoComplete="name" required />
            </label>
          )}
          {isRegister && (
            <label className="field-label">
              Workspace name
              <input className="text-input" name="workspaceName" required />
            </label>
          )}
          <label className="field-label">
            Email
            <input className="text-input" name="email" type="email" autoComplete="email" required />
          </label>
          <label className="field-label">
            Password
            <span className="password-field">
              <input
                className="text-input"
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                required
              />
              <button
                className="reveal-password"
                type="button"
                onClick={() => {
                  setShowPassword((value) => !value);
                }}
                aria-pressed={showPassword}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
          </label>
          {isRegister && (
            <p className="field-hint">Use at least 12 characters, including a number and symbol.</p>
          )}
          {!isRegister && (
            <a className="forgot-link" href="/forgot-password">
              Forgot password?
            </a>
          )}
          <button className="primary-button" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <p className="auth-switch">
          {isRegister ? 'Already have an account?' : 'New to Publish Relay?'}{' '}
          <a href={isRegister ? '/login' : '/register'}>
            {isRegister ? 'Sign in' : 'Create account'}
          </a>
        </p>
      </section>
    </main>
  );
}

function ForgotPasswordPage() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="recovery-title">
        <a className="brand-lockup" href="/login">
          <span className="brand-signal" /> Publish Relay
        </a>
        <p className="eyebrow">Account recovery</p>
        <h1 id="recovery-title">Recovery is not available yet</h1>
        <p className="auth-intro">
          Contact support for assistance. We will not claim that an email was sent while recovery
          delivery is unavailable.
        </p>
        <a className="primary-button" href="/login">
          Return to sign in
        </a>
      </section>
    </main>
  );
}

function OnboardingPage() {
  const [step, setStep] = useState(1);
  const initialWorkspaceName = sessionStorage.getItem('publish-relay-workspace-name') ?? '';
  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [workspaceSlug, setWorkspaceSlug] = useState(
    initialWorkspaceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, ''),
  );
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  useEffect(() => {
    void fetch('/api/workspaces/current')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load the workspace');
        return response.json() as Promise<{
          data: { name: string; slug: string };
          error: null;
        }>;
      })
      .then(({ data }) => {
        setWorkspaceName(data.name);
        setWorkspaceSlug(data.slug);
      })
      .catch(() => {
        setWorkspaceError('Could not load the workspace');
      });
  }, []);
  const titles = ['Name your workspace', 'Connect your first account', 'Schedule your first post'];
  return (
    <main className="onboarding-page">
      <header className="onboarding-header">
        <a className="brand-lockup" href="/login">
          <span className="brand-signal" /> Publish Relay
        </a>
        <span>Step {step} of 3</span>
      </header>
      <div className="onboarding-layout">
        <ol className="step-list" aria-label="Onboarding progress">
          {titles.map((title, index) => (
            <li
              className={index + 1 === step ? 'active' : index + 1 < step ? 'complete' : ''}
              key={title}
            >
              <span>{index + 1 < step ? '✓' : index + 1}</span>
              <div>
                <strong>{title}</strong>
                <small>
                  {index === 0
                    ? 'Set the shared context'
                    : index === 1
                      ? 'Choose where to publish'
                      : 'See the workflow end to end'}
                </small>
              </div>
            </li>
          ))}
        </ol>
        <section className="onboarding-panel" aria-labelledby="onboarding-title">
          <p className="eyebrow">Workspace setup</p>
          <h1 id="onboarding-title">{titles[step - 1]}</h1>
          {step === 1 && (
            <>
              <p>Workspaces keep accounts, schedules, and team access together.</p>
              <label className="field-label">
                Workspace name
                <input
                  className="text-input"
                  value={workspaceName}
                  onChange={(event) => {
                    setWorkspaceName(event.target.value);
                  }}
                />
              </label>
              <p className="field-hint">You can change this later in workspace settings.</p>
              <label className="field-label">
                Workspace URL
                <input
                  className="text-input"
                  value={workspaceSlug}
                  onChange={(event) => {
                    setWorkspaceSlug(event.target.value);
                  }}
                />
              </label>
              {workspaceError && (
                <div className="form-summary" role="alert">
                  {workspaceError}
                </div>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <p>
                Connect securely through the provider. Publish Relay never asks you to paste account
                tokens.
              </p>
              <button className="provider-connect-card">
                <Mark provider="X" />
                <span>
                  <strong>Connect X</strong>
                  <small>Posts and media · secure redirect</small>
                </span>
                <span aria-hidden="true">→</span>
              </button>
              <button className="provider-connect-card">
                <Mark provider="Instagram" />
                <span>
                  <strong>Connect Instagram</strong>
                  <small>Available after X setup</small>
                </span>
                <span className="coming-soon">Soon</span>
              </button>
            </>
          )}
          {step === 3 && (
            <>
              <p>
                Your workspace is ready. Create a scheduled post now or enter an empty workspace and
                explore.
              </p>
              <div className="onboarding-receipt">
                <span>✓</span>
                <div>
                  <strong>{workspaceName || 'Your workspace'} is ready</strong>
                  <small>Timezone: Europe/Sofia (EEST)</small>
                </div>
              </div>
            </>
          )}
          <div className="onboarding-actions">
            {step > 1 && (
              <button
                className="secondary-button"
                onClick={() => {
                  setStep((value) => value - 1);
                }}
              >
                Back
              </button>
            )}
            <span />
            {step === 2 && (
              <button
                className="text-button"
                onClick={() => {
                  setStep(3);
                }}
              >
                Skip for now
              </button>
            )}
            <button
              className="primary-button"
              onClick={() => {
                void (async () => {
                  if (step === 1) {
                    setIsSaving(true);
                    setWorkspaceError(null);
                    const csrfToken = document.cookie
                      .split('; ')
                      .find((entry) => entry.startsWith('publish_relay_csrf='))
                      ?.split('=')[1];
                    const response = await fetch('/api/workspaces/current', {
                      method: 'PATCH',
                      headers: {
                        'content-type': 'application/json',
                        'x-csrf-token': csrfToken ?? '',
                      },
                      body: JSON.stringify({ name: workspaceName, slug: workspaceSlug }),
                    });
                    const result = (await response.json()) as {
                      data: { name: string; slug: string } | null;
                      error: string | null;
                    };
                    if (!response.ok) {
                      setWorkspaceError(result.error ?? 'Could not update the workspace');
                      setIsSaving(false);
                      return;
                    }
                    if (result.data) {
                      setWorkspaceName(result.data.name);
                      setWorkspaceSlug(result.data.slug);
                    }
                    setIsSaving(false);
                    setStep(2);
                  } else if (step < 3) setStep((value) => value + 1);
                  else window.location.href = `/w/${workspaceSlug}/accounts`;
                })();
              }}
              disabled={step === 1 && (!workspaceName.trim() || !workspaceSlug.trim() || isSaving)}
            >
              {isSaving ? 'Saving…' : step === 3 ? 'Open workspace' : 'Continue'}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

function Rail({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <aside className={`app-rail ${open ? 'open' : ''}`} aria-label="Primary navigation">
      <div className="rail-header">
        <a className="brand-lockup" href="/w/atlas/accounts">
          <span className="brand-signal" /> Publish Relay
        </a>
        <button className="rail-close" onClick={onClose} aria-label="Close navigation">
          ×
        </button>
      </div>
      <button className="workspace-switcher">
        <span>
          <strong>Atlas Studio</strong>
          <small>Owner · 3 accounts</small>
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      <button className="create-post-button">
        <span aria-hidden="true">＋</span> Create post
      </button>
      <nav className="rail-nav">
        <a href="/w/atlas/queue">
          ▤ <span>Queue</span>
        </a>
        <a href="/w/atlas/calendar">
          ▦ <span>Calendar</span>
        </a>
        <a className="active" href="/w/atlas/accounts" aria-current="page">
          ◉ <span>Accounts</span>
        </a>
        <a href="/w/atlas/settings/workspace">
          ⚙ <span>Settings</span>
        </a>
      </nav>
      <div className="rail-footer">
        <div className="connection-health">
          <span className="health-dot" /> All systems operational
        </div>
        <button className="user-menu">
          <span className="avatar">PA</span>
          <span>
            <strong>Plamen</strong>
            <small>plamen@example.com</small>
          </span>
        </button>
      </div>
    </aside>
  );
}

function AccountRow({
  account,
  onDisconnect,
}: {
  account: Account;
  onDisconnect: (account: Account) => void;
}) {
  const needsReconnect = account.health === 'Reconnect required';
  return (
    <article className="account-row">
      <div className="account-identity">
        <span className="account-avatar">{account.name.slice(0, 2).toUpperCase()}</span>
        <div>
          <strong>{account.name}</strong>
          <span>{account.handle}</span>
        </div>
      </div>
      <div className="account-provider">
        <Mark provider={account.provider} />
        <span>{account.provider}</span>
      </div>
      <div>
        <span className={`status-badge ${needsReconnect ? 'warning' : 'success'}`}>
          <span aria-hidden="true">{needsReconnect ? '!' : '✓'}</span> {account.health}
        </span>
      </div>
      <div className="account-capabilities">
        <strong>{account.capabilities}</strong>
        <span>Last sync {account.lastSync}</span>
      </div>
      <div className="account-actions">
        {needsReconnect && <button className="secondary-button reconnect">Reconnect</button>}
        <button
          className="icon-button"
          aria-label={`More actions for ${account.name}`}
          onClick={() => {
            onDisconnect(account);
          }}
        >
          •••
        </button>
      </div>
    </article>
  );
}

function AccountsPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [health, setHealth] = useState('All health');
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);
  const visible = useMemo(
    () =>
      accounts.filter(
        (account) =>
          `${account.name} ${account.handle}`.toLowerCase().includes(query.toLowerCase()) &&
          (health === 'All health' || account.health === health),
      ),
    [query, health],
  );
  const groups = ['X', 'Instagram'] as const;
  const previewState = new URLSearchParams(window.location.search).get('state');
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
      />
      <main className="main-content" id="main-content">
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
        <div className="page-heading">
          <div>
            <p className="eyebrow">Workspace settings</p>
            <h1>Connected accounts</h1>
            <p>Manage publishing access and connection health for Atlas Studio.</p>
          </div>
          <button className="primary-button connect-account">＋ Connect account</button>
        </div>
        <section className="account-summary" aria-label="Account health summary">
          <div>
            <strong>3</strong>
            <span>Connected accounts</span>
          </div>
          <div>
            <strong className="success-text">2</strong>
            <span>Healthy</span>
          </div>
          <div>
            <strong className="warning-text">1</strong>
            <span>Needs attention</span>
          </div>
        </section>
        <section className="accounts-section" aria-labelledby="accounts-title">
          <h2 id="accounts-title" className="sr-only">
            Accounts
          </h2>
          <div className="account-toolbar">
            <label className="search-control">
              <span aria-hidden="true">⌕</span>
              <input
                className="account-search"
                placeholder="Search name or handle"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
            <label className="filter-label">
              Health
              <select
                className="health-filter"
                value={health}
                onChange={(event) => {
                  setHealth(event.target.value);
                }}
              >
                <option>All health</option>
                <option>Connected</option>
                <option>Reconnect required</option>
              </select>
            </label>
          </div>
          {previewState === 'loading' && (
            <div className="account-skeletons" aria-label="Loading accounts">
              <div />
              <div />
              <div />
            </div>
          )}
          {previewState === 'error' && (
            <div className="accounts-error" role="alert">
              <h2>Accounts could not be loaded</h2>
              <p>The connection service did not respond. Your schedules are unchanged.</p>
              <button className="secondary-button">Try again</button>
            </div>
          )}
          {previewState === 'empty' && (
            <div className="filter-empty">
              <h2>Connect your first account</h2>
              <p>Add a provider account to start scheduling from this workspace.</p>
              <button className="primary-button">Connect account</button>
            </div>
          )}
          {!previewState &&
            groups.map((provider) => {
              const rows = visible.filter((account) => account.provider === provider);
              if (!rows.length) return null;
              return (
                <section className="provider-group" key={provider}>
                  <header>
                    <div>
                      <Mark provider={provider} />
                      <div>
                        <h2>{provider}</h2>
                        <span>
                          {rows.length} {rows.length === 1 ? 'account' : 'accounts'}
                        </span>
                      </div>
                    </div>
                    <button className="text-button">＋ Connect another</button>
                  </header>
                  <div className="account-list">
                    {rows.map((account) => (
                      <AccountRow
                        account={account}
                        key={account.id}
                        onDisconnect={setDisconnecting}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          {!visible.length && (
            <div className="filter-empty">
              <h2>No accounts match these filters</h2>
              <p>Try another name or reset the health filter.</p>
              <button
                className="secondary-button"
                onClick={() => {
                  setQuery('');
                  setHealth('All health');
                }}
              >
                Clear filters
              </button>
            </div>
          )}
        </section>
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
      {disconnecting && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="disconnect-title"
          >
            <span className="danger-icon">!</span>
            <h2 id="disconnect-title">Disconnect {disconnecting.name}?</h2>
            <p>
              Scheduled jobs for <strong>{disconnecting.handle}</strong> will be paused. Published
              posts will remain live.
            </p>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                autoFocus
                onClick={() => {
                  setDisconnecting(null);
                }}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => {
                  setDisconnecting(null);
                }}
              >
                Disconnect account
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export function App() {
  const path = window.location.pathname;
  if (path === '/register') return <AuthPage mode="register" />;
  if (path === '/login' || path === '/') return <AuthPage mode="login" />;
  if (path === '/forgot-password') return <ForgotPasswordPage />;
  if (path.startsWith('/onboarding/')) return <OnboardingPage />;
  return <AccountsPage />;
}

const root = document.getElementById('root');
if (!root) throw new Error('UI root element is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
