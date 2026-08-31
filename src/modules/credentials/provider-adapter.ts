export interface DiscoveredProviderAccount {
  providerAccountId: string;
  displayName: string;
}

export interface ProviderConnectionAdapter {
  discoverAccounts(accessToken: string): Promise<DiscoveredProviderAccount[]>;
}

export class FakeProviderConnectionAdapter implements ProviderConnectionAdapter {
  public constructor(private readonly accounts: readonly DiscoveredProviderAccount[]) {}

  public discoverAccounts(accessToken: string): Promise<DiscoveredProviderAccount[]> {
    void accessToken;
    return Promise.resolve(this.accounts.map((account) => ({ ...account })));
  }
}
