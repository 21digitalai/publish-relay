ALTER TABLE "x_thread_parts" ALTER COLUMN "external_post_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ALTER COLUMN "external_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ALTER COLUMN "published_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD COLUMN "dispatch_key" text;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD COLUMN "dispatch_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "x_thread_parts" SET "dispatch_key" = 'legacy:' || "job_id"::text || ':' || "position"::text, "state" = 'published', "dispatch_started_at" = "published_at";--> statement-breakpoint
ALTER TABLE "x_thread_parts" ALTER COLUMN "dispatch_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ALTER COLUMN "state" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "x_thread_parts" ALTER COLUMN "dispatch_started_at" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "x_thread_parts_dispatch_key_unique" ON "x_thread_parts" USING btree ("workspace_id","dispatch_key");--> statement-breakpoint
ALTER TABLE "x_thread_parts" ADD CONSTRAINT "x_thread_parts_state_valid" CHECK ("x_thread_parts"."state" in ('dispatching', 'published'));
