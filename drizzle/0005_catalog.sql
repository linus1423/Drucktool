CREATE TYPE "public"."binding_price_unit" AS ENUM('copy', 'sheet');--> statement-breakpoint
CREATE TYPE "public"."format_kind" AS ENUM('print', 'plot', 'custom');--> statement-breakpoint
CREATE TABLE "bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"price_unit" "binding_price_unit" DEFAULT 'copy' NOT NULL,
	"setup_fee_cents" integer DEFAULT 0 NOT NULL,
	"allows_duplex" boolean DEFAULT true NOT NULL,
	"allows_cover" boolean DEFAULT false NOT NULL,
	"allows_split_cover" boolean DEFAULT false NOT NULL,
	"trimmed" boolean DEFAULT false NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"help_text" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cover_colors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"hex" text,
	"transparent" boolean DEFAULT false NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "format_bindings" (
	"format_id" text NOT NULL,
	"binding_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "formats" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" "format_kind" DEFAULT 'print' NOT NULL,
	"width_mm" integer,
	"height_mm" integer,
	"allows_duplex" boolean DEFAULT true NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"help_text" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"grammage" integer NOT NULL,
	"price_a3_cents" integer,
	"price_sra3_cents" integer,
	"price_a0_cents" integer,
	"price_a1_cents" integer,
	"price_a2_cents" integer,
	"for_cover" boolean DEFAULT false NOT NULL,
	"for_inner" boolean DEFAULT true NOT NULL,
	"for_plotter" boolean DEFAULT false NOT NULL,
	"max_format_id" text,
	"available" boolean DEFAULT true NOT NULL,
	"help_text" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_changes" ADD CONSTRAINT "catalog_changes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_bindings" ADD CONSTRAINT "format_bindings_format_id_formats_id_fk" FOREIGN KEY ("format_id") REFERENCES "public"."formats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "format_bindings" ADD CONSTRAINT "format_bindings_binding_id_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_max_format_id_formats_id_fk" FOREIGN KEY ("max_format_id") REFERENCES "public"."formats"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_changes_created_idx" ON "catalog_changes" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "format_bindings_unique" ON "format_bindings" USING btree ("format_id","binding_id");--> statement-breakpoint
-- Startdaten aus dem Lastenheft V2. Preise ohne Angabe im Lastenheft sind Platzhalter
-- und werden in der Preisverwaltung angepasst.
INSERT INTO "formats" ("id", "label", "kind", "width_mm", "height_mm", "allows_duplex", "help_text", "sort_order") VALUES
  ('A0', 'A0', 'plot', 841, 1189, false, 'Großformatposter (84,1 × 118,9 cm), gedruckt auf dem Plotter. Nur einseitig.', 10),
  ('A1', 'A1', 'plot', 594, 841, false, 'Großformatposter (59,4 × 84,1 cm), gedruckt auf dem Plotter. Nur einseitig.', 20),
  ('A2', 'A2', 'plot', 420, 594, false, 'Poster (42 × 59,4 cm), gedruckt auf dem Plotter. Nur einseitig.', 30),
  ('A3', 'A3', 'print', 297, 420, true, 'Doppelt so groß wie A4 (29,7 × 42 cm), z. B. für Aushänge und Pläne.', 40),
  ('A4', 'A4', 'print', 210, 297, true, 'Das übliche Briefformat (21 × 29,7 cm), z. B. für Skripte und Abschlussarbeiten.', 50),
  ('A5', 'A5', 'print', 148, 210, true, 'Halbes A4 (14,8 × 21 cm), z. B. für Hefte und Flyer.', 60),
  ('A6', 'A6', 'print', 105, 148, true, 'Postkartengröße (10,5 × 14,8 cm).', 70),
  ('A7', 'A7', 'print', 74, 105, true, 'Kleine Karten und Flyer (7,4 × 10,5 cm).', 80),
  ('B5', 'B5', 'print', 176, 250, true, 'Etwas größer als A5 (17,6 × 25 cm), typisch für Bücher.', 90),
  ('business_cards', 'Visitenkarten', 'print', 85, 55, true, 'Visitenkarten im Format 85 × 55 mm.', 100),
  ('custom', 'Sonderformat', 'custom', NULL, NULL, true, 'Eigenes Format. Bitte die Maße in den Bemerkungen angeben.', 110);
--> statement-breakpoint
INSERT INTO "bindings" ("id", "label", "price_cents", "price_unit", "setup_fee_cents", "allows_cover", "allows_split_cover", "trimmed", "help_text", "sort_order") VALUES
  ('loose', 'Lose', 0, 'copy', 0, false, false, false, 'Einzelne Blätter ohne Bindung.', 10),
  ('corner_staple', 'Eckheftung', 0, 'copy', 0, false, false, false, 'Eine Heftklammer oben links.', 20),
  ('plastic_comb', 'Plastikkammbindung', 200, 'copy', 0, true, true, false, 'Ringbindung mit Plastikkamm. Das Dokument lässt sich flach aufschlagen; Deckblatt und Rückseite in Wunschfarbe oder durchsichtig.', 30),
  ('glue', 'Leimbindung', 200, 'copy', 700, true, false, true, 'Wie ein Taschenbuch: die Seiten werden am Rücken verleimt und das Buch wird zugeschnitten.', 40),
  ('glue_dissertation', 'Leimbindung Dissertation', 500, 'copy', 700, true, false, true, 'Leimbindung mit festem Umschlag für Dissertationen. Das Buch wird zugeschnitten.', 50),
  ('saddle_stitch', 'Booklet mit Rückstichheftung', 100, 'copy', 0, true, false, false, 'Gefalzte Bögen, in der Mitte geheftet, wie ein Heft. Die Seitenzahl muss durch 4 teilbar sein.', 60),
  ('tape', 'Klebestreifen bzw. Fälzelbindung', 200, 'copy', 0, true, true, false, 'Die Blätter werden mit einem Klebestreifen am Rücken zusammengehalten.', 70),
  ('laminated', 'Laminiert', 100, 'sheet', 0, false, false, false, 'Jedes Blatt wird in Folie eingeschweißt, z. B. für Aushänge.', 80);
--> statement-breakpoint
INSERT INTO "format_bindings" ("format_id", "binding_id") VALUES
  ('A0', 'loose'), ('A1', 'loose'), ('A2', 'loose'),
  ('A3', 'loose'), ('A3', 'corner_staple'), ('A3', 'laminated'),
  ('A4', 'loose'), ('A4', 'corner_staple'), ('A4', 'plastic_comb'), ('A4', 'glue'), ('A4', 'glue_dissertation'), ('A4', 'saddle_stitch'), ('A4', 'tape'), ('A4', 'laminated'),
  ('A5', 'loose'), ('A5', 'corner_staple'), ('A5', 'glue'), ('A5', 'glue_dissertation'), ('A5', 'saddle_stitch'), ('A5', 'tape'),
  ('A6', 'loose'), ('A7', 'loose'), ('business_cards', 'loose'),
  ('B5', 'loose'), ('B5', 'corner_staple'), ('B5', 'glue'), ('B5', 'glue_dissertation'), ('B5', 'tape'),
  ('custom', 'loose'), ('custom', 'corner_staple'), ('custom', 'glue'), ('custom', 'glue_dissertation'), ('custom', 'saddle_stitch'), ('custom', 'tape'), ('custom', 'laminated');
--> statement-breakpoint
INSERT INTO "papers" ("name", "grammage", "price_a3_cents", "price_sra3_cents", "price_a0_cents", "price_a1_cents", "price_a2_cents", "for_cover", "for_inner", "for_plotter", "max_format_id", "help_text", "sort_order") VALUES
  ('Standardpapier', 80, 2, 3, NULL, NULL, NULL, false, true, false, 'A3', 'Normales Kopierpapier.', 10),
  ('Dickes Papier', 160, 6, 8, NULL, NULL, NULL, true, true, false, 'A3', 'Kräftiges Papier, gut für Deckblätter und Flyer.', 20),
  ('Karton', 300, 15, 20, NULL, NULL, NULL, true, false, false, 'A3', 'Fester Karton für Umschläge und Visitenkarten.', 30),
  ('Plotterpapier', 90, NULL, NULL, 1500, 1200, 900, false, false, true, 'A0', 'Standardpapier für Poster auf dem Plotter.', 40);
--> statement-breakpoint
INSERT INTO "cover_colors" ("name", "hex", "transparent", "sort_order") VALUES
  ('Weiß', '#ffffff', false, 10),
  ('Schwarz', '#111827', false, 20),
  ('Dunkelblau', '#1e3a8a', false, 30),
  ('Dunkelrot', '#7f1d1d', false, 40),
  ('Durchsichtig', NULL, true, 50);
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES
  ('pricing', '{"printA4Cents": 10, "printA3Cents": 20, "minimumOrderCents": 100, "housePostCents": 0, "housePostPlotCents": 200}'),
  ('texts', '{"turnaround": "Die meisten Aufträge sind nach 2 bis 3 Werktagen fertig. Größere Bindungen und Plots können länger dauern.", "plots": "Plots sind Großformatposter (A0 bis A2), die auf dem Plotter gedruckt werden."}');
