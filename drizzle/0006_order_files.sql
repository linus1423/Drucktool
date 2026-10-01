CREATE TYPE "public"."delivery_method" AS ENUM('pickup', 'house_post');--> statement-breakpoint
CREATE TYPE "public"."file_role" AS ENUM('main', 'cover');--> statement-breakpoint
CREATE TYPE "public"."pdf_status" AS ENUM('ok', 'encrypted', 'unreadable', 'not_pdf');--> statement-breakpoint
CREATE TABLE "request_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"request_id" uuid,
	"role" "file_role" NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"pdf_status" "pdf_status" NOT NULL,
	"page_count" integer,
	"page_width_mm" integer,
	"page_height_mm" integer,
	"mixed_page_sizes" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "order" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "total_cents" integer;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "delivery_method" "delivery_method" DEFAULT 'pickup' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "delivery_address" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "request_files" ADD CONSTRAINT "request_files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_files" ADD CONSTRAINT "request_files_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_files_request_idx" ON "request_files" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_files_owner_idx" ON "request_files" USING btree ("owner_id");--> statement-breakpoint
-- Auftragsbedingungen, denen der Kunde beim Absenden zustimmt (Platzhalter bis zur Abstimmung mit dem Vorstand).
UPDATE "settings" SET "value" = "value" || jsonb_build_object('terms', 'Mit dem Absenden geben Sie ein verbindliches Angebot zum angezeigten Preis ab. Ein Vertrag kommt erst zustande, wenn ein Mitarbeiter der Druckerei Ihren Auftrag bestätigt. Bis dahin können Sie den Auftrag stornieren. Wir drucken Ihre Dateien so, wie Sie sie hochgeladen haben; bitte prüfen Sie Inhalt, Seitenzahl und Format vor dem Absenden.') WHERE "key" = 'texts' AND NOT ("value" ? 'terms');
--> statement-breakpoint
UPDATE "formats" SET "help_text" = 'Eigenes Format bis 32 × 45 cm. Breite und Höhe geben Sie im nächsten Schritt an.' WHERE "id" = 'custom' AND "help_text" = 'Eigenes Format. Bitte die Maße in den Bemerkungen angeben.';
