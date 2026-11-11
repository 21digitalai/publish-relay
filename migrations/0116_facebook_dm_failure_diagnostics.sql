ALTER TABLE facebook_page_dm_actions
  ADD COLUMN failure_code integer,
  ADD COLUMN failure_subcode integer,
  ADD COLUMN failure_trace_id text,
  ADD COLUMN failure_transient boolean;

ALTER TABLE facebook_page_dm_actions ADD CONSTRAINT facebook_dm_failure_trace_safe_check
  CHECK (failure_trace_id IS NULL OR failure_trace_id ~ '^[A-Za-z0-9_-]{1,128}$');
