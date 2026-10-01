ALTER TYPE "public"."request_event_type" ADD VALUE 'print_sheet_changed';--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "sheet_sizes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "print_sheet" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "cover_print_sheet" jsonb;--> statement-breakpoint
-- Bisherige Papiere: vorrätig in den Bögen, für die ein Preis hinterlegt ist; Plotterpapier im größten Format.
UPDATE "papers" SET "sheet_sizes" = (
	CASE WHEN "price_a3_cents" IS NOT NULL THEN '[{"label":"A3","widthMm":297,"heightMm":420}]'::jsonb ELSE '[]'::jsonb END
	|| CASE WHEN "price_sra3_cents" IS NOT NULL THEN '[{"label":"SRA3","widthMm":320,"heightMm":450}]'::jsonb ELSE '[]'::jsonb END
	|| COALESCE((
		SELECT jsonb_build_array(jsonb_build_object('label', f."label", 'widthMm', f."width_mm", 'heightMm', f."height_mm"))
		FROM "formats" f
		WHERE "papers"."for_plotter" AND f."id" = "papers"."max_format_id" AND f."width_mm" IS NOT NULL
	), '[]'::jsonb)
);
