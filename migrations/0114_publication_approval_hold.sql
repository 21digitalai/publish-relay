ALTER TABLE publication_jobs
  ADD COLUMN approval_required boolean NOT NULL DEFAULT false,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by_user_id uuid;

CREATE INDEX publication_jobs_approval_due_idx
  ON publication_jobs (workspace_id, state, scheduled_at)
  WHERE approval_required = false OR approved_at IS NOT NULL;
