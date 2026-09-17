ALTER TABLE "api_mutation_results" RENAME COLUMN "api_key_id" TO "actor_id";--> statement-breakpoint
ALTER TABLE "api_mutation_results" DROP CONSTRAINT "api_mutation_results_workspace_api_key_fk";
--> statement-breakpoint
DROP INDEX "api_mutation_results_scope_unique";--> statement-breakpoint
ALTER TABLE "api_mutation_results" ADD COLUMN "actor_type" text DEFAULT 'api-key' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_mutation_results" ALTER COLUMN "actor_type" DROP DEFAULT;--> statement-breakpoint
CREATE UNIQUE INDEX "api_mutation_results_scope_unique" ON "api_mutation_results" USING btree ("workspace_id","actor_type","actor_id","operation","idempotency_key");
