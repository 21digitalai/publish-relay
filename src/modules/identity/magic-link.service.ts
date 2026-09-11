import {
  createMagicLinkSecretMaterial,
  magicLinkExpiresAt,
  normalizeMagicLinkEmail,
  validateMagicLinkRedirect,
} from './magic-link.js';

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
}

export interface EmailDelivery {
  sendMagicLink: (input: {
    recipient: string;
    url: string;
    correlationId: string;
  }) => Promise<{ messageId: string }>;
}

export interface MagicLinkRequestResult {
  accepted: true;
  developmentUrl?: string;
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
  ) {}

  async requestLogin(input: {
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
    if (!userId || !isAllowed) return { accepted: true };

    const challengeId = await this.store.createChallenge({
      userId,
      tokenHash: material.tokenHash,
      emailKeyHash: material.emailKeyHash,
      networkKeyHash: material.networkKeyHash,
      userAgentHash: material.userAgentHash,
      purpose: 'login',
      redirectPath,
      expiresAt: magicLinkExpiresAt(input.now ?? new Date()),
      correlationId: input.correlationId,
    });
    const url = new URL('/api/auth/magic-link/verify', this.config.publicOrigin);
    url.searchParams.set('token', material.token);

    if (this.config.exposeDevelopmentUrl) {
      await this.store.markDelivery(challengeId, 'sent');
      return { accepted: true, developmentUrl: url.toString() };
    }

    try {
      const delivered = await this.delivery.sendMagicLink({
        recipient: email,
        url: url.toString(),
        correlationId: input.correlationId,
      });
      await this.store.markDelivery(challengeId, 'sent', delivered.messageId);
    } catch (error) {
      await this.store.markDelivery(challengeId, 'failed');
      throw error;
    }
    return { accepted: true };
  }
}
