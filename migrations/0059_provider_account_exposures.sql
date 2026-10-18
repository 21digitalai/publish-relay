CREATE TABLE public.provider_account_exposures (
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  provider_account_id uuid NOT NULL REFERENCES public.provider_accounts(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  show_other_workspace_posts boolean NOT NULL DEFAULT true,
  CONSTRAINT provider_account_exposures_pkey PRIMARY KEY (workspace_id, provider_account_id)
);

CREATE INDEX provider_account_exposures_account_idx
  ON public.provider_account_exposures(provider_account_id);

-- Every existing job must retain an exposure before replacing its FK. This also
-- preserves the canonical account's own-workspace access after migration.
INSERT INTO public.provider_account_exposures (workspace_id, provider_account_id)
SELECT workspace_id, id FROM public.provider_accounts;

ALTER TABLE public.provider_account_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_account_exposures FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_account_exposures_read_policy
  ON public.provider_account_exposures FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- Until the owner-authorized grant service is installed, the web role can
-- create only the canonical account's own row. No target grant/revoke write
-- policy exists in this foundation slice.
CREATE POLICY provider_account_exposures_self_insert_policy
  ON public.provider_account_exposures FOR INSERT
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (
      SELECT 1 FROM public.provider_accounts AS account
      WHERE account.id = provider_account_exposures.provider_account_id
        AND account.workspace_id = provider_account_exposures.workspace_id
    )
  );

-- All account creation paths, including existing provider discovery, receive
-- their own-workspace row. Reconnect updates never reactivate revoked grants.
CREATE FUNCTION public.insert_provider_account_self_exposure()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.provider_account_exposures (workspace_id, provider_account_id)
  VALUES (NEW.workspace_id, NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER provider_accounts_self_exposure_insert
  AFTER INSERT ON public.provider_accounts
  FOR EACH ROW EXECUTE FUNCTION public.insert_provider_account_self_exposure();

ALTER TABLE public.publication_jobs
  DROP CONSTRAINT publication_jobs_workspace_provider_account_fk;
ALTER TABLE public.publication_jobs
  ADD CONSTRAINT publication_jobs_workspace_exposure_fk
  FOREIGN KEY (workspace_id, provider_account_id)
  REFERENCES public.provider_account_exposures(workspace_id, provider_account_id)
  ON DELETE RESTRICT;
