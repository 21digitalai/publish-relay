CREATE OR REPLACE FUNCTION public.resolve_fanvue_payment_callback(handle_hash text)
RETURNS TABLE (
  workspace_id uuid,
  account_id uuid,
  creator_uuid uuid,
  signing_credential_id uuid,
  state text
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT subscription.workspace_id, subscription.account_id,
    subscription.creator_uuid, subscription.signing_credential_id, subscription.state
  FROM public.fanvue_payment_subscriptions subscription
  JOIN public.provider_accounts account
    ON account.workspace_id = subscription.workspace_id AND account.id = subscription.account_id
  JOIN public.provider_connections connection
    ON connection.workspace_id = account.workspace_id AND connection.id = account.connection_id
  WHERE length(handle_hash) = 64 AND handle_hash ~ '^[a-f0-9]{64}$'
    AND subscription.callback_handle_hash = handle_hash
    AND subscription.state IN ('probe_pending', 'creation_unknown', 'active')
    AND account.destination_provider = 'fanvue'
    AND account.remote_account_id = subscription.creator_uuid::text
    AND account.availability = 'active' AND account.disconnected_at IS NULL
    AND connection.provider = 'fanvue'
    AND connection.external_subject_id = subscription.creator_uuid::text
    AND connection.status = 'active' AND connection.revoked_at IS NULL
    AND connection.scopes @> '["read:self", "read:creator"]'::jsonb
    AND (subscription.state IN ('probe_pending', 'creation_unknown') OR subscription.signing_credential_id IS NOT NULL)
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.resolve_fanvue_payment_callback(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_fanvue_payment_callback(text) TO publish_relay_web;
  END IF;
END
$$;
