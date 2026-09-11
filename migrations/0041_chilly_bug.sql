CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" uuid NOT NULL,
	"key_version" text NOT NULL,
	"wrapped_key" "bytea" NOT NULL,
	"wrapped_key_nonce" "bytea" NOT NULL,
	"wrapped_key_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_challenge_id_login_challenges_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."login_challenges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_outbox_challenge_unique" ON "auth_email_outbox" USING btree ("challenge_id");--> statement-breakpoint
CREATE INDEX "auth_email_outbox_available_idx" ON "auth_email_outbox" USING btree ("available_at","lease_expires_at");