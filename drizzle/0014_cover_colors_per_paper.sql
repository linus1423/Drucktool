CREATE TABLE "paper_cover_colors" (
	"paper_id" uuid NOT NULL,
	"cover_color_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_cover_colors" ADD CONSTRAINT "paper_cover_colors_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_cover_colors" ADD CONSTRAINT "paper_cover_colors_cover_color_id_cover_colors_id_fk" FOREIGN KEY ("cover_color_id") REFERENCES "public"."cover_colors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paper_cover_colors_unique" ON "paper_cover_colors" USING btree ("paper_id","cover_color_id");--> statement-breakpoint
-- Bisher galt jede Coverfarbe für jedes Deckblattpapier. Damit sich für bestehende Aufträge
-- und Kunden nichts ändert, bekommt jedes Deckblattpapier zunächst alle vorhandenen Farben.
-- Einschränkungen (z. B. 250 g/m² nur Weiß) pflegen Admins danach unter „Coverfarben“.
INSERT INTO "paper_cover_colors" ("paper_id", "cover_color_id")
SELECT p."id", c."id" FROM "papers" p CROSS JOIN "cover_colors" c WHERE p."for_cover" = true;
