ALTER TYPE "public"."request_event_type" ADD VALUE 'files_purged';--> statement-breakpoint
ALTER TABLE "request_files" ADD COLUMN "purged_at" timestamp with time zone;