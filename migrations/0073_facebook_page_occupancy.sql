-- Advisory only: a member scheduling to a visible Page may see aggregate
-- occupied instants, never another workspace's job identity or content.
CREATE FUNCTION public.list_facebook_page_occupancy(
  target_workspace_id uuid, requested_account_id uuid,
  starts_at timestamptz, ends_at timestamptz,
  before_scheduled_at timestamptz, page_size integer
) RETURNS TABLE (scheduled_at timestamptz, job_count integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT job.scheduled_at, count(*)::integer
  FROM public.provider_accounts account
  JOIN public.publication_jobs job ON job.provider_account_id = account.id
  WHERE target_workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM public.memberships member
      WHERE member.workspace_id = target_workspace_id
        AND member.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
    AND account.id = requested_account_id
    AND account.destination_provider = 'facebook_page'
    AND account.disconnected_at IS NULL
    AND (account.workspace_id = target_workspace_id OR EXISTS (
      SELECT 1 FROM public.provider_account_exposures exposure
      WHERE exposure.workspace_id = target_workspace_id
        AND exposure.provider_account_id = account.id
        AND exposure.revoked_at IS NULL))
    AND starts_at < ends_at AND ends_at <= starts_at + interval '7 days'
    AND job.state = 'scheduled'
    AND job.scheduled_at >= starts_at AND job.scheduled_at < ends_at
    AND (before_scheduled_at IS NULL OR job.scheduled_at < before_scheduled_at)
  GROUP BY job.scheduled_at
  ORDER BY job.scheduled_at DESC
  LIMIT LEAST(GREATEST(page_size, 1), 101)
$$;

REVOKE ALL ON FUNCTION public.list_facebook_page_occupancy(
  uuid, uuid, timestamptz, timestamptz, timestamptz, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'publish_relay_web') THEN
    GRANT EXECUTE ON FUNCTION public.list_facebook_page_occupancy(
      uuid, uuid, timestamptz, timestamptz, timestamptz, integer) TO publish_relay_web;
  END IF;
END
$$;
