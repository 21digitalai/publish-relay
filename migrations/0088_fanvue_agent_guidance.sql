ALTER TABLE public.provider_accounts
  ADD COLUMN fanvue_agent_guidance text NOT NULL DEFAULT '';

ALTER TABLE public.provider_accounts
  ADD CONSTRAINT provider_accounts_fanvue_agent_guidance_length
  CHECK (char_length(fanvue_agent_guidance) <= 10000);
