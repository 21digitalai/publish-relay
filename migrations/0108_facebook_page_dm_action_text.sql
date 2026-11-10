-- Legacy DM actions remain visible with unknown text; new reservations store the exact outbound body.
ALTER TABLE facebook_page_dm_actions ADD COLUMN text_body text;
ALTER TABLE facebook_page_dm_actions
  ADD CONSTRAINT facebook_page_dm_actions_text_body_length CHECK (text_body IS NULL OR length(text_body) BETWEEN 1 AND 2000);
