CREATE TABLE "x_thread_parts" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"external_post_id" text NOT NULL,
	"external_url" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "x_thread_parts_workspace_id_job_id_position_pk" PRIMARY KEY("workspace_id","job_id","position"),
	CONSTRAINT "x_thread_parts_position_nonnegative" CHECK ("position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD CONSTRAINT "x_thread_parts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD CONSTRAINT "x_thread_parts_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."publication_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "x_thread_parts_external_post_unique" ON "x_thread_parts" USING btree ("workspace_id","external_post_id");--> statement-breakpoint
ALTER TABLE "x_thread_parts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "x_thread_parts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "x_thread_parts_workspace_isolation" ON "x_thread_parts" USING (workspace_id = current_setting('app.workspace_id', true)::uuid) WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
