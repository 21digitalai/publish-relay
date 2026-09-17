CREATE TABLE "external_draft_media" (
	"workspace_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "external_draft_media_draft_id_media_id_pk" PRIMARY KEY("draft_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "external_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_actor_type" "audit_actor_type" NOT NULL,
	"source_actor_id" uuid NOT NULL,
	"source_client_id" text,
	"external_id" text NOT NULL,
	"label" text,
	"return_url" text,
	"request_fingerprint" text NOT NULL,
	"post_id" uuid,
	"transitioned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "external_drafts_workspace_id_unique" ON "external_drafts" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "external_draft_media" ADD CONSTRAINT "external_draft_media_workspace_draft_fk" FOREIGN KEY ("workspace_id","draft_id") REFERENCES "public"."external_drafts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_draft_media" ADD CONSTRAINT "external_draft_media_workspace_media_fk" FOREIGN KEY ("workspace_id","media_id") REFERENCES "public"."media_objects"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_drafts" ADD CONSTRAINT "external_drafts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_drafts" ADD CONSTRAINT "external_drafts_source_client_id_registered_clients_id_fk" FOREIGN KEY ("source_client_id") REFERENCES "public"."registered_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_drafts" ADD CONSTRAINT "external_drafts_workspace_post_fk" FOREIGN KEY ("workspace_id","post_id") REFERENCES "public"."posts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_draft_media_position_unique" ON "external_draft_media" USING btree ("draft_id","position");--> statement-breakpoint
CREATE INDEX "external_draft_media_workspace_idx" ON "external_draft_media" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_drafts_source_external_unique" ON "external_drafts" USING btree ("workspace_id","source_actor_type","source_actor_id","external_id");--> statement-breakpoint
CREATE INDEX "external_drafts_workspace_created_idx" ON "external_drafts" USING btree ("workspace_id","created_at");--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['external_drafts','external_draft_media'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
