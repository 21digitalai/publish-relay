import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';
import { DefaultsSelect } from './defaults-select.js';
import { LiveRegion } from './feedback.js';
import { PostingAdapterList } from './posting-adapter-list.js';
import { getPostingAdapter, type PostingAdapterConfig } from './posting-adapter-registry.js';
import {
  CalendarPage,
  ExternalDraftPage,
  JobDetailPage,
  QueuePage,
  WorkspaceLayout,
} from './workflow.js';

interface Account {
  id: string;
  provider: string;
  name: string;
  handle: string;
  health: 'Connected' | 'Reconnect required';
  expiresAt?: string | null;
  adapterDefaults: {
    privacyStatus?: 'public' | 'unlisted' | 'private';
    madeForKids?: boolean;
    notifySubscribers?: boolean;
    tags?: string[];
    categoryId?: string;
  };
}

const YOUTUBE_CATEGORIES: [string, string][] = [
  ['', 'No category'],
  ['1', 'Film & Animation'],
  ['2', 'Autos & Vehicles'],
  ['10', 'Music'],
  ['15', 'Pets & Animals'],
  ['17', 'Sports'],
  ['19', 'Travel & Events'],
  ['20', 'Gaming'],
  ['22', 'People & Blogs'],
  ['23', 'Comedy'],
  ['24', 'Entertainment'],
  ['25', 'News & Politics'],
  ['26', 'Howto & Style'],
  ['27', 'Education'],
  ['28', 'Science & Technology'],
  ['29', 'Nonprofits & Activism'],
];

function getCsrfToken(): string {
  const entry = document.cookie
    .split('; ')
    .find((value) => value.startsWith('publish_relay_csrf='));
  return entry ? (entry.split('=')[1] ?? '') : '';
}

async function beginAdapterConnection(adapter: PostingAdapterConfig): Promise<void> {
  const response = await fetch(adapter.auth.startPath, {
    method: 'POST',
    headers: { 'x-csrf-token': getCsrfToken() },
  });
  const result = (await response.json()) as {
    data: { authorizationUrl: string } | null;
    error: string | null;
  };
  if (!response.ok || !result.data)
    throw new Error(result.error ?? `Could not start ${adapter.label} connection`);
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

function AuthPage({ mode }: { mode: 'login' | 'register' | 'forgot' }) {
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLink, setMagicLink] = useState<{ message: string; developmentUrl?: string } | null>(
    null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const usesMagicLinks = document.body.dataset.humanAuthMode === 'magic_link';
  const isRegister = mode === 'register' && !usesMagicLinks;
  const isForgot = mode === 'forgot' && !usesMagicLinks;
  const usesPasswordLogin = !isRegister && !isForgot && !usesMagicLinks;
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="auth-title">
        <a className="brand-lockup" href="/login">
          <span className="brand-signal" /> Publish Relay
        </a>
        <p className="eyebrow">
          {usesMagicLinks
            ? 'Email access'
            : isRegister
              ? 'Create your workspace'
              : isForgot
                ? 'Account recovery'
                : 'Welcome back'}
        </p>
        <h1 id="auth-title">
          {usesMagicLinks
            ? 'Continue to Publish Relay'
            : isRegister
              ? 'Start scheduling clearly'
              : isForgot
                ? 'Email a recovery link'
                : 'Sign in to your cockpit'}
        </h1>
        <p className="auth-intro">
          {usesMagicLinks
            ? 'Enter your email and we will send a secure one-time link. New emails create an account automatically.'
            : isForgot
              ? 'Password recovery is not available yet. Contact support for assistance.'
              : 'Manage every account, schedule, and recovery path in one focused place.'}
        </p>
        {error && (
          <div className="form-summary" role="alert">
            {error}
          </div>
        )}
        {magicLink && (
          <div className="magic-link-receipt" role="status">
            <strong>Check your email</strong>
            <span>{magicLink.message}</span>
            {magicLink.developmentUrl && (
              <a href={magicLink.developmentUrl}>Open development sign-in link</a>
            )}
          </div>
        )}
        {!isForgot && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              void (async () => {
                setError(null);
                setMagicLink(null);
                setIsSubmitting(true);
                const fields = new FormData(form);
                const workspaceName = formText(fields, 'workspaceName');
                const continuation = new URLSearchParams(window.location.search).get('next');
                const payload = isRegister
                  ? {
                      displayName: formText(fields, 'displayName'),
                      email: formText(fields, 'email'),
                      workspaceName,
                      password: formText(fields, 'password'),
                    }
                  : usesPasswordLogin
                    ? {
                        email: formText(fields, 'email'),
                        password: formText(fields, 'password'),
                        ...(continuation ? { redirectPath: continuation } : {}),
                      }
                    : {
                        email: formText(fields, 'email'),
                        ...(continuation ? { redirectPath: continuation } : {}),
                      };
                try {
                  const response = await fetch(
                    isRegister
                      ? '/api/auth/register'
                      : usesPasswordLogin
                        ? '/api/auth/login'
                        : '/api/auth/magic-link/request',
                    {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify(payload),
                    },
                  );
                  const result = (await response.json()) as {
                    data: {
                      message?: string;
                      developmentUrl?: string;
                      redirectPath?: string;
                    } | null;
                    error: string | null;
                  };
                  if (!response.ok) throw new Error(result.error ?? 'Authentication failed');
                  if (isRegister) {
                    sessionStorage.setItem('publish-relay-workspace-name', workspaceName);
                    window.location.href = '/onboarding/workspace';
                  } else if (usesPasswordLogin) {
                    window.location.href = result.data?.redirectPath ?? '/app';
                  } else {
                    setMagicLink({
                      message:
                        result.data?.message ??
                        'If the email can be used, a sign-in link is on its way.',
                      ...(result.data?.developmentUrl
                        ? { developmentUrl: result.data.developmentUrl }
                        : {}),
                    });
                    setIsSubmitting(false);
                  }
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
              <input
                className="text-input"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </label>
            {(isRegister || usesPasswordLogin) && (
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
            )}
            {isRegister && (
              <p className="field-hint">
                Use at least 12 characters, including a number and symbol.
              </p>
            )}
            <button className="primary-button" type="submit" disabled={isSubmitting}>
              {isSubmitting
                ? isRegister
                  ? 'Creating account…'
                  : usesPasswordLogin
                    ? 'Signing in…'
                    : 'Sending link…'
                : isRegister
                  ? 'Create account'
                  : usesPasswordLogin
                    ? 'Sign in'
                    : 'Email me a sign-in link'}
            </button>
          </form>
        )}
        {usesPasswordLogin && (
          <a className="auth-secondary-link" href="/forgot-password">
            Forgot password?
          </a>
        )}
        {!usesMagicLinks && (
          <p className="auth-switch">
            {isRegister
              ? 'Already have an account?'
              : isForgot
                ? 'Remembered where to sign in?'
                : 'New to Publish Relay?'}{' '}
            <a href={isRegister || isForgot ? '/login' : '/register'}>
              {isRegister || isForgot ? 'Sign in' : 'Create account'}
            </a>
          </p>
        )}
      </section>
    </main>
  );
}

function ConsentPage() {
  const [request, setRequest] = useState<{ client: { id: string }; scopes: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  useEffect(() => {
    void fetch(`${window.location.pathname}${window.location.search}`, {
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        const result = (await response.json()) as {
          data: { client: { id: string }; scopes: string[] } | null;
          error: { message?: string } | null;
        };
        if (!response.ok || !result.data)
          throw new Error(result.error?.message ?? 'Connection request is invalid');
        setRequest(result.data);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Connection request is invalid');
      });
  }, []);
  const approve = async () => {
    if (isApproving) return;
    setIsApproving(true);
    setError(null);
    try {
      const parameters = new URLSearchParams(window.location.search);
      const response = await fetch('/connect/authorize', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-csrf-token': getCsrfToken(),
        },
        body: JSON.stringify(Object.fromEntries(parameters.entries())),
      });
      const result = (await response.json()) as {
        data: { authorizationRedirect: string } | null;
      };
      if (!response.ok || !result.data) throw new Error('Connection approval failed');
      window.location.href = result.data.authorizationRedirect;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Connection approval failed');
      setIsApproving(false);
    }
  };
  const cancel = () => {
    const parameters = new URLSearchParams(window.location.search);
    const redirect = new URL(parameters.get('redirect_uri') ?? window.location.origin);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', parameters.get('state') ?? '');
    window.location.href = redirect.toString();
  };
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="consent-title">
        <a className="brand-lockup" href="/app">
          <span className="brand-signal" /> Publish Relay
        </a>
        <p className="eyebrow">Application connection</p>
        <h1 id="consent-title">Approve access</h1>
        {error && (
          <div className="form-summary" role="alert">
            {error}
          </div>
        )}
        {!request && !error && <p role="status">Checking connection request…</p>}
        {request && (
          <>
            <p className="auth-intro">
              <strong>{request.client.id}</strong> wants to connect to this Publish Relay workspace.
            </p>
            <div className="settings-card">
              <h2>Requested access</h2>
              <ul>
                {request.scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            </div>
            <button
              className="primary-button"
              disabled={isApproving}
              onClick={() => void approve()}
            >
              {isApproving ? 'Connecting…' : 'Approve connection'}
            </button>
            <button className="secondary-button" onClick={cancel}>
              Cancel
            </button>
          </>
        )}
      </section>
    </main>
  );
}

function ForgotPasswordPage() {
  return <AuthPage mode="forgot" />;
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
              <PostingAdapterList
                onSelect={(adapter) => {
                  setWorkspaceError(null);
                  void beginAdapterConnection(adapter).catch((error: unknown) => {
                    setWorkspaceError(
                      error instanceof Error
                        ? error.message
                        : `Could not start ${adapter.label} connection`,
                    );
                  });
                }}
              />
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
  const [profile, setProfile] = useState<{
    user: { displayName: string; email: string };
    workspace: { id: string; slug: string; name: string; role: string };
  } | null>(null);
  const [workspaces, setWorkspaces] = useState<
    { id: string; slug: string; name: string; role: string }[]
  >([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [activeWorkspaceIndex, setActiveWorkspaceIndex] = useState(0);
  const activeSlug = window.location.pathname.split('/')[2] ?? '';
  useEffect(() => {
    void fetch('/api/auth/session')
      .then(async (response) => {
        if (!response.ok) throw new Error('Profile could not be loaded');
        return response.json() as Promise<{ data: NonNullable<typeof profile> }>;
      })
      .then((result) => {
        setProfile(result.data);
      })
      .catch(() => {
        setProfile(null);
      });
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
    workspaces.find((workspace) => workspace.slug === activeSlug) ??
    workspaces[0] ??
    profile?.workspace;
  const initials = profile?.user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  const visibleWorkspaces = workspaces.filter((workspace) =>
    workspace.name.toLowerCase().includes(workspaceQuery.toLowerCase()),
  );
  const chooseWorkspace = (workspace: (typeof workspaces)[number]) => {
    if (workspace.id === activeWorkspace?.id) {
      setWorkspaceOpen(false);
      triggerRef.current?.focus();
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
  };
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
        ref={triggerRef}
        className="workspace-switcher"
        aria-haspopup="listbox"
        aria-expanded={workspaceOpen}
        onClick={() => {
          setWorkspaceOpen((current) => !current);
          setActiveWorkspaceIndex(0);
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
              role="combobox"
              aria-controls="workspace-options"
              aria-expanded="true"
              aria-activedescendant={
                visibleWorkspaces[activeWorkspaceIndex]
                  ? `workspace-option-${visibleWorkspaces[activeWorkspaceIndex].id}`
                  : undefined
              }
              onChange={(event) => {
                setWorkspaceQuery(event.target.value);
                setActiveWorkspaceIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setWorkspaceOpen(false);
                  triggerRef.current?.focus();
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveWorkspaceIndex((current) =>
                    Math.min(current + 1, visibleWorkspaces.length - 1),
                  );
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveWorkspaceIndex((current) => Math.max(current - 1, 0));
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  setActiveWorkspaceIndex(0);
                } else if (event.key === 'End') {
                  event.preventDefault();
                  setActiveWorkspaceIndex(Math.max(visibleWorkspaces.length - 1, 0));
                } else if (event.key === 'Enter' && visibleWorkspaces[activeWorkspaceIndex]) {
                  event.preventDefault();
                  chooseWorkspace(visibleWorkspaces[activeWorkspaceIndex]);
                }
              }}
            />
          </label>
          {workspaceError && <p className="workspace-menu-error">{workspaceError}</p>}
          <div
            id="workspace-options"
            className="workspace-options"
            role="listbox"
            aria-label="Workspaces"
          >
            {visibleWorkspaces.map((workspace, index) => (
              <button
                id={`workspace-option-${workspace.id}`}
                className={`workspace-option ${workspace.id === activeWorkspace?.id ? 'selected' : ''}`}
                role="option"
                aria-selected={workspace.id === activeWorkspace?.id}
                key={workspace.id}
                tabIndex={-1}
                onMouseEnter={() => {
                  setActiveWorkspaceIndex(index);
                }}
                onClick={() => {
                  chooseWorkspace(workspace);
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
      <button
        className="create-post-button"
        onClick={() => {
          if (onCreate) onCreate();
          else {
            window.sessionStorage.setItem('publish-relay-open-composer', 'true');
            window.location.href = workspaceHref('queue');
          }
        }}
      >
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
          <span className="health-dot" /> Signed in
        </div>
        <button className="user-menu">
          <span className="avatar">{profile ? initials : '—'}</span>
          <span>
            <strong>{profile?.user.displayName ?? 'Loading profile…'}</strong>
            <small>{profile?.user.email ?? 'Authenticated account'}</small>
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
  onDefaultsSaved,
}: {
  account: Account;
  onDisconnect: (account: Account) => void;
  onReconnect: () => void;
  onDefaultsSaved: (account: Account) => void;
}) {
  const needsReconnect = account.health === 'Reconnect required';
  const linkedinMillisecondsLeft =
    account.provider === 'LinkedIn' && account.expiresAt
      ? new Date(account.expiresAt).getTime() - Date.now()
      : null;
  const linkedinDaysLeft =
    linkedinMillisecondsLeft === null ? null : Math.ceil(linkedinMillisecondsLeft / 86_400_000);
  const linkedinExpiringSoon = linkedinDaysLeft !== null && linkedinDaysLeft <= 7;
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [defaultsAnnouncement, setDefaultsAnnouncement] = useState<string | null>(null);
  const [privacyStatus, setPrivacyStatus] = useState(
    account.adapterDefaults.privacyStatus ?? 'public',
  );
  const [madeForKids, setMadeForKids] = useState(
    account.adapterDefaults.madeForKids === true ? 'yes' : 'no',
  );
  const [notifySubscribers, setNotifySubscribers] = useState(
    account.adapterDefaults.notifySubscribers === true,
  );
  const [tags, setTags] = useState(account.adapterDefaults.tags?.join(', ') ?? '');
  const [categoryId, setCategoryId] = useState(account.adapterDefaults.categoryId ?? '');
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
        <span
          className={`status-badge ${needsReconnect || linkedinExpiringSoon ? 'warning' : 'success'}`}
        >
          <span aria-hidden="true">{needsReconnect || linkedinExpiringSoon ? '!' : '✓'}</span>{' '}
          {account.health}
        </span>
      </div>
      <div className="account-capabilities">
        <span>
          {needsReconnect
            ? `${account.provider} access needs reconnection before posting.`
            : linkedinDaysLeft !== null && linkedinDaysLeft <= 7
              ? linkedinMillisecondsLeft !== null && linkedinMillisecondsLeft < 86_400_000
                ? 'LinkedIn access expires in less than a day. Reconnect before expiry.'
                : `LinkedIn access expires in ${String(linkedinDaysLeft)} days. Reconnect before expiry.`
              : 'Connection status is current'}
        </span>
      </div>
      <div className="account-actions">
        {(needsReconnect || linkedinExpiringSoon) && (
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
      {account.provider === 'YouTube' && (
        <form
          className="youtube-defaults"
          onSubmit={(event) => {
            event.preventDefault();
            const fields = new FormData(event.currentTarget);
            const normalizedTags = formText(fields, 'tags')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean);
            const normalizedCategory = formText(fields, 'categoryId').trim();
            const defaults = {
              privacyStatus: formText(fields, 'privacyStatus') as 'public' | 'unlisted' | 'private',
              madeForKids: formText(fields, 'madeForKids') === 'yes',
              notifySubscribers: formText(fields, 'notifySubscribers') === 'true',
              ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
              ...(normalizedCategory ? { categoryId: normalizedCategory } : {}),
            };
            setDefaultsError(null);
            setDefaultsAnnouncement(null);
            setSavingDefaults(true);
            void fetch(`/api/provider-accounts/${account.id}/youtube-defaults`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
              body: JSON.stringify(defaults),
            })
              .then(async (response) => {
                const result = (await response.json()) as { error: string | null };
                if (!response.ok) throw new Error(result.error ?? 'Defaults could not be saved');
                onDefaultsSaved({ ...account, adapterDefaults: defaults });
                setDefaultsAnnouncement(`Publishing defaults saved for ${account.name}.`);
              })
              .catch((error: unknown) => {
                setDefaultsError(
                  error instanceof Error ? error.message : 'Defaults could not be saved',
                );
              })
              .finally(() => {
                setSavingDefaults(false);
              });
          }}
        >
          <strong>Publishing defaults</strong>
          <DefaultsSelect
            label="Visibility"
            name="privacyStatus"
            value={privacyStatus}
            options={[
              ['public', 'Public'],
              ['unlisted', 'Unlisted'],
              ['private', 'Private'],
            ]}
            onChange={(value) => {
              setPrivacyStatus(value as 'public' | 'unlisted' | 'private');
            }}
          />
          <DefaultsSelect
            label="Made for kids"
            name="madeForKids"
            value={madeForKids}
            options={[
              ['no', 'No'],
              ['yes', 'Yes'],
            ]}
            onChange={setMadeForKids}
          />
          <input name="notifySubscribers" type="hidden" value={String(notifySubscribers)} />
          <button
            type="button"
            className="defaults-toggle"
            role="switch"
            aria-checked={notifySubscribers}
            onClick={() => {
              setNotifySubscribers((current) => !current);
            }}
          >
            <span className="toggle-track" aria-hidden="true">
              <span />
            </span>
            Notify subscribers
          </button>
          <label className="youtube-defaults-text-field">
            <span>
              Tags <small>(optional)</small>
            </span>
            <input
              name="tags"
              value={tags}
              placeholder="launch, tutorial"
              onChange={(event) => {
                setTags(event.currentTarget.value);
              }}
            />
            <small>Comma-separated; blank adds nothing.</small>
          </label>
          <DefaultsSelect
            label="Category (optional)"
            name="categoryId"
            value={categoryId}
            options={YOUTUBE_CATEGORIES}
            onChange={setCategoryId}
          />
          <button className="secondary-button" type="submit" disabled={savingDefaults}>
            {savingDefaults ? 'Saving…' : 'Save defaults'}
          </button>
          {defaultsError && (
            <span className="field-error" role="alert">
              {defaultsError}
            </span>
          )}
          <LiveRegion message={defaultsAnnouncement} />
        </form>
      )}
    </article>
  );
}

function AccountsPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [adapterPickerOpen, setAdapterPickerOpen] = useState(false);
  const adapterDialogRef = useRef<HTMLElement>(null);
  const adapterTriggerRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [health, setHealth] = useState('All health');
  const [disconnecting, setDisconnecting] = useState<Account | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [workspaceName, setWorkspaceName] = useState('your active workspace');
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
              expiresAt?: string | null;
              updatedAt: string;
              adapterDefaults: Account['adapterDefaults'];
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
              provider:
                account.provider.toLowerCase() === 'x'
                  ? 'X'
                  : account.provider.toLowerCase() === 'youtube'
                    ? 'YouTube'
                    : account.provider.toLowerCase() === 'linkedin'
                      ? 'LinkedIn'
                      : account.provider,
              name: account.displayName.replace(/ \(@[^)]*\)$/, ''),
              handle: handleMatch?.[1] ? `@${handleMatch[1]}` : account.displayName,
              health:
                account.status === 'active' &&
                (!account.expiresAt || new Date(account.expiresAt).getTime() > Date.now())
                  ? 'Connected'
                  : 'Reconnect required',
              ...(account.expiresAt !== undefined ? { expiresAt: account.expiresAt } : {}),
              adapterDefaults: account.adapterDefaults,
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
  useEffect(() => {
    if (!adapterPickerOpen) return;
    const dialog = adapterDialogRef.current;
    const trigger = adapterTriggerRef.current;
    const focusable = () => [
      ...(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [href]') ?? []),
    ];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAdapterPickerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      trigger?.focus();
    };
  }, [adapterPickerOpen]);
  useEffect(() => {
    void fetch('/api/auth/session')
      .then(async (response) => {
        if (!response.ok) throw new Error('Workspace could not be loaded');
        return response.json() as Promise<{ data: { workspace: { name: string } } }>;
      })
      .then((result) => {
        setWorkspaceName(result.data.workspace.name);
      })
      .catch(() => {
        setWorkspaceName('your active workspace');
      });
  }, []);
  const connectAdapter = (adapter: PostingAdapterConfig) => {
    setActionError(null);
    void beginAdapterConnection(adapter).catch((error: unknown) => {
      setActionError(
        error instanceof Error ? error.message : `Could not start ${adapter.label} connection`,
      );
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
  const healthyCount = accounts.filter((account) => account.health === 'Connected').length;
  const attentionCount = accounts.length - healthyCount;
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
            <p>Manage publishing access and connection health for {workspaceName}.</p>
          </div>
          <button
            ref={adapterTriggerRef}
            className="primary-button connect-account"
            onClick={() => {
              setAdapterPickerOpen(true);
            }}
          >
            ＋ Add Posting Adapter
          </button>
        </div>
        {renderedState === 'loading' ? (
          <section
            className="account-summary loading"
            aria-label="Loading account health"
            aria-busy="true"
          >
            <span>Loading account health…</span>
          </section>
        ) : renderedState === 'error' ? null : (
          <section className="account-summary" aria-label="Account health summary">
            <div>
              <strong>{accounts.length}</strong>
              <span>Connected accounts</span>
            </div>
            <div>
              <strong className="success-text">{healthyCount}</strong>
              <span>Healthy</span>
            </div>
            <div>
              <strong className="warning-text">{attentionCount}</strong>
              <span>Needs attention</span>
            </div>
          </section>
        )}
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
              <p>Use Add Posting Adapter above to start scheduling from this workspace.</p>
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
                  </header>
                  <div className="account-list">
                    {rows.map((account) => (
                      <AccountRow
                        account={account}
                        key={account.id}
                        onDisconnect={setDisconnecting}
                        onReconnect={() => {
                          const adapter = getPostingAdapter(account.provider);
                          if (adapter) connectAdapter(adapter);
                          else
                            setActionError(
                              `No connection flow is available for ${account.provider}`,
                            );
                        }}
                        onDefaultsSaved={(updated) => {
                          setAccounts((current) =>
                            current.map((item) => (item.id === updated.id ? updated : item)),
                          );
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
      {adapterPickerOpen && (
        <div className="dialog-backdrop" role="presentation">
          <section
            ref={adapterDialogRef}
            className="adapter-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="adapter-picker-title"
          >
            <header>
              <div>
                <p className="eyebrow">Posting adapters</p>
                <h2 id="adapter-picker-title">Add Posting Adapter</h2>
                <p>Choose the provider account to connect to {workspaceName}.</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Close adapter picker"
                autoFocus
                onClick={() => {
                  setAdapterPickerOpen(false);
                }}
              >
                ×
              </button>
            </header>
            <PostingAdapterList
              onSelect={(adapter) => {
                setAdapterPickerOpen(false);
                connectAdapter(adapter);
              }}
            />
          </section>
        </div>
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

const KEY_PRESETS = {
  Read: ['schedules:read', 'destinations:read', 'audit:read'],
  Publish: ['schedules:read', 'schedules:write', 'content:write', 'publishes:submit'],
  Full: [
    'schedules:read',
    'schedules:write',
    'content:write',
    'publishes:submit',
    'destinations:read',
    'audit:read',
  ],
} as const;

interface ManagedApiKey {
  id: string;
  label: string;
  prefix: string;
  capabilities: string[];
  createdByDisplayName: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface DelegatedGrant {
  id: string;
  clientId: string;
  scopes: string[];
  createdAt: string;
}

function SettingsPage() {
  const isAutomation = window.location.pathname.endsWith('/settings/automation');
  const isIntegrations = window.location.pathname.endsWith('/settings/integrations');
  const workspaceBase = window.location.pathname.split('/settings/')[0] ?? '';
  const [workspace, setWorkspace] = useState({ name: '', slug: '', timezone: 'UTC' });
  const [workspaces, setWorkspaces] = useState<
    { id: string; name: string; slug: string; role: string; position: number }[]
  >([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [keys, setKeys] = useState<ManagedApiKey[]>([]);
  const [grants, setGrants] = useState<DelegatedGrant[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [preset, setPreset] = useState<keyof typeof KEY_PRESETS>('Publish');
  const [capabilities, setCapabilities] = useState<string[]>([...KEY_PRESETS.Publish]);
  const [label, setLabel] = useState('');
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [isSavingWorkspace, setIsSavingWorkspace] = useState(false);
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [isReorderingWorkspaces, setIsReorderingWorkspaces] = useState(false);
  const creatingWorkspaceRef = useRef(false);
  const reorderingWorkspacesRef = useRef(false);
  const [isCreatingKey, setIsCreatingKey] = useState(false);
  const [revokingKeyId, setRevokingKeyId] = useState<string | null>(null);
  const [grantRevokeId, setGrantRevokeId] = useState<string | null>(null);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);
  const [keyListRefreshFailed, setKeyListRefreshFailed] = useState(false);
  const loadApiKeys = async () => {
    const response = await fetch('/api/settings/api-keys');
    const result = (await response.json()) as {
      data: { items: ManagedApiKey[] } | null;
      error: string | null;
    };
    if (!response.ok || !result.data)
      throw new Error(result.error ?? 'API keys could not be loaded');
    setKeys(result.data.items);
    setKeyListRefreshFailed(false);
  };
  useEffect(() => {
    const endpoint = isAutomation
      ? '/api/settings/api-keys'
      : isIntegrations
        ? '/api/settings/delegated-grants'
        : '/api/workspaces/current';
    void Promise.all([
      fetch(endpoint),
      ...(!isAutomation && !isIntegrations ? [fetch('/api/workspaces')] : []),
    ])
      .then(async (response) => {
        const primary = response[0];
        const result = (await primary.json()) as { data: unknown; error: string | null };
        if (!primary.ok) throw new Error(result.error ?? 'Settings could not be loaded');
        if (isAutomation) setKeys((result.data as { items: ManagedApiKey[] }).items);
        else if (isIntegrations) setGrants(result.data as DelegatedGrant[]);
        else {
          setWorkspace(result.data as typeof workspace);
          const workspaceResponse = response[1];
          if (!workspaceResponse?.ok) throw new Error('Workspaces could not be loaded');
          const workspaceResult = (await workspaceResponse.json()) as {
            data: { workspaces: typeof workspaces };
          };
          setWorkspaces(workspaceResult.data.workspaces);
        }
        setLoadState('ready');
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Settings could not be loaded');
        setLoadState('error');
      });
  }, [isAutomation, isIntegrations]);
  const saveWorkspace = async () => {
    if (isSavingWorkspace) return;
    setIsSavingWorkspace(true);
    setMessage(null);
    try {
      const response = await fetch('/api/workspaces/current', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify(workspace),
      });
      const result = (await response.json()) as {
        data: typeof workspace | null;
        error: string | null;
      };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Workspace could not be saved');
      setWorkspace(result.data);
      setMessage('Workspace settings saved');
    } finally {
      setIsSavingWorkspace(false);
    }
  };
  const createWorkspace = async () => {
    if (creatingWorkspaceRef.current) return;
    creatingWorkspaceRef.current = true;
    setIsCreatingWorkspace(true);
    setMessage(null);
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ name: newWorkspaceName }),
      });
      const result = (await response.json()) as {
        data: (typeof workspaces)[number] | null;
        error: string | null;
      };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'Workspace could not be created');
      const createdWorkspace = result.data;
      setWorkspaces((current) => [...current, createdWorkspace]);
      setNewWorkspaceName('');
      setMessage('Workspace created');
    } finally {
      creatingWorkspaceRef.current = false;
      setIsCreatingWorkspace(false);
    }
  };
  const moveWorkspace = async (index: number, direction: -1 | 1) => {
    if (reorderingWorkspacesRef.current) return;
    const target = index + direction;
    if (!workspaces[index] || !workspaces[target]) return;
    const ordered = [...workspaces];
    const current = ordered[index];
    const destination = ordered[target];
    if (!current || !destination) return;
    ordered[index] = destination;
    ordered[target] = current;
    reorderingWorkspacesRef.current = true;
    setIsReorderingWorkspaces(true);
    setMessage(null);
    try {
      const response = await fetch('/api/workspaces/order', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ workspaceIds: ordered.map((item) => item.id) }),
      });
      if (!response.ok) throw new Error('Workspace order could not be saved');
      setWorkspaces(ordered.map((item, position) => ({ ...item, position })));
      setMessage('Workspace order saved');
    } finally {
      reorderingWorkspacesRef.current = false;
      setIsReorderingWorkspaces(false);
    }
  };
  const createKey = async () => {
    if (isCreatingKey) return;
    setIsCreatingKey(true);
    setMessage(null);
    setSecret(null);
    const expiresAt = expiryDays
      ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
      : null;
    try {
      const response = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrfToken() },
        body: JSON.stringify({ label, capabilities, expiresAt }),
      });
      const result = (await response.json()) as {
        data: { token: string } | null;
        error: string | null;
      };
      if (!response.ok || !result.data)
        throw new Error(result.error ?? 'API key could not be created');
      setSecret(result.data.token);
      setLabel('');
      setMessage('API key created');
      try {
        await loadApiKeys();
      } catch {
        setKeyListRefreshFailed(true);
        setMessage(
          'API key created. Its secret is safe below, but the key list could not refresh.',
        );
      }
    } finally {
      setIsCreatingKey(false);
    }
  };
  const run = (action: () => Promise<void>) => {
    void action().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : 'Settings action failed');
    });
  };
  return (
    <WorkspaceLayout active="settings">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Workspace controls</p>
          <h1>Settings</h1>
        </div>
      </header>
      <nav className="settings-tabs" aria-label="Settings sections">
        <a
          className={`settings-tab ${!isAutomation && !isIntegrations ? 'active' : ''}`}
          href={`${workspaceBase}/settings/workspace`}
        >
          Workspace
        </a>
        <a
          className={`settings-tab ${isAutomation ? 'active' : ''}`}
          href={`${workspaceBase}/settings/automation`}
        >
          Automation
        </a>
        <a
          className={`settings-tab ${isIntegrations ? 'active' : ''}`}
          href={`${workspaceBase}/settings/integrations`}
        >
          Integrations
        </a>
      </nav>
      {loadState === 'loading' && <p role="status">Loading settings…</p>}
      {message && (
        <div className="form-summary" role={loadState === 'error' ? 'alert' : 'status'}>
          {message}
        </div>
      )}
      {loadState === 'ready' && !isAutomation && !isIntegrations && (
        <div className="settings-grid">
          <section className="settings-card" aria-labelledby="workspace-settings-title">
            <h2 id="workspace-settings-title">Workspace profile</h2>
            <label className="field-label">
              Name
              <input
                className="text-input"
                value={workspace.name}
                onChange={(event) => {
                  setWorkspace({ ...workspace, name: event.target.value });
                }}
              />
            </label>
            <label className="field-label">
              Workspace URL
              <input
                className="text-input"
                value={workspace.slug}
                readOnly
                aria-describedby="slug-guard"
              />
            </label>
            <p id="slug-guard" className="field-hint">
              Contact an administrator before changing this routing identity.
            </p>
            <label className="field-label">
              Timezone
              <input
                className="text-input"
                value={workspace.timezone}
                onChange={(event) => {
                  setWorkspace({ ...workspace, timezone: event.target.value });
                }}
              />
            </label>
            <button
              className="primary-button"
              disabled={isSavingWorkspace}
              onClick={() => {
                run(saveWorkspace);
              }}
            >
              {isSavingWorkspace ? 'Saving workspace…' : 'Save workspace'}
            </button>
          </section>
          <section className="settings-card" aria-labelledby="workspace-list-title">
            <h2 id="workspace-list-title">Manage workspaces</h2>
            <label className="field-label">
              New workspace name
              <input
                className="text-input"
                value={newWorkspaceName}
                onChange={(event) => {
                  setNewWorkspaceName(event.target.value);
                }}
              />
            </label>
            <button
              className="secondary-button"
              disabled={!newWorkspaceName.trim() || isCreatingWorkspace}
              onClick={() => {
                run(createWorkspace);
              }}
            >
              {isCreatingWorkspace ? 'Creating workspace…' : 'Create workspace'}
            </button>
            <div className="workspace-management-list">
              {workspaces.map((item, index) => (
                <div className="workspace-management-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.role}</small>
                  </span>
                  <span>
                    <button
                      className="secondary-button"
                      disabled={index === 0 || isReorderingWorkspaces}
                      aria-label={`Move ${item.name} up`}
                      onClick={() => {
                        run(() => moveWorkspace(index, -1));
                      }}
                    >
                      ↑
                    </button>
                    <button
                      className="secondary-button"
                      disabled={index === workspaces.length - 1 || isReorderingWorkspaces}
                      aria-label={`Move ${item.name} down`}
                      onClick={() => {
                        run(() => moveWorkspace(index, 1));
                      }}
                    >
                      ↓
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {loadState === 'ready' && isAutomation && (
        <div className="settings-grid">
          <section className="settings-card" aria-labelledby="create-key-title">
            <h2 id="create-key-title">Create API key</h2>
            <label className="field-label">
              Key name
              <input
                className="text-input"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
              />
            </label>
            <div className="field-label">
              Capability preset
              <div className="segmented-control">
                {Object.keys(KEY_PRESETS).map((name) => (
                  <button
                    key={name}
                    className={`preset-button ${preset === name ? 'active' : ''}`}
                    aria-pressed={preset === name}
                    onClick={() => {
                      const nextPreset = name as keyof typeof KEY_PRESETS;
                      setPreset(nextPreset);
                      setCapabilities([...KEY_PRESETS[nextPreset]]);
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <p className="field-hint">{capabilities.join(' · ')}</p>
            <details className="advanced-capabilities">
              <summary>Advanced capabilities</summary>
              <div className="capability-grid">
                {KEY_PRESETS.Full.map((capability) => {
                  const selected = capabilities.includes(capability);
                  return (
                    <button
                      key={capability}
                      className={`capability-button ${selected ? 'active' : ''}`}
                      aria-pressed={selected}
                      onClick={() => {
                        setCapabilities((current) =>
                          selected
                            ? current.filter((value) => value !== capability)
                            : [...current, capability],
                        );
                      }}
                    >
                      {capability}
                    </button>
                  );
                })}
              </div>
            </details>
            <div className="field-label">
              Expiry
              <div className="segmented-control">
                {[
                  [null, 'Never'],
                  [30, '30 days'],
                  [90, '90 days'],
                ].map(([days, text]) => (
                  <button
                    key={text}
                    className={`expiry-button ${expiryDays === days ? 'active' : ''}`}
                    aria-pressed={expiryDays === days}
                    onClick={() => {
                      setExpiryDays(days as number | null);
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="primary-button"
              disabled={!label.trim() || isCreatingKey}
              onClick={() => {
                run(createKey);
              }}
            >
              {isCreatingKey ? 'Creating key…' : 'Create key'}
            </button>
            {secret && (
              <div className="secret-reveal" role="status">
                <strong>Copy this key now. It will not be shown again.</strong>
                <code>{secret}</code>
                <button
                  className="secondary-button"
                  onClick={() => {
                    void navigator.clipboard.writeText(secret).then(() => {
                      setMessage('API key copied');
                    });
                  }}
                >
                  Copy key
                </button>
              </div>
            )}
          </section>
          <section className="settings-card" aria-labelledby="keys-title">
            <h2 id="keys-title">API keys</h2>
            {keyListRefreshFailed && (
              <div className="form-summary" role="status">
                <span>The key list is out of date.</span>
                <button
                  className="secondary-button"
                  onClick={() => {
                    run(loadApiKeys);
                  }}
                >
                  Retry key list
                </button>
              </div>
            )}
            {keys.length === 0 ? (
              <p>No API keys yet.</p>
            ) : (
              keys.map((key) => (
                <article className="api-key-row" key={key.id}>
                  <div>
                    <strong>{key.label}</strong>
                    <small>
                      {key.prefix} · Created by {key.createdByDisplayName}
                    </small>
                    <small>Created {new Date(key.createdAt).toLocaleDateString()}</small>
                    <small>
                      Expires{' '}
                      {key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'never'}
                    </small>
                    <small>Capabilities: {key.capabilities.join(' · ')}</small>
                    <small>
                      {key.revokedAt
                        ? 'Revoked'
                        : key.lastUsedAt
                          ? `Last used ${new Date(key.lastUsedAt).toLocaleDateString()}`
                          : 'Never used'}
                    </small>
                  </div>
                  {!key.revokedAt &&
                    (revokeId === key.id ? (
                      <div className="inline-confirm">
                        <span>Revoke this key?</span>
                        <button
                          className="danger-button"
                          disabled={revokingKeyId === key.id}
                          onClick={() => {
                            run(async () => {
                              if (revokingKeyId) return;
                              setRevokingKeyId(key.id);
                              setMessage(null);
                              try {
                                const response = await fetch(`/api/settings/api-keys/${key.id}`, {
                                  method: 'DELETE',
                                  headers: { 'x-csrf-token': getCsrfToken() },
                                });
                                if (!response.ok) throw new Error('API key could not be revoked');
                                await loadApiKeys();
                                setRevokeId(null);
                                setMessage('API key revoked');
                              } finally {
                                setRevokingKeyId(null);
                              }
                            });
                          }}
                        >
                          {revokingKeyId === key.id ? 'Revoking key…' : 'Confirm revoke'}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={revokingKeyId === key.id}
                          onClick={() => {
                            setRevokeId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setRevokeId(key.id);
                        }}
                      >
                        Revoke
                      </button>
                    ))}
                </article>
              ))
            )}
          </section>
        </div>
      )}
      {loadState === 'ready' && isIntegrations && (
        <section className="settings-card" aria-labelledby="integrations-title">
          <h2 id="integrations-title">Connected applications</h2>
          <p className="field-hint">
            These applications can act through the access you approved. Revoking a connection signs
            it out without changing your API keys or connected channels.
          </p>
          {grants.length === 0 ? (
            <p>No applications connected.</p>
          ) : (
            grants.map((grant) => (
              <article className="api-key-row" key={grant.id}>
                <div>
                  <strong>{grant.clientId}</strong>
                  <small>Connected {new Date(grant.createdAt).toLocaleDateString()}</small>
                  <small>Access: {grant.scopes.join(' · ')}</small>
                </div>
                {grantRevokeId === grant.id ? (
                  <div className="inline-confirm">
                    <span>Revoke this connection?</span>
                    <button
                      className="danger-button"
                      disabled={revokingGrantId === grant.id}
                      onClick={() => {
                        run(async () => {
                          if (revokingGrantId) return;
                          setRevokingGrantId(grant.id);
                          try {
                            const response = await fetch(
                              `/api/settings/delegated-grants/${grant.id}`,
                              {
                                method: 'DELETE',
                                headers: { 'x-csrf-token': getCsrfToken() },
                              },
                            );
                            if (!response.ok) throw new Error('Connection could not be revoked');
                            setGrants((current) => current.filter((item) => item.id !== grant.id));
                            setGrantRevokeId(null);
                            setMessage('Application connection revoked');
                          } finally {
                            setRevokingGrantId(null);
                          }
                        });
                      }}
                    >
                      {revokingGrantId === grant.id ? 'Revoking…' : 'Confirm revoke'}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={revokingGrantId === grant.id}
                      onClick={() => {
                        setGrantRevokeId(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setGrantRevokeId(grant.id);
                    }}
                  >
                    Revoke connection
                  </button>
                )}
              </article>
            ))
          )}
        </section>
      )}
    </WorkspaceLayout>
  );
}

export function App() {
  const path = window.location.pathname;
  if (path === '/register') return <AuthPage mode="register" />;
  if (path === '/login' || path === '/') return <AuthPage mode="login" />;
  if (path === '/forgot-password') return <ForgotPasswordPage />;
  if (path === '/connect/authorize') return <ConsentPage />;
  if (path.startsWith('/onboarding/')) return <OnboardingPage />;
  if (/\/w\/[^/]+\/queue$/.test(path)) return <QueuePage />;
  if (/\/w\/[^/]+\/calendar$/.test(path)) return <CalendarPage />;
  if (/\/w\/[^/]+\/jobs\/[^/]+$/.test(path)) return <JobDetailPage />;
  if (/\/w\/[^/]+\/drafts\/[^/]+$/.test(path)) return <ExternalDraftPage />;
  if (/\/w\/[^/]+\/settings\/(workspace|automation|integrations)$/.test(path))
    return <SettingsPage />;
  return <AccountsPage />;
}

const root = document.getElementById('root');
if (!root) throw new Error('UI root element is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
