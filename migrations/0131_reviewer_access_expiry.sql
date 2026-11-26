ALTER TABLE users
  ADD COLUMN review_access_expires_at timestamptz;

ALTER TABLE users
  ADD CONSTRAINT users_review_access_requires_password
  CHECK (review_access_expires_at IS NULL OR password_hash IS NOT NULL);
