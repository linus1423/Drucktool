CREATE TYPE "public"."organisation_request_status" AS ENUM('open', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "organisation_members" (
	"user_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_members_user_id_organisation_id_pk" PRIMARY KEY("user_id","organisation_id")
);
--> statement-breakpoint
CREATE TABLE "organisation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "organisation_request_status" DEFAULT 'open' NOT NULL,
	"organisation_id" uuid,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organisation_id_organisations_id_fk";
--> statement-breakpoint
DROP INDEX "users_organisation_idx";--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD CONSTRAINT "organisation_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD CONSTRAINT "organisation_requests_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_requests" ADD CONSTRAINT "organisation_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisation_members_organisation_idx" ON "organisation_members" USING btree ("organisation_id");--> statement-breakpoint
CREATE INDEX "organisation_requests_status_idx" ON "organisation_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "organisation_requests_user_idx" ON "organisation_requests" USING btree ("user_id");--> statement-breakpoint
-- Bisherige Zuordnung (höchstens eine Organisation pro Benutzer) übernehmen.
INSERT INTO "organisation_members" ("user_id", "organisation_id", "created_at")
SELECT "id", "organisation_id", "created_at" FROM "users" WHERE "organisation_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "organisation_id";