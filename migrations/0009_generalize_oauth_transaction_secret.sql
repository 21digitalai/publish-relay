ALTER TABLE "oauth_transactions" RENAME COLUMN "pkce_credential_id" TO "secret_credential_id";--> statement-breakpoint
ALTER TABLE "oauth_transactions" DROP CONSTRAINT "oauth_transactions_pkce_credential_id_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_secret_credential_id_credentials_id_fk" FOREIGN KEY ("secret_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;