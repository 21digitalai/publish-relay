export interface LinkedInAccount {
  id: string;
  displayName: string;
  status: string;
  expiresAt?: string | null;
}

const DAY_MS = 86_400_000;

export function linkedInExpiringSoon(account: LinkedInAccount, now: number): boolean {
  if (account.status !== 'active' || !account.expiresAt) return false;
  const remaining = new Date(account.expiresAt).getTime() - now;
  return Number.isFinite(remaining) && remaining > 0 && remaining <= 7 * DAY_MS;
}

export function linkedInExpiryWarning(account: LinkedInAccount, now: number): string | null {
  const expiry = account.expiresAt ? new Date(account.expiresAt) : null;
  const expiresAt = expiry?.getTime();
  if (!expiry || expiresAt === undefined || !Number.isFinite(expiresAt)) return null;
  const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
  if (daysLeft > 7 && account.status === 'active') return null;
  const exactExpiry = `${expiry.toLocaleDateString(undefined, { dateStyle: 'medium' })}, ${expiry.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;
  const timing =
    daysLeft <= 0 || account.status !== 'active'
      ? 'has expired or needs reconnection'
      : daysLeft <= 1
        ? 'expires within 1 day'
        : daysLeft <= 3
          ? 'expires within 3 days'
          : 'expires within 7 days';
  return `LinkedIn access for ${account.displayName} ${timing} (${exactExpiry}).`;
}
