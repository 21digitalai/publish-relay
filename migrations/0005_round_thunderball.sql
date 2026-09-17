CREATE TYPE "public"."media_state" AS ENUM('temporary', 'ready', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."publication_job_state" AS ENUM('scheduled', 'leased', 'dispatching', 'published', 'accepted_pending', 'retry_wait', 'failed', 'cancelled', 'superseded');--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"state" "media_state" DEFAULT 'temporary' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_staging_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"provider_reference" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publication_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"state" "publication_job_state" DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revision_media" (
	"workspace_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "revision_media_revision_id_media_id_pk" PRIMARY KEY("revision_id","media_id")
);
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_artifacts_job_id_publication_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."publication_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_artifacts_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_revision_id_post_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."post_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_revision_id_post_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."post_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_media_id_media_objects_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_objects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_objects_workspace_storage_unique" ON "media_objects" USING btree ("workspace_id","storage_key");--> statement-breakpoint
CREATE INDEX "media_objects_workspace_state_idx" ON "media_objects" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "post_revisions_post_number_unique" ON "post_revisions" USING btree ("post_id","revision_number");--> statement-breakpoint
CREATE INDEX "post_revisions_workspace_idx" ON "post_revisions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "posts_workspace_updated_idx" ON "posts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "provider_staging_expiry_idx" ON "provider_staging_artifacts" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "publication_jobs_workspace_due_idx" ON "publication_jobs" USING btree ("workspace_id","state","scheduled_at");--> statement-breakpoint
CREATE INDEX "publication_jobs_post_idx" ON "publication_jobs" USING btree ("post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_media_position_unique" ON "revision_media" USING btree ("revision_id","position");--> statement-breakpoint
CREATE INDEX "revision_media_workspace_idx" ON "revision_media" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "media_objects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_objects" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "posts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "revision_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "revision_media" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_objects_workspace_isolation" ON "media_objects" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "posts_workspace_isolation" ON "posts" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "post_revisions_workspace_isolation" ON "post_revisions" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "revision_media_workspace_isolation" ON "revision_media" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "publication_jobs_workspace_isolation" ON "publication_jobs" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "provider_staging_artifacts_workspace_isolation" ON "provider_staging_artifacts" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);--> statement-breakpoint
CREATE FUNCTION "reject_post_revision_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'post revisions are immutable';
END
$$;--> statement-breakpoint
CREATE TRIGGER "post_revisions_immutable" BEFORE UPDATE OR DELETE ON "post_revisions" FOR EACH ROW EXECUTE FUNCTION "reject_post_revision_mutation"();
