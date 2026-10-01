# Drucktool

Anfrage- und Auftragsverwaltung für eine Druckerei. Kunden (Organisationen) stellen Anfragen, Mitarbeiter
bearbeiten sie über einen Status-Workflow bis zur Auslieferung.

## Stack

- [TanStack Start](https://tanstack.com/start) mit Router, Query, Form und Table
- PostgreSQL mit [Drizzle ORM](https://orm.drizzle.team)
- Tailwind CSS
- Docker und Ansible für den Betrieb

## Rollen

| Rolle       | Rechte                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| Superadmin  | Alles, gibt Registrierungen frei und verwaltet Administratoren                              |
| Admin       | Organisationen und Benutzer (Mitarbeiter, Kunden) verwalten, Anfragen bearbeiten            |
| Mitarbeiter | Alle Anfragen bearbeiten, Status wechseln, zuweisen, interne Notizen schreiben             |
| Kunde       | Eigene Aufträge anlegen, verfolgen und kommentieren                                        |

## Anmeldung

- **Kunden** melden sich per Anmeldelink an: E-Mail-Adresse eingeben, Link aus der Mail öffnen, fertig. Beim ersten
  Link entsteht das Konto, ohne Freigabe durch die Druckerei. Der Link gilt 15 Minuten und nur einmal; gespeichert wird
  nur ein Hash. Mit `CUSTOMER_EMAIL_DOMAINS` (z. B. `tum.de`) lassen sich neue Konten auf bestimmte Domains
  beschränken. Vor dem ersten Auftrag hinterlegen Kunden im **Profil** ihre Rechnungsadresse, optional eine
  Lieferadresse für die Hauspost. Die Rechnungsadresse wird beim Absenden als Kopie am Auftrag gespeichert.
- **Mitarbeiter und Admins** melden sich über OpenID Connect (z. B. Microsoft Entra ID) oder mit Passwort an, siehe
  unten.
- Organisationen sind optional. Kunden sehen nur die Aufträge, die sie selbst angelegt haben.

Im Profil sieht jeder seine angemeldeten Geräte und kann sie einzeln oder alle anderen abmelden.

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

## Katalog und Preise

Admins pflegen unter „Katalog und Preise“ alles, was Kunden im Bestellformular wählen können:

- **Formate und Bindungen**: welche Bindung zu welchem Endformat erlaubt ist (Matrix aus dem Lastenheft),
  ob ein Format doppelseitig gedruckt werden kann, Hilfetexte.
- **Bindungspreise**: Preis pro Exemplar oder pro Blatt (Laminieren), einmalige Kosten pro Auftrag (Leimbindung),
  ob ein Deckblatt, eine Coverfarbe oder ein Zuschnitt dazugehört.
- **Papiere**: Grammatur, Preis pro A3- bzw. SRA3-Bogen oder pro Plot (A0 bis A2), wofür das Papier taugt.
- **Coverfarben** und **Preise und Texte** (Druck pro Image, Mindestpreis, Hauspost, allgemeine Hilfetexte).

Jede Änderung landet mit altem und neuem Stand in `catalog_changes` und ist unter „Änderungen“ sichtbar.
Die Startwerte kommen aus der Migration `0005_catalog.sql`. Die Druckpreise pro Image und der Mindestpreis sind
dort nur Platzhalter und müssen vor dem Start gesetzt werden. Ebenso ist der Text der Auftragsbedingungen
(„Preise und Texte“) nur ein Platzhalter.

## Neuer Auftrag

Kunden und Mitarbeiter legen Aufträge in sieben Schritten an: Datei, Format, Bindung, Papier (mit optionalem
Deckblatt und Coverfarbe), Optionen, Lieferung und Absenden. Jeder Schritt zeigt nur, was zum bisher Gewählten
passt; nicht wählbare Optionen sind ausgegraut und nennen den Grund. Rechts steht laufend der Preis.

Die Datei kommt zuerst, weil das Drucktool aus dem PDF Seitenzahl und Seitenformat liest und daraus das Format
vorschlägt. Das Lastenheft sieht den Upload erst nach den Optionen vor.

**Preisberechnung** (`src/lib/pricing.ts`): Die Seiten werden auf den kleinsten passenden Druckbogen ausgeschossen
(A4, A3 oder SRA3). Klicks = Bögen × Seiten, A4-Bögen zum A4-Preis, A3 und SRA3 zum A3-Preis. Papier zählt pro A3-
bzw. SRA3-Bogen (zwei A4-Bögen = ein A3-Bogen). Randlos druckt auf SRA3 mit 3 mm Beschnitt. Plots kosten einen festen
Preis pro Seite. Dazu kommen Bindung (pro Exemplar oder pro Blatt), einmalige Kosten, Deckblatt (jede Deckblattseite
ein einseitiger Bogen), dann der Mindestpreis und die Lieferung. Kunden sehen nur Druck- und Lieferkosten.

Beim Absenden rechnet der Server neu. Weicht der Preis von der Vorschau ab, weil sich der Katalog geändert hat,
wird der Auftrag nicht angelegt und der Kunde sieht den neuen Preis. Angelegte Aufträge speichern Auswahl, Preis und
die verwendeten Katalogwerte (`requests.order`); spätere Preisänderungen ändern daran nichts. Die Zustimmung zu den
Auftragsbedingungen wird mit Zeitpunkt und Fassung (Hash des Textes) gespeichert.

**Dateien** liegen unter `UPLOAD_DIR` (Standard `data/uploads`), in der Datenbank stehen Name, Größe, SHA-256 und
das Ergebnis der PDF-Prüfung. Auch verschlüsselte oder nicht lesbare PDFs werden angenommen; die Druckerei sieht
dann einen Hinweis. Hochgeladene Dateien, die nach 24 Stunden zu keinem Auftrag gehören, werden gelöscht.
Herunterladen dürfen Mitarbeiter und der Kunde, dem der Auftrag gehört.

## Schutz vor gleichzeitigen Änderungen

Jede Anfrage hat eine `version`. Änderungen (Status, Bearbeiten, Zuweisung) schicken die Version mit, die der
Nutzer gesehen hat, und werden nur geschrieben, wenn sie noch aktuell ist (`UPDATE … WHERE version = ?`).
Hat jemand anderes die Anfrage inzwischen geändert, bekommt der Nutzer einen Hinweis und kann neu laden.
Kommentare hängen nur an und brauchen deshalb keine Versionsprüfung.

## E-Mail-Benachrichtigungen

Das Tool verschickt E-Mails bei neuen Anfragen, Statuswechseln, Nachrichten, Zuweisungen und Registrierungen:

| Ereignis                         | Empfänger                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- |
| Kunde reicht Auftrag ein         | Alle Mitarbeiter, dazu eine Eingangsbestätigung an den Kunden              |
| Mitarbeiter ändert Status        | Der Kunde, der den Auftrag angelegt hat (nicht bei internen Unterstatus)   |
| Kunde ändert Status / schreibt   | Der zuständige Mitarbeiter, ohne Zuständigen alle Mitarbeiter              |
| Mitarbeiter schreibt Nachricht   | Der Kunde, der den Auftrag angelegt hat                                    |
| Interne Notiz                    | Nur der zuständige Mitarbeiter                                             |
| Zuweisung                        | Der neu zuständige Mitarbeiter                                             |
| Anmeldelink                      | Die angegebene Adresse (immer, unabhängig von der Einstellung)             |
| Neue Registrierung über OIDC     | Alle Superadmins (nur bei `OIDC_NEW_USERS=pending`)                        |
| Freigabe / Ablehnung             | Die registrierte Person (immer, unabhängig von der Einstellung)             |

Wer eine Änderung selbst auslöst, bekommt keine Mail. Im Profil lassen sich Benachrichtigungen abschalten.

Die Mails werden in derselben Transaktion wie die Änderung in die Tabelle `email_outbox` geschrieben und von einem
eigenen Worker-Prozess verschickt (`pnpm mail:worker`, im Container `worker`). Scheitert der Versand, versucht der
Worker es mit wachsendem Abstand bis zu acht Mal erneut. Ohne `SMTP_URL` werden Mails nur ins Log geschrieben.

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

## Lokale Entwicklung

Voraussetzungen: Node.js 22, pnpm, PostgreSQL 16 (oder `docker compose up db`).

```sh
cp .env.example .env
pnpm install
pnpm db:migrate   # Schema anlegen
pnpm db:seed      # ersten Superadmin aus SUPERADMIN_EMAIL/SUPERADMIN_PASSWORD anlegen
pnpm dev          # http://localhost:3000
pnpm mail:worker  # optional, in einem zweiten Terminal: verschickt E-Mails
```

Weitere Befehle:

```sh
pnpm typecheck
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

## Ausrollen mit Ansible

Die CI baut bei jedem Push auf `main` ein Image nach `ghcr.io/linus1423/drucktool`. Das Playbook installiert
Docker auf einem Debian/Ubuntu-Server, schreibt Compose-Datei und Umgebung nach `/opt/drucktool`, startet die
Anwendung, richtet optional HTTPS über Caddy ein und legt ein tägliches Backup an: einen Dump der Datenbank und
einen Spiegel der Druckdateien aus `/opt/drucktool/uploads` nach `/var/backups/drucktool/uploads`.

```sh
cd ansible
ansible-galaxy collection install -r requirements.yml
cp inventory.example.yml inventory.yml               # Server eintragen
cp group_vars/vault.example.yml group_vars/vault.yml # Passwörter setzen
ansible-vault encrypt group_vars/vault.yml
# group_vars/all.yml: drucktool_domain für HTTPS setzen
ansible-playbook playbook.yml --ask-vault-pass
```

Ist das Paket in der GitHub Container Registry privat, `drucktool_registry_username` und
`drucktool_registry_password` (Token mit `read:packages`) im Vault setzen.

## Umgebungsvariablen

| Variable                                  | Bedeutung                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                            | PostgreSQL-Verbindung                                                  |
| `APP_URL`                                 | Öffentliche URL (für Links in E-Mails)                                 |
| `COOKIE_SECURE`                           | `false` nur ohne HTTPS; Standard in Produktion ist `true`              |
| `TRUST_PROXY`                             | `true` hinter einem Reverse Proxy, damit Client-IPs erkannt werden     |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` | Legt beim ersten Start den Superadmin an                               |
| `CUSTOMER_EMAIL_DOMAINS`                  | Optional: neue Kundenkonten nur für diese Domains, z. B. `tum.de`       |
| `SMTP_URL`                                | SMTP-Server, z. B. `smtps://user:pass@mail.example.com:465`            |
| `MAIL_FROM`                               | Absender, z. B. `Druckerei Muster <auftraege@example.com>`             |
| `UPLOAD_DIR`                              | Ablage für Druckdateien, Standard `data/uploads` (im Image `/app/uploads`) |
| `UPLOAD_MAX_MB`                           | Größte erlaubte Druckdatei in MB, Standard 500                         |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | OpenID Connect, siehe oben                                 |
| `OIDC_DISPLAY_NAME`, `OIDC_NEW_USERS`, `OIDC_TRUST_EMAIL` | Beschriftung und Verhalten der OIDC-Anmeldung          |
| `OIDC_ROLE_CLAIM`, `OIDC_ADMIN_ROLES`, `OIDC_STAFF_ROLES`, `OIDC_ENFORCE_FOR_STAFF` | Rollen vom Anbieter, siehe oben |

## Nächste Schritte

- Änderungen durch die Druckerei, denen der Kunde zustimmt (#50)
- Weitere offene Punkte stehen als Issues im Repository.
