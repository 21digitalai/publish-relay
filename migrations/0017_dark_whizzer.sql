CREATE TABLE "browser_mutation_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_mutation_results" ADD CONSTRAINT "browser_mutation_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_mutation_results" ADD CONSTRAINT "browser_mutation_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_mutation_results_scope_unique" ON "browser_mutation_results" USING btree ("workspace_id","user_id","operation","idempotency_key");--> statement-breakpoint
CREATE INDEX "browser_mutation_results_workspace_created_idx" ON "browser_mutation_results" USING btree ("workspace_id","created_at");
--> statement-breakpoint
ALTER TABLE "browser_mutation_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "browser_mutation_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "browser_mutation_results"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
