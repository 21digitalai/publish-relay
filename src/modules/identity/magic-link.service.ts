import {
  createMagicLinkSecretMaterial,
  hashMagicLinkBinding,
  magicLinkExpiresAt,
  normalizeMagicLinkEmail,
  validateMagicLinkRedirect,
} from './magic-link.js';
import { createOpaqueToken, hashOpaqueToken } from './session.js';
import type { MembershipRole } from './authorization.js';

export type MagicLinkPurpose = 'login' | 'signup';

export interface MagicLinkChallengeInput {
  userId: string | null;
  tokenHash: string;
  emailKeyHash: string;
  networkKeyHash: string;
  userAgentHash: string;
  purpose: MagicLinkPurpose;
  redirectPath: string;
  expiresAt: Date;
  correlationId: string;
}

export interface MagicLinkStore {
  findEnabledUserIdByEmail: (email: string) => Promise<string | null>;
  consumeRateLimit: (input: { emailKeyHash: string; networkKeyHash: string }) => Promise<boolean>;
  createChallenge: (input: MagicLinkChallengeInput) => Promise<string>;
  markDelivery: (
    challengeId: string,
    state: 'sent' | 'suppressed' | 'failed',
    providerMessageId?: string,
  ) => Promise<void>;
  consumeLoginChallenge: (input: {
    tokenHash: string;
    userAgentHash: string;
    sessionTokenHash: string;
    csrfSecretHash: string;
    sessionExpiresAt: Date;
    now: Date;
  }) => Promise<{
    userId: string;
    workspaceId: string;
    role: MembershipRole;
    redirectPath: string;
  } | null>;
  consumeSignupChallenge: (input: SignupConsumeInput) => Promise<{
    userId: string;
    workspaceId: string;
    role: MembershipRole;
    redirectPath: string;
  } | null>;
}

export interface SignupDraft {
  displayName: string;
  email: string;
  workspaceName: string;
  termsAccepted: true;
}

export interface SignupConsumeInput extends Omit<SignupDraft, 'termsAccepted'> {
  tokenHash: string;
  userAgentHash: string;
  sessionTokenHash: string;
  csrfSecretHash: string;
  sessionExpiresAt: Date;
  now: Date;
}

export interface EmailDelivery {
  sendMagicLink: (input: {
    challengeId?: string;
    recipient: string;
    url: string;
    correlationId: string;
  }) => Promise<{ messageId: string; queued?: boolean }>;
  queueMagicLinkChallenge?: (
    challenge: MagicLinkChallengeInput,
    input: { recipient: string; url: string; correlationId: string; signup?: SignupDraft },
  ) => Promise<{ challengeId: string }>;
  readSignupDraft?: (tokenHash: string) => Promise<SignupDraft | null>;
}

export interface MagicLinkRequestResult {
  accepted: true;
  developmentUrl?: string;
}

export interface MagicLinkVerificationResult {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
  token: string;
  csrfToken: string;
  expiresAt: Date;
  redirectPath: string;
}

type MagicLinkMetric =
  | 'request_accepted'
  | 'request_suppressed'
  | 'delivery_succeeded'
  | 'delivery_failed'
  | 'verification_succeeded'
  | 'verification_failed';

export class MagicLinkMetrics {
  private readonly counts = new Map<MagicLinkMetric, number>();

  increment(metric: MagicLinkMetric): void {
    this.counts.set(metric, (this.counts.get(metric) ?? 0) + 1);
  }

  renderPrometheus(): string[] {
    const names: MagicLinkMetric[] = [
      'request_accepted',
      'request_suppressed',
      'delivery_succeeded',
      'delivery_failed',
      'verification_succeeded',
      'verification_failed',
    ];
    return [
      '# HELP publish_relay_magic_link_events_total Magic-link lifecycle events.',
      '# TYPE publish_relay_magic_link_events_total counter',
      ...names.map(
        (name) =>
          `publish_relay_magic_link_events_total{event="${name}"} ${String(this.counts.get(name) ?? 0)}`,
      ),
    ];
  }
}

export class MagicLinkService {
  constructor(
    private readonly store: MagicLinkStore,
    private readonly delivery: EmailDelivery,
    private readonly config: {
      pepper: string;
      publicOrigin: string;
      exposeDevelopmentUrl: boolean;
    },
    readonly metrics = new MagicLinkMetrics(),
  ) {}

  async verify(input: {
    token: string;
    userAgent: string;
    now?: Date;
  }): Promise<MagicLinkVerificationResult | null> {
    const login = await this.verifyLogin(input);
    return login ?? this.verifySignup(input);
  }

  async verifyLogin(input: {
    token: string;
    userAgent: string;
    now?: Date;
  }): Promise<MagicLinkVerificationResult | null> {
    const now = input.now ?? new Date();
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
    const identity = await this.store.consumeLoginChallenge({
      tokenHash: hashOpaqueToken(input.token),
      userAgentHash: hashMagicLinkBinding(input.userAgent, this.config.pepper),
      sessionTokenHash: hashOpaqueToken(token),
      csrfSecretHash: hashOpaqueToken(csrfToken),
      sessionExpiresAt: expiresAt,
      now,
    });
    this.metrics.increment(identity ? 'verification_succeeded' : 'verification_failed');
    return identity ? { ...identity, token, csrfToken, expiresAt } : null;
  }

  async verifySignup(input: {
    token: string;
    userAgent: string;
    now?: Date;
  }): Promise<MagicLinkVerificationResult | null> {
    if (!this.delivery.readSignupDraft) return null;
    const now = input.now ?? new Date();
    const tokenHash = hashOpaqueToken(input.token);
    const draft = await this.delivery.readSignupDraft(tokenHash);
    if (!draft) return null;
    const token = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
    const identity = await this.store.consumeSignupChallenge({
      tokenHash,
      userAgentHash: hashMagicLinkBinding(input.userAgent, this.config.pepper),
      displayName: draft.displayName,
      email: draft.email,
      workspaceName: draft.workspaceName,
      sessionTokenHash: hashOpaqueToken(token),
      csrfSecretHash: hashOpaqueToken(csrfToken),
      sessionExpiresAt: expiresAt,
      now,
    });
    this.metrics.increment(identity ? 'verification_succeeded' : 'verification_failed');
    return identity ? { ...identity, token, csrfToken, expiresAt } : null;
  }

  async requestSignup(input: {
    displayName: string;
    email: string;
    workspaceName: string;
    termsAccepted: true;
    networkKey: string;
    userAgent: string;
    correlationId: string;
    now?: Date;
  }): Promise<MagicLinkRequestResult> {
    return this.requestAccess(input);
  }

  async requestAccess(input: {
    email: string;
    redirectPath?: string;
    networkKey: string;
    userAgent: string;
    correlationId: string;
    now?: Date;
  }): Promise<MagicLinkRequestResult> {
    const email = normalizeMagicLinkEmail(input.email);
    const redirectPath = validateMagicLinkRedirect(input.redirectPath);
    const material = createMagicLinkSecretMaterial({
      email,
      networkKey: input.networkKey,
      userAgent: input.userAgent,
      pepper: this.config.pepper,
    });
    const userId = await this.store.findEnabledUserIdByEmail(email);
    const isAllowed = await this.store.consumeRateLimit(material);
    if (!isAllowed) {
      this.metrics.increment('request_suppressed');
      return { accepted: true };
    }
    if (userId)
      return this.queueLoginChallenge({ ...input, email, redirectPath, material, userId });
    if (!this.delivery.queueMagicLinkChallenge) {
      this.metrics.increment('request_suppressed');
      return { accepted: true };
    }

    const challenge = {
      userId: null,
      tokenHash: material.tokenHash,
      emailKeyHash: material.emailKeyHash,
      networkKeyHash: material.networkKeyHash,
      userAgentHash: material.userAgentHash,
      purpose: 'signup' as const,
      redirectPath,
      expiresAt: magicLinkExpiresAt(input.now ?? new Date()),
      correlationId: input.correlationId,
    };
    const url = new URL('/api/auth/magic-link/verify', this.config.publicOrigin);
    url.searchParams.set('token', material.token);
    const queued = await this.delivery.queueMagicLinkChallenge(challenge, {
      recipient: email,
      url: url.toString(),
      correlationId: input.correlationId,
      signup: {
        displayName: email,
        email,
        workspaceName: 'My workspace',
        termsAccepted: true,
      },
    });
    this.metrics.increment('request_accepted');
    if (!this.config.exposeDevelopmentUrl) return { accepted: true };
    await this.store.markDelivery(queued.challengeId, 'sent');
    return { accepted: true, developmentUrl: url.toString() };
  }

  async requestLogin(input: {
    email: string;
    redirectPath?: string;
    networkKey: string;
    userAgent: string;
    correlationId: string;
    now?: Date;
  }): Promise<MagicLinkRequestResult> {
    return this.requestAccess(input);
  }

  private async queueLoginChallenge(input: {
    email: string;
    redirectPath: string;
    networkKey: string;
    userAgent: string;
    correlationId: string;
    now?: Date;
    userId: string;
    material: ReturnType<typeof createMagicLinkSecretMaterial>;
  }): Promise<MagicLinkRequestResult> {
    const email = normalizeMagicLinkEmail(input.email);
    this.metrics.increment('request_accepted');

    const challenge = {
      userId: input.userId,
      tokenHash: input.material.tokenHash,
      emailKeyHash: input.material.emailKeyHash,
      networkKeyHash: input.material.networkKeyHash,
      userAgentHash: input.material.userAgentHash,
      purpose: 'login',
      redirectPath: input.redirectPath,
      expiresAt: magicLinkExpiresAt(input.now ?? new Date()),
      correlationId: input.correlationId,
    } satisfies MagicLinkChallengeInput;
    const url = new URL('/api/auth/magic-link/verify', this.config.publicOrigin);
    url.searchParams.set('token', input.material.token);

    if (this.delivery.queueMagicLinkChallenge && !this.config.exposeDevelopmentUrl) {
      await this.delivery.queueMagicLinkChallenge(challenge, {
        recipient: email,
        url: url.toString(),
        correlationId: input.correlationId,
      });
      return { accepted: true };
    }

    const challengeId = await this.store.createChallenge(challenge);

    if (this.config.exposeDevelopmentUrl) {
      await this.store.markDelivery(challengeId, 'sent');
      this.metrics.increment('delivery_succeeded');
      return { accepted: true, developmentUrl: url.toString() };
    }

    try {
      const delivered = await this.delivery.sendMagicLink({
        challengeId,
        recipient: email,
        url: url.toString(),
        correlationId: input.correlationId,
      });
      if (!delivered.queued) {
        await this.store.markDelivery(challengeId, 'sent', delivered.messageId);
        this.metrics.increment('delivery_succeeded');
      }
    } catch (error) {
      await this.store.markDelivery(challengeId, 'failed');
      this.metrics.increment('delivery_failed');
      throw error;
    }
    return { accepted: true };
  }
}
