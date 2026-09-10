CREATE FUNCTION public.exchange_delegated_authorization_code(
  requested_code_hash text,
  requested_client_id text,
  requested_redirect_uri text,
  requested_code_challenge text,
  replacement_access_hash text,
  replacement_refresh_hash text,
  replacement_access_expiry timestamptz,
  replacement_refresh_expiry timestamptz,
  requested_at timestamptz
) RETURNS TABLE (
  grant_id uuid, workspace_id uuid, user_id uuid, client_id text, scopes text[]
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  matched_grant_id uuid; matched_workspace_id uuid; matched_user_id uuid;
  matched_client_id text; matched_scopes text[];
BEGIN
  UPDATE public.delegated_authorization_codes AS code
  SET consumed_at = requested_at
  FROM public.delegated_grants AS grant_record
  WHERE code.code_hash = requested_code_hash
    AND code.client_id = requested_client_id
    AND code.redirect_uri = requested_redirect_uri
    AND code.code_challenge = requested_code_challenge
    AND code.consumed_at IS NULL
    AND code.expires_at > requested_at
    AND grant_record.id = code.grant_id
    AND grant_record.workspace_id = code.workspace_id
    AND grant_record.revoked_at IS NULL
  RETURNING code.grant_id, code.workspace_id, grant_record.user_id, code.client_id, code.scopes
  INTO matched_grant_id, matched_workspace_id, matched_user_id, matched_client_id, matched_scopes;

  IF matched_grant_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.delegated_tokens (
    workspace_id, grant_id, access_token_hash, refresh_token_hash, scopes,
    access_expires_at, refresh_expires_at
  ) VALUES (
    matched_workspace_id, matched_grant_id, replacement_access_hash,
    replacement_refresh_hash, matched_scopes, replacement_access_expiry,
    replacement_refresh_expiry
  );

  RETURN QUERY SELECT matched_grant_id, matched_workspace_id, matched_user_id,
    matched_client_id, matched_scopes;
END
$$;

CREATE FUNCTION public.resolve_delegated_access_token(
  requested_access_hash text,
  requested_at timestamptz
) RETURNS TABLE (
  grant_id uuid, workspace_id uuid, user_id uuid, client_id text, scopes text[]
) LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.delegated_tokens AS token
  SET last_used_at = requested_at, updated_at = requested_at
  FROM public.delegated_grants AS grant_record
  WHERE token.access_token_hash = requested_access_hash
    AND token.revoked_at IS NULL
    AND token.access_expires_at > requested_at
    AND grant_record.id = token.grant_id
    AND grant_record.workspace_id = token.workspace_id
    AND grant_record.revoked_at IS NULL
  RETURNING token.grant_id, token.workspace_id, grant_record.user_id,
    grant_record.client_id, token.scopes
$$;

CREATE FUNCTION public.rotate_delegated_refresh_token(
  requested_refresh_hash text,
  replacement_access_hash text,
  replacement_refresh_hash text,
  replacement_access_expiry timestamptz,
  replacement_refresh_expiry timestamptz,
  requested_at timestamptz
) RETURNS TABLE (
  grant_id uuid, workspace_id uuid, user_id uuid, client_id text, scopes text[]
) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_token_id uuid;
  current_grant_id uuid;
  current_workspace_id uuid;
  current_scopes text[];
  current_user_id uuid;
  current_client_id text;
BEGIN
  UPDATE public.delegated_tokens AS token
  SET revoked_at = requested_at, updated_at = requested_at
  FROM public.delegated_grants AS grant_record
  WHERE token.refresh_token_hash = requested_refresh_hash
    AND token.revoked_at IS NULL
    AND token.refresh_expires_at > requested_at
    AND grant_record.id = token.grant_id
    AND grant_record.workspace_id = token.workspace_id
    AND grant_record.revoked_at IS NULL
  RETURNING token.id, token.grant_id, token.workspace_id, token.scopes,
    grant_record.user_id, grant_record.client_id
    INTO current_token_id, current_grant_id, current_workspace_id, current_scopes,
      current_user_id, current_client_id;

  IF current_token_id IS NULL THEN RETURN; END IF;

  INSERT INTO public.delegated_tokens (
    workspace_id, grant_id, access_token_hash, refresh_token_hash, scopes,
    access_expires_at, refresh_expires_at, rotated_from_token_id
  ) VALUES (
    current_workspace_id, current_grant_id, replacement_access_hash,
    replacement_refresh_hash, current_scopes, replacement_access_expiry,
    replacement_refresh_expiry, current_token_id
  );

  RETURN QUERY SELECT current_grant_id, current_workspace_id,
    current_user_id, current_client_id, current_scopes;
END
$$;

REVOKE ALL ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) FROM PUBLIC;
DO $grant_if_role_exists$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.exchange_delegated_authorization_code(text, text, text, text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
    GRANT EXECUTE ON FUNCTION public.resolve_delegated_access_token(text, timestamptz) TO publish_relay_web;
    GRANT EXECUTE ON FUNCTION public.rotate_delegated_refresh_token(text, text, text, timestamptz, timestamptz, timestamptz) TO publish_relay_web;
  END IF;
END
$grant_if_role_exists$;
