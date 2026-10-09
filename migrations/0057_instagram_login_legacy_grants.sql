-- The Facebook Login Instagram path is retired. Preserve account/job history but stop
-- old Instagram destinations from dispatching until separately reconnected through Instagram Login.
ALTER TABLE provider_accounts DROP CONSTRAINT provider_accounts_availability_check;
ALTER TABLE provider_accounts ADD CONSTRAINT provider_accounts_availability_check
  CHECK (availability IN ('active', 'reauth_required', 'permission_lost', 'remote_missing', 'publishing_unavailable'));

UPDATE provider_accounts AS account
SET availability = 'reauth_required', disconnected_at = NOW(), updated_at = NOW()
FROM provider_connections AS connection
WHERE account.connection_id = connection.id
  AND account.workspace_id = connection.workspace_id
  AND connection.provider = 'meta'
  AND account.destination_provider = 'instagram'
  AND account.disconnected_at IS NULL;

UPDATE provider_connections
SET status = 'disconnected', updated_at = NOW()
WHERE provider = 'meta' AND grant_family = 'instagram' AND status = 'active';
