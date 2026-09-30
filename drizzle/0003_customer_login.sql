CREATE TABLE "login_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"redirect" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "organisation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "billing_address" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "billing_address" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "delivery_address" jsonb;--> statement-breakpoint
CREATE INDEX "login_tokens_email_idx" ON "login_tokens" USING btree ("email");--> statement-breakpoint
CREATE INDEX "requests_created_by_idx" ON "requests" USING btree ("created_by_id");