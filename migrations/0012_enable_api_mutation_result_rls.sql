ALTER TABLE "api_mutation_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_mutation_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "api_mutation_results"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
