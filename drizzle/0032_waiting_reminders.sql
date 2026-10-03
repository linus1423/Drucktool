ALTER TYPE "public"."request_event_type" ADD VALUE 'reminder_sent';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "reminded_at" timestamp with time zone;