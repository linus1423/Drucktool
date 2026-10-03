ALTER TABLE "organisation_requests" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "zip" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "country" text DEFAULT 'DE' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "vat_id" text;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD COLUMN "cost_center" text;