const PROVIDER_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  X: 'X',
  YOUTUBE: 'YouTube',
};

export function providerDisplayName(provider: string): string {
  const normalizedProvider = provider.trim().toUpperCase();

  return PROVIDER_LABELS[normalizedProvider] ?? (provider.trim() || 'provider');
}

export function externalResultLabel(provider: string, position?: number): string {
  const providerName = providerDisplayName(provider);

  return position === undefined
    ? `View on ${providerName}`
    : `View post ${String(position + 1)} on ${providerName}`;
}
