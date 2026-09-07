ALTER TABLE "provider_staging_artifacts" DROP CONSTRAINT "provider_staging_artifacts_provider_reference_credential_id_credentials_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_workspace_id_unique" ON "credentials" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "provider_staging_artifacts" ADD CONSTRAINT "provider_staging_workspace_reference_credential_fk" FOREIGN KEY ("workspace_id","provider_reference_credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
