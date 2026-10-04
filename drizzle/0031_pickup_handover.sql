ALTER TYPE "public"."request_event_type" ADD VALUE 'handed_over';--> statement-breakpoint
ALTER TYPE "public"."request_event_type" ADD VALUE 'pickup_reminder_sent';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "handed_over_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "handed_over_by_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "pickup_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_handed_over_by_id_users_id_fk" FOREIGN KEY ("handed_over_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_awaiting_handover_idx" ON "requests" USING btree ("status_changed_at") WHERE status = 'completed' and handed_over_at is null;--> statement-breakpoint
-- Bestand (Issue #173): Was vor mehr als 14 Tagen fertig wurde, gilt als übergeben, damit der Filter „Liegt zur Abholung
-- bereit“ nicht mit Altaufträgen voll läuft. Jüngere fertige Aufträge bleiben offen, bekommen aber keine Erinnerung,
-- weil niemand weiß, ob sie schon abgeholt wurden.
UPDATE "requests" SET "handed_over_at" = "status_changed_at" WHERE "status" = 'completed' AND "status_changed_at" < now() - interval '14 days';--> statement-breakpoint
UPDATE "requests" SET "pickup_reminder_sent_at" = now() WHERE "status" = 'completed' AND "handed_over_at" IS NULL;
