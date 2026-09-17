DROP FUNCTION public.resolve_delegated_access_token(text, timestamptz);

CREATE FUNCTION public.resolve_delegated_access_token(
  requested_access_hash text,
  requested_at timestamptz
) RETURNS TABLE (
  grant_id uuid,
  workspace_id uuid,
  workspace_label text,
  user_id uuid,
  client_id text,
  scopes text[],
  access_expires_at timestamptz
) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.delegated_tokens AS token
  SET last_used_at = requested_at, updated_at = requested_at
  FROM public.delegated_grants AS grant_record, public.workspaces AS workspace_record
  WHERE token.access_token_hash = requested_access_hash
    AND token.revoked_at IS NULL
    AND token.access_expires_at > requested_at
    AND grant_record.id = token.grant_id
    AND grant_record.workspace_id = token.workspace_id
    AND grant_record.revoked_at IS NULL
    AND workspace_record.id = token.workspace_id
  RETURNING token.grant_id, token.workspace_id, workspace_record.name,
    grant_record.user_id, grant_record.client_id, token.scopes, token.access_expires_at
$$;

REVOKE ALL ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz)
      TO publish_relay_web;
  END IF;
END
$$;
