ALTER TYPE "public"."request_event_type" ADD VALUE 'offer_created';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'offer_accepted';--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE 'offered' BEFORE 'submitted';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "offered_by_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_offered_by_id_users_id_fk" FOREIGN KEY ("offered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;