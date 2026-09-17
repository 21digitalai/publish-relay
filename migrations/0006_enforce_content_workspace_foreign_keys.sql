CREATE UNIQUE INDEX "media_objects_workspace_id_unique" ON "media_objects" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_revisions_workspace_id_unique" ON "post_revisions" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_workspace_id_unique" ON "posts" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_workspace_id_unique" ON "provider_accounts" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "publication_jobs_workspace_id_unique" ON "publication_jobs" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "post_revisions" DROP CONSTRAINT "post_revisions_post_id_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" DROP CONSTRAINT "provider_staging_artifacts_job_id_publication_jobs_id_fk";
--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" DROP CONSTRAINT "provider_staging_artifacts_media_id_media_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "publication_jobs" DROP CONSTRAINT "publication_jobs_post_id_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "publication_jobs" DROP CONSTRAINT "publication_jobs_revision_id_post_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "publication_jobs" DROP CONSTRAINT "publication_jobs_provider_account_id_provider_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "revision_media" DROP CONSTRAINT "revision_media_revision_id_post_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "revision_media" DROP CONSTRAINT "revision_media_media_id_media_objects_id_fk";
--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_workspace_post_fk" FOREIGN KEY ("workspace_id","post_id") REFERENCES "public"."posts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."publication_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_workspace_media_fk" FOREIGN KEY ("workspace_id","media_id") REFERENCES "public"."media_objects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_workspace_post_fk" FOREIGN KEY ("workspace_id","post_id") REFERENCES "public"."posts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_workspace_revision_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "public"."post_revisions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_jobs" ADD CONSTRAINT "publication_jobs_workspace_provider_account_fk" FOREIGN KEY ("workspace_id","provider_account_id") REFERENCES "public"."provider_accounts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_workspace_revision_fk" FOREIGN KEY ("workspace_id","revision_id") REFERENCES "public"."post_revisions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_workspace_media_fk" FOREIGN KEY ("workspace_id","media_id") REFERENCES "public"."media_objects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;
