# Drucktool

Anfrage- und Auftragsverwaltung für eine Druckerei. Kunden (Organisationen) stellen Anfragen, Mitarbeiter
bearbeiten sie über einen Status-Workflow bis zur Auslieferung.

## Stack

- [TanStack Start](https://tanstack.com/start) mit Router, Query, Form und Table
- PostgreSQL mit [Drizzle ORM](https://orm.drizzle.team)
- Tailwind CSS
- Docker und Ansible für den Betrieb

## Rollen

| Rolle       | Rechte                                                                           |
| ----------- | -------------------------------------------------------------------------------- |
| Superadmin  | Alles, gibt Registrierungen frei, verwaltet Administratoren, sieht das Protokoll |
| Admin       | Organisationen und Benutzer (Mitarbeiter, Kunden) verwalten, Anfragen bearbeiten |
| Mitarbeiter | Alle Anfragen bearbeiten, Status wechseln, zuweisen, interne Notizen schreiben   |
| Kunde       | Eigene Aufträge anlegen, verfolgen und kommentieren                              |

## Anmeldung

- **Kunden** melden sich per Anmeldelink an: E-Mail-Adresse eingeben, Link aus der Mail öffnen, fertig. Beim ersten
  Link entsteht das Konto, ohne Freigabe durch die Druckerei. Der Link gilt 15 Minuten und nur einmal; gespeichert wird
  nur ein Hash. Mit `CUSTOMER_EMAIL_DOMAINS` (z. B. `tum.de`) lassen sich neue Konten auf bestimmte Domains
  beschränken. Vor dem ersten Auftrag hinterlegen Kunden im **Profil** ihre Rechnungsadresse, optional eine
  Lieferadresse für die Hauspost. Die Rechnungsadresse wird beim Absenden als Kopie am Auftrag gespeichert.
- **Mitarbeiter und Admins** melden sich über OpenID Connect (z. B. Microsoft Entra ID) oder mit Passwort an, siehe
  unten.
- Organisationen sind optional. Ein Kunde kann keiner, einer oder mehreren Organisationen angehören und wählt beim
  Bestellen eine davon (oder keine). Im Profil kann er eine Organisation anfragen; Mitarbeiter und Admins ordnen ihn
  unter „Organisationsanfragen“ einer bestehenden zu, legen eine neue an oder lehnen ab. Der Kunde bekommt jeweils eine
  E-Mail. Eine deaktivierte Organisation sperrt kein Konto, sie steht beim Bestellen nur nicht mehr zur Auswahl.
- Kunden sehen nur die Aufträge, die sie selbst angelegt haben.

Im Profil sieht jeder seine angemeldeten Geräte und kann sie einzeln oder alle anderen abmelden.

## Sicherheit

- **Rate-Limits** stehen in PostgreSQL (Tabelle `rate_limits`) und gelten damit über Neustarts und mehrere Instanzen
  hinweg. Pro IP: 10 Passwort-Logins pro Minute, 10 Anmeldelinks pro 10 Minuten (3 pro Adresse). Gespeichert wird nur
  ein Hash von IP bzw. E-Mail-Adresse.
- **Kontosperre:** Nach 5 falschen Passwörtern innerhalb von 15 Minuten wird die Anmeldung für diese E-Mail-Adresse
  gesperrt, unabhängig von der IP: erst 1 Minute, bei jedem weiteren Fehlversuch doppelt so lange, höchstens eine
  Stunde. Eine erfolgreiche Anmeldung setzt den Zähler zurück. Unbekannte Adressen werden genauso gezählt, damit die
  Sperre nichts über vorhandene Konten verrät.
- **Audit-Log:** Freigaben und Ablehnungen von Registrierungen, Anlegen und Ändern von Benutzern und Organisationen
  (Vorher/Nachher, IP, Zeitpunkt) sowie alle Anmeldungen, erfolgreich oder nicht, landen in der Tabelle `audit_log`.
  Admin-Aktionen werden in derselben Transaktion wie die Änderung geschrieben. Passwörter und Hashes stehen nie im
  Log, nur ob ein Passwort gesetzt wurde. Superadmins sehen das Protokoll unter **Protokoll** (`/admin/protokoll`) mit
  Filter nach Benutzer, Organisation, Aktion und Zeitraum. Einträge werden nach `AUDIT_LOG_RETENTION_DAYS` Tagen
  gelöscht (Standard 365, 0 = nie).
- **Security-Header** setzt die App selbst (Middleware in `src/start.ts`), damit sie auch ohne Caddy gelten:
  Content-Security-Policy mit Nonce pro Antwort für die Inline-Skripte von TanStack Start (`script-src 'self'
'nonce-…'`, `frame-ancestors 'none'`, `object-src 'none'`), `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options`, `Permissions-Policy` und Cross-Origin-Header. `Strict-Transport-Security` nur mit HTTPS (gleiche
  Regel wie `COOKIE_SECURE`). Im Vite-Dev-Server entfällt die CSP.
- **CSRF:** Schreibende Anfragen (POST-Server-Funktionen, Upload) brauchen `Sec-Fetch-Site: same-origin` bzw. bei
  älteren Browsern einen Origin/Referer der App (`APP_URL` oder die Adresse der Anfrage), sonst antwortet die App
  mit 403.
- **Aufräumen:** Der Worker löscht beim Start und dann stündlich abgelaufene Sitzungen, Anmeldelinks,
  Rate-Limit-Zähler und alte Audit-Einträge, dazu die Daten mit Löschfrist (siehe Datenschutz). Die Löschungen sind idempotent, mehrere Worker stören sich nicht.

## Status eines Auftrags

```
Eingereicht → Bestätigt → Fertig
     ↕ Rückfrage
Abgelehnt / Storniert
```

- **Eingereicht**: Der Kunde hat den Auftrag abgeschickt. Er ist ein Angebot des Kunden, noch kein Vertrag.
- **Bestätigt**: Ein Mitarbeiter hat den Auftrag angenommen (mit Name und Zeitpunkt am Auftrag). Erst jetzt ist er
  verbindlich. Solange ein Auftrag bestätigt ist, führen Mitarbeiter einen internen Unterstatus („In Bearbeitung“,
  „Problem“), den Kunden nie sehen und der keine Mails auslöst.
- **Rückfrage**: Die Druckerei braucht eine Antwort; der Kunde beantwortet sie und der Auftrag geht zurück auf
  „Eingereicht“.
- Kunden können stornieren, bis der Auftrag bestätigt ist.

Die Übersicht zeigt Mitarbeitern standardmäßig die Warteschlange aller offenen Aufträge, daneben die fertigen.
Die erlaubten Übergänge je Rolle stehen in `src/lib/status.ts`.

Unter „Als Board“ (`/auftraege/board`) sehen Mitarbeiter die offenen Aufträge in Spalten nach Status, dazu die in den
letzten 14 Tagen fertig gewordenen. Karten lassen sich in eine erlaubte Spalte ziehen oder per Tastatur über das Menü
„Status …“ an der Karte verschieben. Eine Rückfrage fragt dabei nach dem Text an den Kunden. Ablehnen und Stornieren
gehen weiter über die Detailseite. Hat jemand den Auftrag inzwischen geändert, lädt das Board neu und meldet das.

## Übersicht

Nach dem Anmelden landet man auf der Übersicht (`/uebersicht`). Mitarbeiter sehen dort die offenen Aufträge je Status
samt internem Unterstatus, was ihnen zugewiesen ist, was niemandem zugewiesen ist, was seit gestern eingegangen ist und
welche Änderungsvorschläge beim Kunden liegen. Dazu kommen die Durchlaufzeit von „Eingereicht“ bis „Fertig“ (Median
und Durchschnitt der letzten 90 Tage), eingegangene und fertige Aufträge mit Umsatz je Monat über zwölf Monate und die
häufigsten Formate, Bindungen und Papiere. Kunden sehen ihre offenen Aufträge und was auf ihre Antwort wartet.
Alle Zahlen werden beim Aufruf aus den Aufträgen und ihrer Historie berechnet (`src/server/requests/dashboard.server.ts`).

## Katalog und Preise

Admins pflegen unter „Katalog und Preise“ alles, was Kunden im Bestellformular wählen können:

- **Formate und Bindungen**: welche Bindung zu welchem Endformat erlaubt ist (Matrix aus dem Lastenheft),
  ob ein Format doppelseitig gedruckt werden kann, Hilfetexte.
- **Bindungspreise**: Preis pro Exemplar oder pro Blatt (Laminieren), einmalige Kosten pro Auftrag (Leimbindung),
  ob ein Deckblatt, eine Coverfarbe oder ein Zuschnitt dazugehört.
- **Papiere**: Grammatur, Preis pro A3- bzw. SRA3-Bogen oder pro Plot (A0 bis A2), wofür das Papier taugt.
- **Coverfarben**: die Farben selbst und welche Farbe es auf welchem Deckblattpapier gibt (z. B. 250 g/m² nur
  Weiß, 160 g/m² auch Blau, Rot und Durchsichtig). Wählt ein Kunde ein separates Deckblatt, zeigt der Wizard nur
  diese Farben und verwirft eine nicht mehr passende Farbe; der Server prüft dasselbe beim Absenden. Ohne separates
  Deckblatt gelten alle Farben, die die Bindung erlaubt. Die Migration `0014_cover_colors_per_paper.sql` gibt jedem
  bestehenden Deckblattpapier zunächst alle Farben, damit sich für Kunden nichts ändert.
- **Vorrätige Bogengrößen** je Papier (z. B. A3, SRA3 oder eigene Maße). Am Auftrag wählen Mitarbeiter unter
  „Druckbogen“, auf welcher davon gedruckt wird, getrennt für Innenteil und Deckblatt. Das ist rein intern: Preis
  und Status bleiben, der Kunde sieht nichts und bekommt keine Mail. Ohne Auswahl gilt der Bogen aus der
  Preisberechnung. Die Migration `0017_print_sheets.sql` übernimmt für bestehende Papiere die Bögen, für die ein
  Preis hinterlegt ist, und für Plotterpapier das größte Format.
- **Preise und Texte** (Druck pro Image, Mindestpreis, Hauspost, allgemeine Hilfetexte).

Jede Änderung landet mit altem und neuem Stand in `catalog_changes` und ist unter „Änderungen“ sichtbar.
Die Startwerte kommen aus der Migration `0005_catalog.sql`. Die Druckpreise pro Image und der Mindestpreis sind
dort nur Platzhalter und müssen vor dem Start gesetzt werden. Ebenso ist der Text der Auftragsbedingungen
(„Preise und Texte“) nur ein Platzhalter.

## Neuer Auftrag

Jeder Auftrag bekommt beim Absenden eine achtstellige Nummer im Format `JJMMxxxx`, z. B. `#26100001` für den ersten
Auftrag im Oktober 2026. Der Zähler beginnt jeden Monat (deutsche Zeit) wieder bei 0001; die Datenbank vergibt die
Nummer über `next_request_number()`, sodass auch gleichzeitige Aufträge keine Nummer doppelt bekommen. Aufträge von
vor der Umstellung behalten ihre alte Nummer.

Kunden und Mitarbeiter legen Aufträge in sieben Schritten an: Datei, Format, Bindung, Papier (mit optionalem
Deckblatt und Coverfarbe), Optionen, Lieferung und Absenden. Jeder Schritt zeigt nur, was zum bisher Gewählten
passt; nicht wählbare Optionen sind ausgegraut und nennen den Grund. Rechts steht laufend der Preis.

Die Datei kommt zuerst, weil das Drucktool aus dem PDF Seitenzahl und Seitenformat liest und daraus das Format
vorschlägt. Das Lastenheft sieht den Upload erst nach den Optionen vor.

**Preisberechnung** (`src/lib/pricing.ts`): Die Seiten werden auf den kleinsten passenden Druckbogen ausgeschossen
(A4, A3 oder SRA3). Klicks = Bögen × Seiten, A4-Bögen zum A4-Preis, A3 und SRA3 zum A3-Preis. Papier zählt pro A3-
bzw. SRA3-Bogen (zwei A4-Bögen = ein A3-Bogen). Randlos druckt auf SRA3 mit 3 mm Beschnitt. Plots kosten einen festen
Preis pro Seite. Dazu kommen Bindung (pro Exemplar oder pro Blatt), einmalige Kosten, Deckblatt (immer ein beidseitig
bedrucktes Blatt pro Exemplar, egal wie viele Seiten die Deckblatt-Datei hat; ohne eigene Datei aus der Druckdatei
die ersten zwei Seiten, bei vorne und hinten zusätzlich die letzten zwei als zweites Blatt), dann der Mindestpreis
und die Lieferung. Kunden sehen nur Druck- und Lieferkosten.

Beim Absenden rechnet der Server neu. Weicht der Preis von der Vorschau ab, weil sich der Katalog geändert hat,
wird der Auftrag nicht angelegt und der Kunde sieht den neuen Preis. Angelegte Aufträge speichern Auswahl, Preis und
die verwendeten Katalogwerte (`requests.order`); spätere Preisänderungen ändern daran nichts. Die Zustimmung zu den
Auftragsbedingungen wird mit Zeitpunkt und Fassung (Hash des Textes) gespeichert.

**Dateien** liegen unter `UPLOAD_DIR` (Standard `data/uploads`), in der Datenbank stehen Name, Größe, SHA-256 und
das Ergebnis der PDF-Prüfung. Auch verschlüsselte oder nicht lesbare PDFs werden angenommen; die Druckerei sieht
dann einen Hinweis. Hochgeladene Dateien, die nach 24 Stunden zu keinem Auftrag gehören, werden gelöscht.
Herunterladen dürfen Mitarbeiter und der Kunde, dem der Auftrag gehört.

An Nachrichten lassen sich bis zu zehn Dateien anhängen (z. B. korrigierte Druckdaten, Logos, Fotos). Sie liegen in
derselben Ablage. Anhänge interner Notizen sehen nur Mitarbeiter.

## Änderungen durch die Druckerei

Mitarbeiter können Optionen und Preis eines Auftrags nicht direkt ändern, sondern schlagen über „Änderung
vorschlagen“ einen neuen Stand vor, optional mit manuell gesetztem Preis und immer mit Begründung. Der Auftrag geht
auf „Rückfrage“, der Kunde bekommt eine E-Mail und sieht Vorher und Nachher. Erst wenn er zustimmt, gilt der neue
Stand samt Preis, und der Auftrag kehrt in seinen vorherigen Status zurück. Lehnt er ab, bleibt alles, wie es war.
Solange ein Vorschlag offen ist, kann der Auftrag nur storniert oder abgelehnt werden. Alle Schritte stehen im Verlauf.

## Schutz vor gleichzeitigen Änderungen

Jede Anfrage hat eine `version`. Änderungen (Status, Bearbeiten, Zuweisung) schicken die Version mit, die der
Nutzer gesehen hat, und werden nur geschrieben, wenn sie noch aktuell ist (`UPDATE … WHERE version = ?`).
Hat jemand anderes die Anfrage inzwischen geändert, bekommt der Nutzer einen Hinweis und kann neu laden.
Kommentare hängen nur an und brauchen deshalb keine Versionsprüfung.

## E-Mail-Benachrichtigungen

Das Tool verschickt E-Mails bei neuen Anfragen, Statuswechseln, Nachrichten, Zuweisungen und Registrierungen:

| Ereignis                     | Empfänger                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Kunde reicht Auftrag ein     | Alle Mitarbeiter, dazu eine Eingangsbestätigung an den Kunden                           |
| Statuswechsel / Nachricht    | Alle Beobachter des Auftrags; bei Aktionen des Kunden ohne Zuständigen alle Mitarbeiter |
| Interne Notiz                | Nur beobachtende Mitarbeiter, nie Kunden                                                |
| Erwähnung mit `@Name`        | Der erwähnte Mitarbeiter (eigene Mail statt der allgemeinen)                            |
| Zuweisung                    | Der neu zuständige Mitarbeiter                                                          |
| Anmeldelink                  | Die angegebene Adresse (immer, unabhängig von der Einstellung)                          |
| Neue Registrierung über OIDC | Alle Superadmins (nur bei `OIDC_NEW_USERS=pending`)                                     |
| Freigabe / Ablehnung         | Die registrierte Person (immer, unabhängig von der Einstellung)                         |

Wer eine Änderung selbst auslöst, bekommt keine Mail. Im Profil lassen sich Benachrichtigungen abschalten.

Ersteller und Zuständiger beobachten einen Auftrag automatisch. Auf der Detailseite lässt sich das Beobachten pro
Auftrag an- und abschalten; Mitarbeiter können so auch fremde Aufträge verfolgen und sehen, wer sonst beobachtet.
Mitarbeiter erwähnen sich in Nachrichten und internen Notizen mit `@Name` (Auswahl unter dem Eingabefeld); Erwähnte
beobachten den Auftrag danach. Kunden können niemanden erwähnen. Die Ansicht „Für mich“ in der Auftragsliste zeigt alle
beobachteten Aufträge.

Aufträge mit neuer Aktivität anderer seit dem letzten Öffnen (Nachrichten, Statuswechsel) sind in der Liste fett mit
blauem Punkt markiert, die Ansicht „Ungelesen“ zeigt nur diese. Im Auftrag sind neue Nachrichten und Verlaufseinträge
hervorgehoben. Interne Einträge zählen für Kunden nicht, eigene Aktionen nie. Alles vor der Einführung gilt als gelesen.

Die Mails werden in derselben Transaktion wie die Änderung in die Tabelle `email_outbox` geschrieben und von einem
eigenen Worker-Prozess verschickt (`pnpm mail:worker`, im Container `worker`). Scheitert der Versand, versucht der
Worker es mit wachsendem Abstand bis zu acht Mal erneut. Ohne `SMTP_URL` werden Mails nur ins Log geschrieben. Derselbe
Worker räumt stündlich abgelaufene Daten auf (siehe Sicherheit).

### Vorlagen anpassen

Unter **E-Mails** (nur Admins) lassen sich Betreff und Text jeder Benachrichtigung ändern. Eine Vorlage besteht aus
Bausteinen (Absatz, Hervorhebung, Button) mit Platzhaltern wie `{{auftrag}}` oder `{{link}}`; welche es gibt, steht
neben dem Editor. Bausteine, deren Platzhalter leer sind, entfallen beim Versand (z. B. die Notiz beim Statuswechsel).
Wer mehr Freiheit braucht, schaltet auf eigenes HTML um. Platzhalterwerte werden immer maskiert, Buttons akzeptieren
nur `http(s)`- und `mailto`-Links. Die Vorschau zeigt die Mail mit Beispielwerten, „Testmail an mich“ legt sie in den
Postausgang. Unbekannte Platzhalter werden nicht gespeichert. Ohne Anpassung gelten die Standardtexte aus
`src/lib/mail-templates.ts`; „Auf Standard zurücksetzen“ löscht die Anpassung wieder.

Absendername, Antwortadresse, Kopfzeile, Signatur und Fußzeile gelten für alle Mails. Die Absenderadresse selbst kommt
weiter aus `MAIL_FROM`. Alle Änderungen landen im Protokoll.

## Anmeldung über OpenID Connect

Neben E-Mail und Passwort kann sich jeder über einen OpenID-Connect-Anbieter anmelden (Keycloak, Microsoft Entra ID,
Google Workspace, Authentik, …). Beim Anbieter einen Client anlegen, als Redirect-URI
`<APP_URL>/api/auth/oidc/callback` eintragen und `OIDC_ISSUER`, `OIDC_CLIENT_ID` und `OIDC_CLIENT_SECRET` setzen.
Die Login-Seite zeigt dann „Anmelden mit …“ (`OIDC_DISPLAY_NAME`).

Zuordnung bei der Anmeldung:

1. Ist das Konto beim Anbieter schon mit einem Benutzer verknüpft, wird dieser angemeldet.
2. Sonst wird ein bestehender Benutzer mit derselben E-Mail-Adresse verknüpft, sofern der Anbieter die Adresse als
   bestätigt meldet (`email_verified`). Anbieter ohne diesen Claim (z. B. Entra ID) brauchen `OIDC_TRUST_EMAIL=true`.
3. Unbekannte Benutzer behandelt `OIDC_NEW_USERS`: `pending` (Standard) legt eine Registrierung an, die ein Superadmin
   unter „Freigaben“ einer Organisation zuordnet; `staff` legt direkt einen Mitarbeiter an (für einen internen
   Anbieter); `reject` weist sie ab.

Gesperrte oder abgelehnte Konten kommen auch über OIDC nicht herein.

**Rollen vom Anbieter (z. B. Entra-App-Rollen):** Sind `OIDC_ADMIN_ROLES` und/oder `OIDC_STAFF_ROLES` gesetzt
(kommagetrennte Werte aus dem Claim `OIDC_ROLE_CLAIM`, Standard `roles`), bestimmt der Anbieter bei jeder Anmeldung die
Rolle: Wer eine passende Rolle hat, wird ohne Freigabe als Admin bzw. Mitarbeiter angelegt oder umgestellt. Verliert ein
Mitarbeiter oder Admin die Rolle, wird die Anmeldung abgelehnt und seine Sitzungen werden beendet. Der Superadmin wird
nie verändert und bleibt als lokaler Notfallzugang mit Passwort erhalten. Mit `OIDC_ENFORCE_FOR_STAFF=true` können sich
Mitarbeiter und Admins nur noch über den Anbieter anmelden.

## Datenschutz

- **Anonymisieren statt Löschen:** In der Benutzerverwaltung lässt sich ein Konto anonymisieren. Name wird zu
  „Gelöschter Nutzer“, E-Mail-Adresse, Passwort, Rechnungs- und Lieferadresse, Organisationen und -anfragen, Sitzungen,
  OIDC-Verknüpfungen, offene Anmeldelinks, Mails in der Outbox und nicht abgeschickte Uploads werden entfernt, Namen
  und Adresse auch aus dem Audit-Log. Das Konto ist danach gesperrt, die E-Mail-Adresse wieder frei. Aufträge,
  Nachrichten und Dateien an Aufträgen bleiben wegen der Aufbewahrungspflichten erhalten, ebenso die beim Absenden am
  Auftrag gespeicherte Rechnungs- und Lieferadresse. Admins können keine Administratoren anonymisieren, niemand sein
  eigenes Konto.
- **Datenauskunft (Art. 15):** „Datenauskunft herunterladen“ in der Benutzerverwaltung liefert alle zu einer Person
  gespeicherten Daten als JSON (Konto, Sitzungen, Anmeldewege, Aufträge, Nachrichten, Dateien, Audit-Log, E-Mails).
  Jeder Abruf wird protokolliert.
- **Löschfristen:** IP-Adressen an Sitzungen nach `SESSION_IP_RETENTION_DAYS` (Standard 30 Tage), abgelehnte
  Registrierungen samt nie freigegebener Organisation nach `REJECTED_REGISTRATION_RETENTION_DAYS` (Standard 30 Tage),
  Audit-Log nach `AUDIT_LOG_RETENTION_DAYS` (Standard 365 Tage). Abgelaufene Sitzungen und Anmeldelinks verschwinden
  stündlich.
- **Datenschutzerklärung und Impressum:** `PRIVACY_URL` und `IMPRINT_URL` erscheinen als Links in der Fußzeile und
  auf der Anmeldeseite.

## Lokale Entwicklung

Voraussetzungen: Node.js 22, pnpm, PostgreSQL 16 (oder `docker compose up db`).

```sh
cp .env.example .env
pnpm install
pnpm db:migrate   # Schema anlegen
pnpm db:seed      # ersten Superadmin aus SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD anlegen
                  # mit SEED_EXAMPLE_CATALOG=true auch Beispiel-Coverfarben je Papier (250 g/m² nur Weiß)
pnpm dev          # http://localhost:3000
pnpm mail:worker  # optional, in einem zweiten Terminal: verschickt E-Mails
```

Weitere Befehle:

```sh
pnpm typecheck
pnpm lint                                             # oxlint mit Typinformationen
pnpm format                                           # Prettier; pnpm format:check nur prüfen
pnpm test                                             # Unit-Tests
TEST_DATABASE_URL=postgres://…/drucktool_test pnpm test  # inkl. Integrationstests (Datenbank wird geleert!)
pnpm db:generate --name <name>                        # Migration aus Schemaänderung erzeugen
pnpm build && pnpm start
```

## Docker

```sh
SUPERADMIN_EMAIL=admin@example.com SUPERADMIN_PASSWORD='mindestens-12-zeichen' docker compose up --build
```

Der Container spielt beim Start die Migrationen ein und legt den Superadmin an, falls noch keiner existiert
(`RUN_MIGRATIONS=false` schaltet das ab). Healthcheck: `GET /api/health`. Der Dienst `worker` nutzt dasselbe Image
und verschickt die E-Mails. Druckdateien liegen im Volume `uploads`.

## Logs und Überwachung

- **Logs:** Die App schreibt in Produktion eine JSON-Zeile pro Eintrag (`LOG_FORMAT=text` für lesbaren Text, lokal
  der Standard), mit Zeit, Level, Request-ID, Nutzer-ID sowie Methode, Pfad, Status und Dauer jeder Anfrage.
  Passwörter, Tokens, Cookies und Abfrageparameter werden nie geschrieben. Jede Antwort trägt die Request-ID im
  Header `x-request-id`. Auf dem Server: `docker compose -f /opt/drucktool/docker-compose.yml logs -f app`, z. B.
  gefiltert mit `| grep <request-id>`. Die Compose-Dateien begrenzen die Logs je Container (Ansible:
  `drucktool_log_max_size` × `drucktool_log_max_files`, Standard 5 × 10 MB).
- **Unerwartete Fehler** (Datenbank, Programmierfehler) landen mit Stacktrace und Request-ID im Log. Der Nutzer sieht
  nur „Es ist ein unerwarteter Fehler aufgetreten … (Fehlernummer <request-id>)“, über die sich der Logeintrag finden
  lässt. Fachliche Meldungen („Passwort ist falsch“) bleiben unverändert.
- **Fehler-Tracking (optional):** Mit `SENTRY_DSN` (Ansible: `drucktool_sentry_dsn`) geht jeder Fehler-Logeintrag
  zusätzlich an Sentry oder ein selbst gehostetes GlitchTip, mit Version, Umgebung, Request-ID und Nutzer-ID.
- **Uptime und TLS-Zertifikat:** Ein externer Dienst sollte `https://<domain>/api/health` überwachen (erwartet HTTP 200
  mit `"status":"ok"`). Am einfachsten über [healthchecks.io](https://healthchecks.io) (kostenlos) oder ein eigenes
  Uptime Kuma: Check anlegen (Periode 5 Minuten, Grace 10 Minuten) und die Ping-URL als `drucktool_monitor_ping_url`
  eintragen. Der Server ruft dann alle 5 Minuten seine öffentliche Adresse auf, prüft, dass das TLS-Zertifikat noch
  mindestens 14 Tage gilt, und meldet sich. Fällt der Server aus, bleibt die Meldung aus und der Dienst schlägt Alarm;
  bei einem Fehler kommt die Meldung mit Grund (`<url>/fail`). Von Hand: `sudo drucktool-monitor`.

## CI

`.github/workflows/ci.yml` läuft bei jedem Pull Request und jedem Push auf `main`:

- **Lint und Formatierung**: `pnpm lint` und `pnpm format:check`. Fehler lassen die CI scheitern, Warnungen nicht.
  Gelintet wird mit [oxlint](https://oxc.rs) statt ESLint, weil typescript-eslint TypeScript 7 noch nicht unterstützt;
  oxlint prüft über `oxlint-tsgolint` auch typbasierte Regeln wie vergessene `await` (`no-floating-promises`). Die
  Regeln stehen in `.oxlintrc.json`, der Stil in `.prettierrc.json`. Der einmalige Formatierungs-Commit steht in
  `.git-blame-ignore-revs` (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).
- **Typecheck, Tests, Migrationen**: `pnpm typecheck`, `pnpm test:coverage` (mit Datenbank, Abdeckung im Log),
  `pnpm build`. Danach prüft
  `drizzle-kit`, dass `src/server/db/schema.ts` keine Änderungen ohne Migration enthält, und die neuen Migrationen
  werden auf eine Datenbank mit dem Schema des vorherigen Stands (Basis des PRs) eingespielt.
- **E2E und Barrierefreiheit**: startet den gebauten Server und spielt in `e2e/` die Kernabläufe auf 375 px Breite
  durch (Auftrag anlegen, Nachricht schreiben, Änderung vorschlagen und annehmen). Jede Seite wird mit axe nach
  WCAG 2.1 AA geprüft, schwere Befunde und waagerechtes Scrollen lassen den Test scheitern. Lokal: `pnpm build`,
  Datenbank migrieren und Superadmin anlegen, dann `pnpm test:e2e` (Port 3100, änderbar mit `E2E_PORT`; mit
  `E2E_BASE_URL` gegen einen laufenden Server).
- **Ansible prüfen**: `ansible-lint` und `ansible-playbook --syntax-check`.
- **Docker-Smoke-Test**: baut das Image, startet es mit `docker compose`, wartet auf `/api/health` und meldet sich in
  einem echten Browser (Playwright) mit dem Superadmin an. Lokal: `docker compose build && scripts/smoke/smoke-test.sh`
  (nutzt Port 3200, änderbar mit `SMOKE_PORT`).
- **Docker-Image veröffentlichen** (nur bei Push auf `main` oder Tag `v*`, und nur wenn alle Prüfungen grün sind):
  scannt das Image mit Trivy (bricht bei behebbaren kritischen Lücken ab) und veröffentlicht es mit SBOM und
  Provenance-Nachweis. Tags: `latest` (main), `sha-<commit>`, bei Releases `v1.2.0` und `1.2.0`.

Dependabot (`.github/dependabot.yml`) schlägt montags gruppierte Updates für npm-Pakete, GitHub Actions und
Docker-Images vor. Patch-Updates können automatisch gemergt werden, wenn die CI grün ist: dazu die Repository-Variable
`DEPENDABOT_AUTOMERGE=true` setzen, „Allow auto-merge“ aktivieren und `main` mit Pflicht-Checks schützen.

## Ausrollen mit Ansible

Die CI veröffentlicht bei jedem Push auf `main` und bei jedem Tag `v*` ein Image nach `ghcr.io/linus1423/drucktool`
(siehe [CI](#ci)). Das Playbook installiert Docker auf einem Debian/Ubuntu-Server, schreibt Compose-Datei und Umgebung
nach `/opt/drucktool`, startet die Anwendung, richtet optional HTTPS über Caddy ein und legt Backups an.

```sh
cd ansible
ansible-galaxy collection install -r requirements.yml
cp inventory.example.yml inventory.yml                       # Server je Umgebung eintragen
cp group_vars/vault.example.yml vault/production.yml         # Passwörter setzen, je Umgebung eigene
cp group_vars/vault.example.yml vault/staging.yml
ansible-vault encrypt vault/production.yml vault/staging.yml
# group_vars/production.yml und staging.yml: Domain und (Produktion) Version eintragen
ansible-playbook playbook.yml --ask-vault-pass               # beide Umgebungen
ansible-playbook playbook.yml --ask-vault-pass -l staging    # nur das Testsystem
```

Ist das Paket in der GitHub Container Registry privat, `drucktool_registry_username` und
`drucktool_registry_password` (Token mit `read:packages`) im Vault setzen. Bestehende Installationen mit
`group_vars/vault.yml` laufen weiter, der Vault wird als Rückfall gelesen.

### Produktion und Testsystem

Die Gruppe im Inventory bestimmt die Umgebung:

- **Produktion** (`production`, z. B. `druck.fsmb.de`) läuft nur mit einer festen Version. Ohne
  `drucktool_image_tag` (oder mit `latest`) bricht das Playbook ab.
- **Testsystem** (`staging`) holt alle 30 Minuten das neueste Image von `main` und aktualisiert sich, vorher wird die
  Datenbank gesichert. Oben auf jeder Seite steht das Banner „Testsystem“. Alle Mails gehen an
  `drucktool_mail_redirect_to` statt an die echten Empfänger, der eigentliche Empfänger steht im Betreff. Ist SMTP
  eingerichtet, ist diese Adresse Pflicht.

Testdaten aus der Produktion: auf dem Produktionsserver `drucktool-backup` ausführen, die Datei aus
`/var/backups/drucktool` auf das Testsystem kopieren und dort `drucktool-restore <datei> --anonymisieren` aufrufen.
Das löscht Sitzungen, Anmeldelinks, Outbox und Protokoll, ersetzt Namen, Adressen und Nachrichten und entfernt alle
Passwörter außer denen der Superadmins.

### Versionen und Rollback

Ein Release entsteht mit einem Git-Tag:

```sh
git tag v1.2.0 && git push origin v1.2.0
```

Die CI baut daraufhin das Image `v1.2.0`, der Workflow `release.yml` legt ein GitHub-Release mit Changelog aus den
gemergten Pull Requests an. Danach `drucktool_image_tag: v1.2.0` in `group_vars/production.yml` eintragen, committen
und das Playbook für `production` laufen lassen. Welche Version läuft, zeigt `/api/health` (`version`, `commit`,
`environment`) und für Admins die Fußzeile.

Vor jedem Update, bei dem sich das Image ändert, legt das Playbook ein Backup `drucktool-…-vor-update.sql.gz` an,
denn die Anwendung spielt beim Start Migrationen ein, die sich nicht zurückdrehen lassen. **Rollback:**

```sh
ansible-playbook playbook.yml --ask-vault-pass -l production -e drucktool_image_tag=v1.1.0
# auf dem Server, nur wenn das neue Release Migrationen enthielt:
drucktool-restore --liste
drucktool-restore /var/backups/drucktool/drucktool-<zeitpunkt>-vor-update.sql.gz
```

Danach die Version in `group_vars/production.yml` zurücksetzen. Alles, was seit dem Update eingegeben wurde, ist mit
dem Restore verloren; ohne neue Migrationen reicht das ältere Image allein.

### Backup und Wiederherstellung

Jede Nacht um 2:15 Uhr sichert `drucktool-backup` die Datenbank nach `/var/backups/drucktool` (14 Tage) und spiegelt
die Druckdateien nach `/var/backups/drucktool/uploads`. Optional, und für die Produktion dringend empfohlen:

- **Kopie außer Haus:** `drucktool_offsite_backup_enabled: true`, `drucktool_restic_repository` (z. B. S3 oder eine
  Hetzner Storage Box per SFTP) und im Vault `drucktool_restic_password` sowie ggf. `drucktool_restic_env` mit den
  Zugangsdaten. Datenbank und Druckdateien landen dann verschlüsselt mit restic beim Ziel (14 tägliche, 8 wöchentliche,
  12 monatliche Stände). Das restic-Passwort zusätzlich außerhalb des Servers aufbewahren, ohne es sind die Backups
  wertlos.
- **Alarm bei Fehlern:** `drucktool_backup_healthcheck_url`, z. B. ein Check bei https://healthchecks.io. Bleibt der
  tägliche Ping aus oder meldet das Skript einen Fehler, schlägt der Dienst Alarm.
- **Restore-Test:** Am Ersten jedes Monats spielt `drucktool-restore --test` das neueste Backup (außer Haus, falls
  eingerichtet) in eine Wegwerf-Datenbank ein und prüft, ob Benutzer und Migrationen da sind. Ergebnis im Log
  `/var/log/drucktool-backup.log`, optional Ping an `drucktool_restore_test_healthcheck_url`.

**Wiederherstellung auf einem frischen Server** (etwa 15 bis 30 Minuten):

1. Server ins Inventory eintragen und das Playbook laufen lassen. Es startet eine leere Anwendung und richtet die
   Skripte ein.
2. Backup einspielen, Datenbank und Druckdateien:
   - mit Kopie außer Haus: `drucktool-restore --offsite --mit-dateien`
   - sonst die Datei und den Ordner `uploads` vom alten Server oder aus einer anderen Kopie nach `/var/backups/drucktool`
     legen und `drucktool-restore --neuestes --mit-dateien` aufrufen
3. Die Anwendung startet neu und spielt fehlende Migrationen ein. Anmelden und einen Auftrag mit Datei öffnen.

`drucktool-restore` sichert vor dem Einspielen den aktuellen Stand und fragt nach (`--ja` überspringt die Frage).
`drucktool-restore --liste` zeigt alle lokalen Backups und Stände außer Haus, `drucktool-restore --offsite <snapshot>`
holt einen älteren Stand.

## Umgebungsvariablen

| Variable                                                                            | Bedeutung                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                      | PostgreSQL-Verbindung                                                                |
| `APP_URL`                                                                           | Öffentliche URL (für Links in E-Mails)                                               |
| `COOKIE_SECURE`                                                                     | `false` nur ohne HTTPS; Standard in Produktion ist `true`                            |
| `TRUST_PROXY`                                                                       | `true` hinter einem Reverse Proxy, damit Client-IPs erkannt werden                   |
| `LOG_LEVEL`, `LOG_FORMAT`                                                           | `debug`, `info` (Standard), `warn`, `error`; `json` oder `text`                      |
| `SENTRY_DSN`                                                                        | Optional: Fehler an Sentry oder GlitchTip melden                                     |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`                                           | Legt beim ersten Start den Superadmin an                                             |
| `CUSTOMER_EMAIL_DOMAINS`                                                            | Optional: neue Kundenkonten nur für diese Domains, z. B. `tum.de`                    |
| `SMTP_URL`                                                                          | SMTP-Server, z. B. `smtps://user:pass@mail.example.com:465`                          |
| `MAIL_FROM`                                                                         | Absender, z. B. `Druckerei Muster <auftraege@example.com>`                           |
| `MAIL_REDIRECT_TO`                                                                  | Testsystem: alle Mails an diese Adresse, Empfänger steht im Betreff                  |
| `APP_ENVIRONMENT`                                                                   | `production`, `staging` (Banner „Testsystem“) oder `development`                     |
| `UPLOAD_DIR`                                                                        | Ablage für Druckdateien, Standard `data/uploads` (im Image `/app/uploads`)           |
| `UPLOAD_MAX_MB`                                                                     | Größte erlaubte Druckdatei in MB, Standard 500                                       |
| `ATTACHMENT_MAX_MB`, `ATTACHMENT_TYPES`                                             | Anhänge an Nachrichten: Größe in MB (Standard 25), erlaubte Endungen (kommagetrennt) |
| `AUDIT_LOG_RETENTION_DAYS`                                                          | Aufbewahrung des Audit-Logs in Tagen, Standard 365, `0` = unbegrenzt                 |
| `SESSION_IP_RETENTION_DAYS`                                                         | IP-Adressen an Sitzungen nach so vielen Tagen löschen, Standard 30                   |
| `REJECTED_REGISTRATION_RETENTION_DAYS`                                              | Abgelehnte Registrierungen nach so vielen Tagen löschen, Standard 30                 |
| `PRIVACY_URL`, `IMPRINT_URL`                                                        | Links auf Datenschutzerklärung und Impressum in der Fußzeile                         |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                               | OpenID Connect, siehe oben                                                           |
| `OIDC_DISPLAY_NAME`, `OIDC_NEW_USERS`, `OIDC_TRUST_EMAIL`                           | Beschriftung und Verhalten der OIDC-Anmeldung                                        |
| `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`, `OIDC_STAFF_ROLES`, `OIDC_ENFORCE_FOR_STAFF` | Rollen vom Anbieter, siehe oben                                                      |

## Mitwirken und Betrieb

- Fehler melden, Wünsche äußern und Code beitragen: [CONTRIBUTING.md](CONTRIBUTING.md)
- Wartung und Notfall-Ablauf für die FSMB-IT: [docs/BETRIEB.md](docs/BETRIEB.md)
- Offene Punkte stehen als Issues im Repository.
