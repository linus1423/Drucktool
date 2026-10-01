ALTER TYPE "public"."request_event_type" ADD VALUE 'change_proposed';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'change_accepted';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'change_rejected';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'change_withdrawn';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "proposal" jsonb;