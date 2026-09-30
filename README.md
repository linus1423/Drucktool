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
| Kunde       | Anfragen der eigenen Organisation anlegen, verfolgen, kommentieren, Angebote annehmen      |

Kunden können sich selbst registrieren. Konto und Organisation bleiben gesperrt, bis ein Superadmin sie unter
**Freigaben** freigibt (oder die Person einer bestehenden Organisation zuordnet).

## Status einer Anfrage

```
Neu → In Prüfung → Angebot → Freigegeben → Im Druck → Versendet → Abgeschlossen
            ↕ Rückfrage     ↺ überarbeiten
Abgelehnt / Storniert (aus den frühen Status heraus)
```

Die erlaubten Übergänge je Rolle stehen in `src/lib/status.ts`.

## Schutz vor gleichzeitigen Änderungen

Jede Anfrage hat eine `version`. Änderungen (Status, Bearbeiten, Zuweisung) schicken die Version mit, die der
Nutzer gesehen hat, und werden nur geschrieben, wenn sie noch aktuell ist (`UPDATE … WHERE version = ?`).
Hat jemand anderes die Anfrage inzwischen geändert, bekommt der Nutzer einen Hinweis und kann neu laden.
Kommentare hängen nur an und brauchen deshalb keine Versionsprüfung.

## E-Mail-Benachrichtigungen

Das Tool verschickt E-Mails bei neuen Anfragen, Statuswechseln, Nachrichten, Zuweisungen und Registrierungen:

| Ereignis                         | Empfänger                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- |
| Kunde stellt Anfrage             | Alle Mitarbeiter                                                           |
| Mitarbeiter ändert Status        | Alle Kunden der Organisation                                               |
| Kunde ändert Status / schreibt   | Der zuständige Mitarbeiter, ohne Zuständigen alle Mitarbeiter              |
| Mitarbeiter schreibt Nachricht   | Alle Kunden der Organisation                                               |
| Interne Notiz                    | Nur der zuständige Mitarbeiter                                             |
| Zuweisung                        | Der neu zuständige Mitarbeiter                                             |
| Neue Registrierung               | Alle Superadmins                                                           |
| Freigabe / Ablehnung             | Die registrierte Person (immer, unabhängig von der Einstellung)             |

Wer eine Änderung selbst auslöst, bekommt keine Mail. Unter „Mein Konto“ lassen sich Benachrichtigungen abschalten.

Die Mails werden in derselben Transaktion wie die Änderung in die Tabelle `email_outbox` geschrieben und von einem
eigenen Worker-Prozess verschickt (`pnpm mail:worker`, im Container `worker`). Scheitert der Versand, versucht der
Worker es mit wachsendem Abstand bis zu acht Mal erneut. Ohne `SMTP_URL` werden Mails nur ins Log geschrieben.

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
und verschickt die E-Mails.

## Ausrollen mit Ansible

Die CI baut bei jedem Push auf `main` ein Image nach `ghcr.io/linus1423/drucktool`. Das Playbook installiert
Docker auf einem Debian/Ubuntu-Server, schreibt Compose-Datei und Umgebung nach `/opt/drucktool`, startet die
Anwendung, richtet optional HTTPS über Caddy ein und legt ein tägliches Datenbank-Backup an.

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
| `SMTP_URL`                                | SMTP-Server, z. B. `smtps://user:pass@mail.example.com:465`            |
| `MAIL_FROM`                               | Absender, z. B. `Druckerei Muster <auftraege@example.com>`             |

## Nächste Schritte

- Bestellformular mit konfigurierbaren Optionen (Material, Bindung, …)
- PDF-Upload mit Seitenzahl-Erkennung und Formatvorschlag
- Anmeldung über OpenID Connect
