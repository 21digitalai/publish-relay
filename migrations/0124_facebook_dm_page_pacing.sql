ALTER TABLE facebook_page_engagement_modules
  ADD COLUMN dm_root_pacing_minimum_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN dm_root_pacing_maximum_seconds integer NOT NULL DEFAULT 120,
  ADD CONSTRAINT facebook_page_engagement_dm_root_pacing_check
    CHECK (dm_root_pacing_minimum_seconds >= 60 AND dm_root_pacing_maximum_seconds >= dm_root_pacing_minimum_seconds AND dm_root_pacing_maximum_seconds <= 600);
