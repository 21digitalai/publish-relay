ALTER TABLE engagement_proposals DROP CONSTRAINT engagement_proposals_status_check;
ALTER TABLE engagement_proposals ADD CONSTRAINT engagement_proposals_status_check
  CHECK (status IN ('pending', 'expired', 'dismissed', 'approved', 'sending', 'scheduled', 'cancelled', 'sent', 'unknown', 'failed'));

CREATE INDEX engagement_proposals_due_expiry_idx ON engagement_proposals(planned_due_at)
  WHERE status = 'pending' AND provider = 'facebook_page' AND kind = 'dm';
