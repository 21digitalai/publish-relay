ALTER TABLE "api_mutation_results" DROP CONSTRAINT "api_mutation_results_api_key_id_api_keys_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_workspace_id_unique" ON "api_keys" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "api_mutation_results" ADD CONSTRAINT "api_mutation_results_workspace_api_key_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."api_keys"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
