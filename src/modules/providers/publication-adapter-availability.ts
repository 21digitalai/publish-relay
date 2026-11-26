/** Connection methods share the Instagram publication adapter allowlist entry. */
export function isPublicationAdapterEnabled(
  enabledAdapters: ReadonlySet<string> | undefined,
  connectionProvider: string,
): boolean {
  if (enabledAdapters === undefined) return true;
  const provider = connectionProvider.toLowerCase();
  const adapter =
    provider === 'instagram_unified_login' || provider === 'instagram_login'
      ? 'instagram'
      : provider;
  return enabledAdapters.has(adapter);
}
