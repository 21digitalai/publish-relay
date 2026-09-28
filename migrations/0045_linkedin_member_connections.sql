ALTER TABLE public.provider_connections ADD COLUMN member_urn text;

UPDATE public.provider_connections AS connection
SET member_urn = account.provider_account_id
FROM public.provider_accounts AS account
WHERE connection.provider = 'linkedin'
  AND account.connection_id = connection.id;

DROP INDEX public.provider_connections_workspace_provider_unique;
CREATE UNIQUE INDEX provider_connections_workspace_provider_unique
  ON public.provider_connections (workspace_id, provider)
  WHERE provider <> 'linkedin';
CREATE UNIQUE INDEX provider_connections_linkedin_member_unique
  ON public.provider_connections (workspace_id, member_urn)
  WHERE provider = 'linkedin';

ALTER TABLE public.provider_connections ADD CONSTRAINT provider_connections_linkedin_member_required
  CHECK (provider <> 'linkedin' OR member_urn IS NOT NULL);
