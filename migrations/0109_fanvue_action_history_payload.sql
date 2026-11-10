-- Legacy actions retain unknown content; new reservations capture bounded outbound facts.
ALTER TABLE fanvue_action_intents ADD COLUMN text_body text;
ALTER TABLE fanvue_action_intents ADD COLUMN media_count integer;
ALTER TABLE fanvue_action_intents ADD COLUMN price_cents integer;
ALTER TABLE fanvue_action_intents
  ADD CONSTRAINT fanvue_action_intents_text_body_length CHECK (text_body IS NULL OR length(text_body) BETWEEN 1 AND 5000),
  ADD CONSTRAINT fanvue_action_intents_media_count_range CHECK (media_count IS NULL OR media_count BETWEEN 0 AND 10),
  ADD CONSTRAINT fanvue_action_intents_price_cents_range CHECK (price_cents IS NULL OR price_cents >= 300);
