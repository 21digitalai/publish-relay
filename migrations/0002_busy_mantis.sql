CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_version" text NOT NULL,
	"wrapped_key" bytea NOT NULL,
	"wrapped_key_nonce" bytea NOT NULL,
	"wrapped_key_tag" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"nonce" bytea NOT NULL,
	"tag" bytea NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_transactions_state_hash_unique" UNIQUE("state_hash")
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_transactions" ADD CONSTRAINT "oauth_transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_accounts" ADD CONSTRAINT "provider_accounts_connection_id_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."provider_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credentials_workspace_idx" ON "credentials" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_transactions_workspace_idx" ON "oauth_transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_accounts_connection_external_unique" ON "provider_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE INDEX "provider_accounts_workspace_idx" ON "provider_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "provider_connections_workspace_idx" ON "provider_connections" USING btree ("workspace_id");
--> statement-breakpoint
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY credentials_workspace_policy ON credentials
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE oauth_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_transactions_workspace_policy ON oauth_transactions
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_connections_workspace_policy ON provider_connections
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
ALTER TABLE provider_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_accounts_workspace_policy ON provider_accounts
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
