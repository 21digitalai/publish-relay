-- Exact-job, read-only detail for a target member. The target cannot use the
-- origin workspace's ordinary job, post, revision or media RLS paths.
CREATE FUNCTION public.get_exposed_page_calendar_job(
  target_workspace_id uuid, requested_job_id uuid
) RETURNS TABLE (
  id uuid, provider_account_id uuid, provider_account_name text,
  origin_workspace_name text, state text, scheduled_at timestamptz,
  caption text, link_url text, media jsonb
)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT job.id, account.id, account.display_name, origin.name,
    job.state, job.scheduled_at, revision.content->>'text',
    revision.content->>'linkUrl',
    coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', object.id, 'mimeType', object.mime_type,
      'byteSize', object.byte_size, 'position', attached.position,
      'ready', object.state = 'ready'
    ) ORDER BY attached.position)
      FROM public.revision_media attached
      JOIN public.media_objects object
        ON object.workspace_id = attached.workspace_id AND object.id = attached.media_id
      WHERE attached.workspace_id = job.workspace_id
        AND attached.revision_id = job.revision_id), '[]'::jsonb)
  FROM public.publication_jobs job
  JOIN public.provider_accounts account ON account.id = job.provider_account_id
  JOIN public.provider_account_exposures exposure
    ON exposure.workspace_id = target_workspace_id AND exposure.provider_account_id = account.id
  JOIN public.post_revisions revision
    ON revision.workspace_id = job.workspace_id AND revision.id = job.revision_id
  JOIN public.workspaces origin ON origin.id = job.workspace_id
  WHERE target_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND job.id = requested_job_id AND job.workspace_id <> target_workspace_id
    AND EXISTS (SELECT 1 FROM public.memberships member
      WHERE member.workspace_id = target_workspace_id
        AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    AND exposure.revoked_at IS NULL AND exposure.show_other_workspace_posts
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL AND origin.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.get_exposed_page_calendar_job(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.get_exposed_page_calendar_job(uuid, uuid)
      TO publish_relay_web;
  END IF;
END
$$;
