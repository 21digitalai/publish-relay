ALTER TABLE facebook_page_engagement_grants
  DROP CONSTRAINT facebook_page_engagement_capability_check;
ALTER TABLE facebook_page_engagement_grants
  ADD CONSTRAINT facebook_page_engagement_capability_check
  CHECK (capability IN (
    'comments:read', 'comments:propose', 'comments:send',
    'dms:read', 'dms:propose', 'dms:send',
    'facebook:guidance:read', 'facebook:guidance:write'
  ));
