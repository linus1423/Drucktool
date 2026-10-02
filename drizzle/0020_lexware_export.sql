ALTER TABLE "requests" ADD COLUMN "invoice_exported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "invoice_exported_by_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_invoice_exported_by_id_users_id_fk" FOREIGN KEY ("invoice_exported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_invoice_pending_idx" ON "requests" USING btree ("status") WHERE invoice_exported_at is null;--> statement-breakpoint
-- Bereits fertige Aufträge gelten als abgerechnet, damit der erste Sammel-Export sie nicht noch einmal enthält.
UPDATE "requests" SET "invoice_exported_at" = now() WHERE "status" = 'completed';
