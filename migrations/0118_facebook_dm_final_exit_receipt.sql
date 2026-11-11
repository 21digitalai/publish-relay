ALTER TABLE facebook_page_dm_actions ADD COLUMN final_exit boolean NOT NULL DEFAULT false;
ALTER TABLE facebook_page_dm_pending_intents ADD COLUMN final_exit boolean NOT NULL DEFAULT false;
ALTER TABLE facebook_page_dm_no_go ADD COLUMN reason text NOT NULL DEFAULT 'manual';
ALTER TABLE facebook_page_dm_no_go ADD COLUMN final_action_id uuid;
ALTER TABLE facebook_page_dm_no_go ADD COLUMN final_message_id text;
ALTER TABLE facebook_page_dm_memory ADD COLUMN final_exit_at timestamptz;
ALTER TABLE facebook_page_dm_memory ADD COLUMN final_action_id uuid;
ALTER TABLE facebook_page_dm_memory ADD COLUMN final_message_id text;
ALTER TABLE facebook_page_dm_no_go ADD CONSTRAINT facebook_page_dm_no_go_reason_check CHECK (reason IN ('manual', 'campaign_final'));
