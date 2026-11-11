ALTER TABLE facebook_page_dm_actions ADD COLUMN bio_link_mention boolean NOT NULL DEFAULT false;
ALTER TABLE facebook_page_dm_pending_intents ADD COLUMN bio_link_mention boolean NOT NULL DEFAULT false;
ALTER TABLE facebook_page_dm_memory ADD COLUMN bio_link_mention_at timestamptz;
ALTER TABLE facebook_page_dm_memory ADD COLUMN bio_link_action_id uuid;
ALTER TABLE facebook_page_dm_memory ADD COLUMN bio_link_message_id text;
