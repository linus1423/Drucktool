CREATE TABLE "request_number_counters" (
	"month" integer PRIMARY KEY NOT NULL,
	"last" integer NOT NULL
);
--> statement-breakpoint
-- Auftragsnummern im Format JJMMxxxx (Issue #90): Jahr und Monat in deutscher Zeit, dazu ein Zähler, der jeden
-- Monat bei 0001 beginnt. Bisherige Nummern (ab 1001) bleiben unverändert und können nicht kollidieren.
CREATE FUNCTION next_request_number() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
	current_month integer := to_char(now() AT TIME ZONE 'Europe/Berlin', 'YYMM')::integer;
	next_value integer;
BEGIN
	INSERT INTO request_number_counters (month, last) VALUES (current_month, 1)
	ON CONFLICT (month) DO UPDATE SET last = request_number_counters.last + 1
	RETURNING last INTO next_value;
	IF next_value > 9999 THEN
		RAISE EXCEPTION 'Mehr als 9999 Aufträge im Monat %, keine Auftragsnummer mehr frei', current_month;
	END IF;
	RETURN current_month * 10000 + next_value;
END;
$$;
--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "number" DROP IDENTITY;--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "number" SET DEFAULT next_request_number();
