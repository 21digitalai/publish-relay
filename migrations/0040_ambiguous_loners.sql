CREATE TABLE "auth_rate_limit_buckets" (
	"key_hash" text NOT NULL,
	"kind" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_limit_buckets_kind_key_hash_window_started_at_pk" PRIMARY KEY("kind","key_hash","window_started_at"),
	CONSTRAINT "auth_rate_limit_buckets_kind_check" CHECK ("auth_rate_limit_buckets"."kind" in ('email', 'network')),
	CONSTRAINT "auth_rate_limit_buckets_count_check" CHECK ("auth_rate_limit_buckets"."request_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"token_hash" text NOT NULL,
	"email_key_hash" text NOT NULL,
	"network_key_hash" text NOT NULL,
	"user_agent_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"redirect_path" text DEFAULT '/app' NOT NULL,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"provider_message_id" text,
	"correlation_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_challenges_purpose_check" CHECK ("login_challenges"."purpose" in ('login', 'signup')),
	CONSTRAINT "login_challenges_delivery_state_check" CHECK ("login_challenges"."delivery_state" in ('pending', 'sent', 'suppressed', 'failed')),
	CONSTRAINT "login_challenges_redirect_check" CHECK ("login_challenges"."redirect_path" like '/%' and "login_challenges"."redirect_path" not like '//%')
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_rate_limit_buckets_expiry_idx" ON "auth_rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "login_challenges_token_hash_unique" ON "login_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_challenges_email_created_idx" ON "login_challenges" USING btree ("email_key_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_network_created_idx" ON "login_challenges" USING btree ("network_key_hash","created_at");--> statement-breakpoint
CREATE INDEX "login_challenges_expiry_idx" ON "login_challenges" USING btree ("expires_at");
