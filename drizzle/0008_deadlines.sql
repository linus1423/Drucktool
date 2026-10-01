ALTER TYPE "public"."request_event_type" ADD VALUE 'dates_changed';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "promised_date" date;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "internal_due_date" date;--> statement-breakpoint
UPDATE "requests" SET "status_changed_at" = "updated_at";--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES ('deadlines', '{"staleSubmittedDays": 2, "staleOnHoldDays": 5, "staleConfirmedDays": 10}') ON CONFLICT DO NOTHING;
