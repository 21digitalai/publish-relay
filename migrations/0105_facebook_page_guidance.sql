ALTER TABLE provider_accounts
  ADD COLUMN facebook_page_profile text NOT NULL DEFAULT '',
  ADD COLUMN facebook_page_dm_guidance text NOT NULL DEFAULT '',
  ADD COLUMN facebook_page_comment_guidance text NOT NULL DEFAULT '';
