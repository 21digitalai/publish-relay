-- A target member can see only bounded jobs for Pages actively exposed there.
-- Source jobs stay under their origin workspace's RLS; this projection returns
-- a deliberately small, read-only calendar contract without widening SELECT.
CREATE INDEX publication_jobs_account_schedule_idx
  ON public.publication_jobs(provider_account_id, scheduled_at, id);

CREATE FUNCTION public.list_exposed_page_calendar_jobs(
  target_workspace_id uuid, starts_at timestamptz, ends_at timestamptz,
  after_scheduled_at timestamptz, after_id uuid, page_size integer
) RETURNS TABLE (
  id uuid, provider_account_id uuid, provider_account_name text,
  origin_workspace_name text, state text, scheduled_at timestamptz,
  content_preview text, media_count integer
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT job.id, account.id, account.display_name, origin.name,
    job.state, job.scheduled_at,
    left(coalesce(revision.content->>'text', ''), 160),
    (SELECT count(*)::integer FROM public.revision_media media
      WHERE media.workspace_id = job.workspace_id AND media.revision_id = job.revision_id)
  FROM public.provider_account_exposures exposure
  JOIN public.provider_accounts account ON account.id = exposure.provider_account_id
  JOIN public.publication_jobs job ON job.provider_account_id = account.id
  JOIN public.post_revisions revision
    ON revision.workspace_id = job.workspace_id AND revision.id = job.revision_id
  JOIN public.workspaces origin ON origin.id = job.workspace_id
  WHERE target_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM public.memberships member
      WHERE member.workspace_id = target_workspace_id
        AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    AND exposure.workspace_id = target_workspace_id
    AND exposure.revoked_at IS NULL AND exposure.show_other_workspace_posts
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL
    AND job.workspace_id <> target_workspace_id
    AND origin.deleted_at IS NULL
    AND starts_at < ends_at AND ends_at <= starts_at + interval '45 days'
    AND job.scheduled_at >= starts_at AND job.scheduled_at < ends_at
    AND (after_scheduled_at IS NULL OR (job.scheduled_at, job.id) >
      (after_scheduled_at, after_id))
  ORDER BY job.scheduled_at, job.id
  LIMIT LEAST(GREATEST(page_size, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.list_exposed_page_calendar_jobs(
  uuid, timestamptz, timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_exposed_page_calendar_jobs(
      uuid, timestamptz, timestamptz, timestamptz, uuid, integer) TO publish_relay_web;
  END IF;
END
$$;
