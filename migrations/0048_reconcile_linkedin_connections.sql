-- 0.1.14 could record 0045 as the latest timestamp before applying 0046/0047.
-- Reconcile both the skipped and already-applied shapes without replaying history.
ALTER TABLE public.provider_connections ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.provider_connections ADD COLUMN IF NOT EXISTS member_urn text;

UPDATE public.provider_connections AS connection
SET member_urn = account.provider_account_id
FROM public.provider_accounts AS account
WHERE connection.provider = 'linkedin'
  AND account.connection_id = connection.id
  AND connection.member_urn IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class AS index_class
    JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
    JOIN pg_index AS index_definition ON index_definition.indexrelid = index_class.oid
    WHERE namespace.nspname = 'public'
      AND index_class.relname = 'provider_connections_workspace_provider_unique'
      AND index_definition.indpred IS NULL
  ) THEN
    DROP INDEX public.provider_connections_workspace_provider_unique;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_workspace_provider_unique
  ON public.provider_connections (workspace_id, provider)
  WHERE provider <> 'linkedin';
CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_linkedin_member_unique
  ON public.provider_connections (workspace_id, member_urn)
  WHERE provider = 'linkedin';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.provider_connections'::regclass
      AND conname = 'provider_connections_linkedin_member_required'
  ) THEN
    ALTER TABLE public.provider_connections
      ADD CONSTRAINT provider_connections_linkedin_member_required
      CHECK (provider <> 'linkedin' OR member_urn IS NOT NULL);
  END IF;
END $$;
