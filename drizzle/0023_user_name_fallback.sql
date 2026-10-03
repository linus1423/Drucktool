-- Neue Kunden bekamen den Teil der E-Mail vor dem @ (Anmeldelink) bzw. die ganze Adresse (OIDC ohne
-- Namens-Claims) als Nachnamen (Issue #159). Wer das Profil noch nie gespeichert hat (keine
-- Rechnungsadresse), bekommt leere Namen und trägt sie beim nächsten Besuch im Profil ein.
UPDATE "users" SET "last_name" = ''
WHERE "role" = 'customer' AND "first_name" = '' AND "billing_address" IS NULL
	AND ("last_name" = split_part("email", '@', 1) OR "last_name" = "email");--> statement-breakpoint
-- Ohne Namen zeigt users.name die E-Mail-Adresse, damit Listen und Mails keinen leeren Namen enthalten.
ALTER TABLE "users" drop column "name";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "name" text GENERATED ALWAYS AS (coalesce(nullif(btrim(first_name || ' ' || last_name), ''), email)) STORED NOT NULL;
