CREATE TYPE "public"."internal_status" AS ENUM('in_progress', 'problem');--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'internal_status_changed' BEFORE 'assigned';--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "from_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "to_status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DEFAULT 'submitted'::text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "internal_status" "internal_status";--> statement-breakpoint
-- Bisherige Status auf den Workflow aus dem Lastenheft abbilden (Angebotsphase entfällt).
UPDATE "requests" SET "internal_status" = 'in_progress' WHERE "status" = 'printing';--> statement-breakpoint
UPDATE "requests" SET "status" = CASE "status"
  WHEN 'new' THEN 'submitted'
  WHEN 'in_review' THEN 'submitted'
  WHEN 'quoted' THEN 'submitted'
  WHEN 'approved' THEN 'confirmed'
  WHEN 'printing' THEN 'confirmed'
  WHEN 'shipped' THEN 'completed'
  ELSE "status" END;--> statement-breakpoint
UPDATE "request_events" SET
  "from_status" = CASE "from_status" WHEN 'new' THEN 'submitted' WHEN 'in_review' THEN 'submitted' WHEN 'quoted' THEN 'submitted' WHEN 'approved' THEN 'confirmed' WHEN 'printing' THEN 'confirmed' WHEN 'shipped' THEN 'completed' ELSE "from_status" END,
  "to_status" = CASE "to_status" WHEN 'new' THEN 'submitted' WHEN 'in_review' THEN 'submitted' WHEN 'quoted' THEN 'submitted' WHEN 'approved' THEN 'confirmed' WHEN 'printing' THEN 'confirmed' WHEN 'shipped' THEN 'completed' ELSE "to_status" END;--> statement-breakpoint
DELETE FROM "request_events" WHERE "type" = 'status_changed' AND "from_status" = "to_status";--> statement-breakpoint
DROP TYPE "public"."request_status";--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('submitted', 'confirmed', 'on_hold', 'completed', 'rejected', 'cancelled');--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "from_status" SET DATA TYPE "public"."request_status" USING "from_status"::"public"."request_status";--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "to_status" SET DATA TYPE "public"."request_status" USING "to_status"::"public"."request_status";--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DEFAULT 'submitted'::"public"."request_status";--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DATA TYPE "public"."request_status" USING "status"::"public"."request_status";--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "confirmed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_confirmed_by_id_users_id_fk" FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" DROP COLUMN "quote_amount_cents";--> statement-breakpoint
ALTER TABLE "requests" DROP COLUMN "quote_note";