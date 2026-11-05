ALTER TABLE engagement_proposals DROP CONSTRAINT engagement_proposals_status_check;
ALTER TABLE engagement_proposals ADD CONSTRAINT engagement_proposals_status_check
  CHECK (status IN ('pending', 'expired', 'superseded', 'dismissed', 'approved', 'sending', 'scheduled', 'cancelled', 'sent', 'unknown', 'failed'));
