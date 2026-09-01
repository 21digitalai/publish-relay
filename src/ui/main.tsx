import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { CalendarPage, JobDetailPage, QueuePage } from './workflow.js';

interface Account {
  id: string;
  provider: string;
  name: string;
  handle: string;
  health: 'Connected' | 'Reconnect required';
}

function getCsrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((value) => value.startsWith('publish_relay_csrf='));
  return entry ? (entry.split('=')[1] ?? '') : '';
}

async function beginXConnection(): Promise<void> {
  const response = await fetch('/api/oauth/x', {
    method: 'POST',
    headers: { 'x-csrf-token': getCsrfToken() },
  });
  const result = (await response.json()) as {
    data: { authorizationUrl: string } | null;
    error: string | null;
  };
  if (!response.ok || !result.data) throw new Error(result.error ?? 'Could not start X connection');
  window.location.href = result.data.authorizationUrl;
}

function formText(fields: FormData, name: string): string {
  const value = fields.get(name);
  return typeof value === 'string' ? value : '';
}

function Mark({ provider }: { provider: string }) {
  const isX = provider.toLowerCase() === 'x';
  return (
    <span className={`provider-mark ${isX ? 'x' : 'generic'}`} aria-hidden="true">
      {isX ? 'X' : provider.slice(0, 1).toUpperCase()}
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
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceSlug, setWorkspaceSlug] = useState('');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(true);
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
        setIsWorkspaceLoading(false);
      })
      .catch(() => {
        setWorkspaceError('Could not load the workspace');
        setIsWorkspaceLoading(false);
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
                  disabled={isWorkspaceLoading}
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
                  disabled={isWorkspaceLoading}
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
              <button
                className="provider-connect-card"
                onClick={() => {
                  setWorkspaceError(null);
                  void beginXConnection().catch((error: unknown) => {
                    setWorkspaceError(
                      error instanceof Error ? error.message : 'Could not start X connection',
                    );
                  });
                }}
              >
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
              disabled={
                step === 1 &&
                (isWorkspaceLoading || !workspaceName.trim() || !workspaceSlug.trim() || isSaving)
              }
            >
              {isWorkspaceLoading
                ? 'Loading…'
                : isSaving
                  ? 'Saving…'
                  : step === 3
                    ? 'Open workspace'
                    : 'Continue'}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

export function Rail({
  open,
  onClose,
  active = 'accounts',
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  active?: 'queue' | 'calendar' | 'accounts' | 'settings';
  onCreate?: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<
    { id: string; slug: string; name: string; role: string }[]
  >([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const activeSlug = window.location.pathname.split('/')[2] ?? '';
  useEffect(() => {
    void fetch('/api/workspaces')
      .then(async (response) => {
        if (!response.ok) throw new Error('Workspaces could not be loaded');
        return response.json() as Promise<{ data: { workspaces: typeof workspaces } }>;
      })
      .then((result) => {
        setWorkspaces(result.data.workspaces);
      })
      .catch(() => {
        setWorkspaceError('Workspaces could not be loaded');
      });
  }, []);
  useEffect(() => {
    if (workspaceOpen) searchRef.current?.focus();
  }, [workspaceOpen]);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.slug === activeSlug) ?? workspaces[0];
  const visibleWorkspaces = workspaces.filter((workspace) =>
    workspace.name.toLowerCase().includes(workspaceQuery.toLowerCase()),
  );
  const workspaceHref = (destination: string) =>
    `/w/${activeWorkspace?.slug ?? (activeSlug || 'workspace')}/${destination}`;
  return (
    <aside className={`app-rail ${open ? 'open' : ''}`} aria-label="Primary navigation">
      <div className="rail-header">
        <a className="brand-lockup" href={workspaceHref('accounts')}>
          <span className="brand-signal" /> Publish Relay
        </a>
        <button className="rail-close" onClick={onClose} aria-label="Close navigation">
          ×
        </button>
      </div>
      <button
        className="workspace-switcher"
        aria-haspopup="listbox"
        aria-expanded={workspaceOpen}
        onClick={() => {
          setWorkspaceOpen((current) => !current);
        }}
      >
        <span>
          <strong>{activeWorkspace?.name ?? 'Loading workspace…'}</strong>
          <small>{activeWorkspace?.role ?? 'Authenticated workspace'}</small>
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {workspaceOpen && (
        <div className="workspace-menu">
          <label className="workspace-search-label">
            <span className="sr-only">Search workspaces</span>
            <input
              ref={searchRef}
              className="workspace-search-input"
              value={workspaceQuery}
              placeholder="Search workspaces"
              onChange={(event) => {
                setWorkspaceQuery(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setWorkspaceOpen(false);
              }}
            />
          </label>
          {workspaceError && <p className="workspace-menu-error">{workspaceError}</p>}
          <div className="workspace-options" role="listbox" aria-label="Workspaces">
            {visibleWorkspaces.map((workspace) => (
              <button
                className={`workspace-option ${workspace.id === activeWorkspace?.id ? 'selected' : ''}`}
                role="option"
                aria-selected={workspace.id === activeWorkspace?.id}
                key={workspace.id}
                onClick={() => {
                  if (workspace.id === activeWorkspace?.id) {
                    setWorkspaceOpen(false);
                    return;
                  }
                  setWorkspaceError(null);
                  void fetch(`/api/workspaces/${workspace.id}/switch`, {
                    method: 'POST',
                    headers: { 'x-csrf-token': getCsrfToken() },
                  })
                    .then((response) => {
                      if (!response.ok) throw new Error('Workspace could not be opened');
                      window.location.href = `/w/${workspace.slug}/accounts`;
                    })
                    .catch(() => {
                      setWorkspaceError('Workspace could not be opened');
                    });
                }}
              >
                <span>
                  <strong>{workspace.name}</strong>
                  <small>{workspace.role}</small>
                </span>
                {workspace.id === activeWorkspace?.id && <span aria-hidden="true">✓</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <button className="create-post-button" onClick={onCreate}>
        <span aria-hidden="true">＋</span> Create post
      </button>
      <nav className="rail-nav">
        <a
          className={active === 'queue' ? 'active' : ''}
          href={workspaceHref('queue')}
          aria-current={active === 'queue' ? 'page' : undefined}
        >
          ▤ <span>Queue</span>
        </a>
        <a
          className={active === 'calendar' ? 'active' : ''}
          href={workspaceHref('calendar')}
          aria-current={active === 'calendar' ? 'page' : undefined}
        >
          ▦ <span>Calendar</span>
        </a>
        <a
          className={active === 'accounts' ? 'active' : ''}
          href={workspaceHref('accounts')}
          aria-current={active === 'accounts' ? 'page' : undefined}
        >
          ◉ <span>Accounts</span>
        </a>
        <a
          className={active === 'settings' ? 'active' : ''}
          href={workspaceHref('settings/workspace')}
          aria-current={active === 'settings' ? 'page' : undefined}
        >
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
  onReconnect,
}: {
  account: Account;
  onDisconnect: (account: Account) => void;
  onReconnect: () => void;
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
        <span>Connection status is current</span>
      </div>
      <div className="account-actions">
        {needsReconnect && (
          <button className="secondary-button reconnect" onClick={onReconnect}>
            Reconnect
          </button>
        )}
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
  const [actionError, setActionError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const loadAccounts = useCallback(() => {
    setLoadState('loading');
    setActionError(null);
    void fetch('/api/provider-accounts')
      .then(async (response) => {
        if (!response.ok) throw new Error('Accounts could not be loaded');
        return response.json() as Promise<{
          data: {
            accounts: {
              id: string;
              provider: string;
              displayName: string;
              status: string;
              updatedAt: string;
            }[];
          };
        }>;
      })
      .then(({ data }) => {
        setAccounts(
          data.accounts.map((account) => {
            const handleMatch = /\(@([^)]*)\)$/.exec(account.displayName);
            return {
              id: account.id,
              provider: account.provider.toLowerCase() === 'x' ? 'X' : account.provider,
              name: account.displayName.replace(/ \(@[^)]*\)$/, ''),
              handle: handleMatch?.[1] ? `@${handleMatch[1]}` : account.displayName,
              health: account.status === 'active' ? 'Connected' : 'Reconnect required',
            };
          }),
        );
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : 'Accounts could not be loaded');
        setLoadState('error');
      });
  }, []);
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);
  const connectX = () => {
    setActionError(null);
    void beginXConnection().catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : 'Could not start X connection');
    });
  };
  const visible = useMemo(
    () =>
      accounts.filter(
        (account) =>
          `${account.name} ${account.handle}`.toLowerCase().includes(query.toLowerCase()) &&
          (health === 'All health' || account.health === health),
      ),
    [accounts, query, health],
  );
  const groups = [...new Set(visible.map((account) => account.provider))];
  const previewState = new URLSearchParams(window.location.search).get('state');
  const renderedState = previewState ?? loadState;
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
          <button className="primary-button connect-account" onClick={connectX}>
            ＋ Connect account
          </button>
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
          {actionError && (
            <div className="accounts-error" role="alert">
              <p>{actionError}</p>
            </div>
          )}
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
          {renderedState === 'loading' && (
            <div className="account-skeletons" aria-label="Loading accounts">
              <div />
              <div />
              <div />
            </div>
          )}
          {renderedState === 'error' && (
            <div className="accounts-error" role="alert">
              <h2>Accounts could not be loaded</h2>
              <p>The connection service did not respond. Your schedules are unchanged.</p>
              <button className="secondary-button" onClick={loadAccounts}>
                Try again
              </button>
            </div>
          )}
          {(renderedState === 'empty' || (renderedState === 'ready' && accounts.length === 0)) && (
            <div className="filter-empty">
              <h2>Connect your first account</h2>
              <p>Add a provider account to start scheduling from this workspace.</p>
              <button className="primary-button" onClick={connectX}>
                Connect account
              </button>
            </div>
          )}
          {renderedState === 'ready' &&
            accounts.length > 0 &&
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
                    <button className="text-button" onClick={connectX}>
                      ＋ Connect another
                    </button>
                  </header>
                  <div className="account-list">
                    {rows.map((account) => (
                      <AccountRow
                        account={account}
                        key={account.id}
                        onDisconnect={setDisconnecting}
                        onReconnect={() => {
                          connectX();
                        }}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          {renderedState === 'ready' && accounts.length > 0 && !visible.length && (
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
              Scheduled jobs for <strong>{disconnecting.handle}</strong> must be cancelled first.
              Published posts will remain live.
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
                  const accountId = disconnecting.id;
                  setActionError(null);
                  void fetch(`/api/provider-accounts/${accountId}`, {
                    method: 'DELETE',
                    headers: { 'x-csrf-token': getCsrfToken() },
                  })
                    .then(async (response) => {
                      const result = (await response.json()) as { error: string | null };
                      if (!response.ok)
                        throw new Error(result.error ?? 'Could not disconnect account');
                      setAccounts((current) =>
                        current.filter((account) => account.id !== accountId),
                      );
                      setDisconnecting(null);
                    })
                    .catch((error: unknown) => {
                      setDisconnecting(null);
                      setActionError(
                        error instanceof Error ? error.message : 'Could not disconnect account',
                      );
                    });
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
  if (/\/w\/[^/]+\/queue$/.test(path)) return <QueuePage />;
  if (/\/w\/[^/]+\/calendar$/.test(path)) return <CalendarPage />;
  if (/\/w\/[^/]+\/jobs\/[^/]+$/.test(path)) return <JobDetailPage />;
  return <AccountsPage />;
}

const root = document.getElementById('root');
if (!root) throw new Error('UI root element is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
