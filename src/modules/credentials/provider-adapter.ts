import type { DestinationProvider } from '../providers/contract.js';

export interface DiscoveredProviderAccount {
  providerAccountId: string;
  displayName: string;
  destinationProvider?: DestinationProvider;
  remoteAccountId?: string;
  remoteParentAccountId?: string | null;
  credentialId?: string | null;
  capabilitySnapshot?: Readonly<Record<string, unknown>>;
  capabilitiesCheckedAt?: Date | null;
}

export interface ProviderConnectionDriver {
  discoverAccounts(accessToken: string): Promise<DiscoveredProviderAccount[]>;
}

/** @deprecated Use ProviderConnectionDriver. */
export type ProviderConnectionAdapter = ProviderConnectionDriver;

export class FakeProviderConnectionAdapter implements ProviderConnectionDriver {
  public constructor(private readonly accounts: readonly DiscoveredProviderAccount[]) {}

  public discoverAccounts(accessToken: string): Promise<DiscoveredProviderAccount[]> {
    void accessToken;
    return Promise.resolve(this.accounts.map((account) => ({ ...account })));
  }
}
