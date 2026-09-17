ALTER TABLE "provider_accounts" ADD COLUMN "adapter_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "effective_provider_settings" jsonb;
