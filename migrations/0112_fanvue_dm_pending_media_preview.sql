ALTER TABLE fanvue_dm_pending_intents ADD COLUMN media_preview_id uuid;
ALTER TABLE fanvue_dm_pending_intents ADD CONSTRAINT fanvue_dm_pending_intents_preview_check
  CHECK (media_preview_id IS NULL OR
    (price_cents IS NOT NULL AND media_ids @> jsonb_build_array(media_preview_id::text)));
