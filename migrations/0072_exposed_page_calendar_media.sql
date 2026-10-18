-- Storage identity never crosses the HTTP boundary; the browser receives only
-- bytes for an exact ready media object attached to an authorized mirror job.
CREATE FUNCTION public.get_exposed_page_calendar_media(
  target_workspace_id uuid, requested_job_id uuid, requested_media_id uuid
) RETURNS TABLE (storage_key text, mime_type text, byte_size bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT object.storage_key, object.mime_type, object.byte_size
  FROM public.get_exposed_page_calendar_job(target_workspace_id, requested_job_id) detail
  JOIN public.publication_jobs job ON job.id = detail.id
  JOIN public.revision_media attached
    ON attached.workspace_id = job.workspace_id AND attached.revision_id = job.revision_id
      AND attached.media_id = requested_media_id
  JOIN public.media_objects object
    ON object.workspace_id = attached.workspace_id AND object.id = attached.media_id
  WHERE object.state = 'ready'
$$;

REVOKE ALL ON FUNCTION public.get_exposed_page_calendar_media(uuid, uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.get_exposed_page_calendar_media(uuid, uuid, uuid)
      TO publish_relay_web;
  END IF;
END
$$;
