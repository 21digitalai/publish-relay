CREATE TYPE "public"."publication_attempt_outcome" AS ENUM('published', 'accepted_pending', 'unknown', 'auth', 'rate_limit', 'validation', 'transient', 'permanent');--> statement-breakpoint
CREATE TABLE "publication_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "publication_attempt_outcome",
	"provider_request_id" text,
	"external_post_id" text,
	"reconciliation_key" text,
	"retry_at" timestamp with time zone,
	"redacted_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" "publication_job_state",
	"to_state" "publication_job_state" NOT NULL,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "attempt_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD COLUMN "reconciliation_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_attempts" ADD CONSTRAINT "publication_attempts_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."publication_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_job_events" ADD CONSTRAINT "publication_job_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_job_events" ADD CONSTRAINT "publication_job_events_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."publication_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "publication_attempts_job_number_unique" ON "publication_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_attempts_idempotency_unique" ON "publication_attempts" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "publication_attempts_reconciliation_idx" ON "publication_attempts" USING btree ("workspace_id","reconciliation_key");--> statement-breakpoint
CREATE INDEX "publication_job_events_job_created_idx" ON "publication_job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "publication_jobs_lease_expiry_idx" ON "publication_jobs" USING btree ("workspace_id","lease_expires_at");--> statement-breakpoint
ALTER TABLE "publication_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_job_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_job_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "publication_attempts_workspace_isolation" ON "publication_attempts" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "publication_job_events_workspace_isolation" ON "publication_job_events" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE TRIGGER "publication_job_events_append_only" BEFORE UPDATE OR DELETE ON "publication_job_events" FOR EACH ROW EXECUTE FUNCTION "reject_audit_mutation"();
