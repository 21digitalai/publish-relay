-- Keep the selected-account target context with the immutable send reservation.
ALTER TABLE fanvue_action_intents ADD COLUMN target_label text;
ALTER TABLE fanvue_action_intents
  ADD CONSTRAINT fanvue_action_intents_target_label_length
  CHECK (target_label IS NULL OR length(target_label) BETWEEN 1 AND 160);
