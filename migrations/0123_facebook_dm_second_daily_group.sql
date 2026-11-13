ALTER TABLE facebook_page_engagement_modules
  ADD COLUMN dm_daily_group_maximum integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT facebook_page_engagement_dm_daily_group_maximum_check
    CHECK (dm_daily_group_maximum IN (1, 2));
