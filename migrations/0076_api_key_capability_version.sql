ALTER TABLE public.api_keys
  ADD COLUMN capability_version integer NOT NULL DEFAULT 1;
