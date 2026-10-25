ALTER TABLE fanvue_action_intents
  DROP CONSTRAINT fanvue_action_intents_kind_check;
ALTER TABLE fanvue_action_intents
  ADD CONSTRAINT fanvue_action_intents_kind_check
  CHECK (action_kind IN ('message', 'comment', 'chat_create'));
