ALTER TYPE "public"."request_event_type" ADD VALUE 'invoice_recorded';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "invoice_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "invoice_created_by_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "invoice_number" text;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_invoice_created_by_id_users_id_fk" FOREIGN KEY ("invoice_created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;