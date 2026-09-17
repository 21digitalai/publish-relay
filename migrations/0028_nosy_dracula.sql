CREATE TABLE "delegated_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" text[] NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegated_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegated_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rotated_from_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registered_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"client_type" text NOT NULL,
	"secret_hash" text,
	"redirect_uris" text[] NOT NULL,
	"allowed_scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_grants_workspace_id_unique" ON "delegated_grants" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "delegated_authorization_codes" ADD CONSTRAINT "delegated_authorization_codes_workspace_grant_fk" FOREIGN KEY ("workspace_id","grant_id") REFERENCES "public"."delegated_grants"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_authorization_codes" ADD CONSTRAINT "delegated_authorization_codes_client_fk" FOREIGN KEY ("client_id") REFERENCES "public"."registered_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_grants" ADD CONSTRAINT "delegated_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_grants" ADD CONSTRAINT "delegated_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_grants" ADD CONSTRAINT "delegated_grants_client_id_registered_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."registered_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tokens" ADD CONSTRAINT "delegated_tokens_workspace_grant_fk" FOREIGN KEY ("workspace_id","grant_id") REFERENCES "public"."delegated_grants"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegated_tokens" ADD CONSTRAINT "delegated_tokens_rotated_from_fk" FOREIGN KEY ("rotated_from_token_id") REFERENCES "public"."delegated_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_authorization_codes_hash_unique" ON "delegated_authorization_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "delegated_authorization_codes_expiry_idx" ON "delegated_authorization_codes" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "delegated_grants_workspace_user_idx" ON "delegated_grants" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "delegated_grants_workspace_client_idx" ON "delegated_grants" USING btree ("workspace_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tokens_access_hash_unique" ON "delegated_tokens" USING btree ("access_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "delegated_tokens_refresh_hash_unique" ON "delegated_tokens" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "delegated_tokens_workspace_grant_idx" ON "delegated_tokens" USING btree ("workspace_id","grant_id");--> statement-breakpoint
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['delegated_grants','delegated_authorization_codes','delegated_tokens'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
