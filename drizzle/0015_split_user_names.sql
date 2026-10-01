-- Vor- und Nachname getrennt (Issue #82). Bestehende Namen werden am letzten Leerzeichen geteilt:
-- „Anna Maria Muster“ → Vorname „Anna Maria“, Nachname „Muster“; ohne Leerzeichen landet alles im
-- Nachnamen. Dieselbe Regel steht in splitName (src/lib/name.ts). users.name bleibt als berechneter
-- Anzeigename erhalten.
ALTER TABLE "users" ADD COLUMN "first_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "users" SET
	"first_name" = CASE WHEN btrim("name") ~ '\s' THEN regexp_replace(btrim("name"), '\s+\S+$', '') ELSE '' END,
	"last_name" = CASE WHEN btrim("name") ~ '\s' THEN substring(btrim("name") from '\S+$') ELSE btrim("name") END;--> statement-breakpoint
-- Gespeicherte Rechnungsadressen im Profil ebenso umstellen. Die Kopien an Aufträgen bleiben unverändert
-- (eingefroren) und werden mit ihrem alten Feld „name“ weiter angezeigt.
UPDATE "users" SET "billing_address" = ("billing_address" - 'name') || jsonb_build_object(
	'firstName', CASE WHEN btrim("billing_address"->>'name') ~ '\s'
		THEN regexp_replace(btrim("billing_address"->>'name'), '\s+\S+$', '') ELSE '' END,
	'lastName', CASE WHEN btrim("billing_address"->>'name') ~ '\s'
		THEN substring(btrim("billing_address"->>'name') from '\S+$') ELSE coalesce(btrim("billing_address"->>'name'), '') END
)
WHERE "billing_address" IS NOT NULL AND "billing_address" ? 'name';--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" text GENERATED ALWAYS AS (btrim(first_name || ' ' || last_name)) STORED NOT NULL;
