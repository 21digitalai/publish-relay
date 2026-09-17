ALTER TABLE "post_revisions" ADD COLUMN "created_actor_type" "audit_actor_type";--> statement-breakpoint
ALTER TABLE "post_revisions" ADD COLUMN "created_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "created_actor_type" "audit_actor_type";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "created_actor_id" uuid;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "last_mutator_type" "audit_actor_type";--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "last_mutator_id" uuid;--> statement-breakpoint
COMMENT ON COLUMN "posts"."created_actor_type" IS 'Nullable only for imported legacy rows; CLI is transport metadata, never identity.';
