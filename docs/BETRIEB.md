# Betriebshandbuch für die FSMB-IT

Kurzfassung für Wartung und Notfälle. Einrichtung, Versionen, Backup und Wiederherstellung stehen ausführlich im
README unter [Ausrollen mit Ansible](../README.md#ausrollen-mit-ansible).

## Kontakte

Bitte aktuell halten. Bei Änderungen diese Datei per Pull Request anpassen.

| Rolle                              | Wer                                                 | Erreichbar über |
| ---------------------------------- | --------------------------------------------------- | --------------- |
| Maintainer (Code, Pull Requests)   | _Name eintragen_                                    | _E-Mail_        |
| FSMB-IT Notfall (Server, Ausfall)  | _Name eintragen_                                    | _Telefon/Chat_  |
| Ansprechperson Druckerei           | _Name eintragen_                                    | _E-Mail_        |
| Hoster des Servers                 | _Anbieter, Kundennr._                               | _Support-Link_  |
| Vault-Passwort und restic-Passwort | _wo hinterlegt (z. B. Passwortmanager der FSMB-IT)_ |                 |

## Aufbau auf einen Blick

- Ein Debian/Ubuntu-Server je Umgebung (`production`, `staging`), eingerichtet mit Ansible aus `ansible/`.
- Unter `/opt/drucktool`: `docker-compose.yml`, `.env` und `Caddyfile`. Container `app` (Webanwendung), `worker`
  (E-Mails), `db` (PostgreSQL), `caddy` (HTTPS, nur mit Domain).
- Druckdateien im Ordner `uploads` neben der Compose-Datei (eingebunden in `app` und `worker`), Backups unter
  `/var/backups/drucktool`.
- Löschfristen für Druckdateien (Issue #172): Der Worker löscht stündlich Druckdatei, Deckblatt und Anhänge von
  Aufträgen, die seit `drucktool_request_file_retention_days` Tagen (Standard 90, `0` = nie) fertig, abgelehnt oder
  storniert sind, und nie abgeschickte Uploads nach `drucktool_unsubmitted_upload_retention_days` Tagen (Standard 1).
  Der Auftrag samt Preis und Verlauf bleibt, die Oberfläche zeigt „gelöscht“. Vorlagen nicht archivierter Skripte
  bleiben. Gelöschte Dateien lassen sich nur aus einem Backup zurückholen, solange es noch existiert. Ändert sich die
  Frist, auch die Datenschutzerklärung anpassen. Findet der Worker die Ablage nicht, überspringt er das Löschen und
  schreibt eine Warnung ins Log (`docker compose logs worker`).
- Skripte auf dem Server: `drucktool-backup`, `drucktool-restore`, auf dem Testsystem `drucktool-update`.
- Logs: `docker compose logs app worker` in `/opt/drucktool`, Backup-Log in `/var/log/drucktool-backup.log`.

## Regelmäßige Aufgaben

| Wann                | Was                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Bei jedem Release   | Version in `ansible/group_vars/production.yml` setzen, Playbook für `production` laufen lassen |
| Monatlich           | Ergebnis des automatischen Restore-Tests im Backup-Log bzw. beim Überwachungsdienst ansehen    |
| Monatlich           | Dependabot-Pull-Requests prüfen und mergen                                                     |
| Halbjährlich        | Wiederherstellung auf einem frischen Server einmal komplett üben (siehe README)                |
| Bei Personalwechsel | Kontakte oben aktualisieren, Admin-Konten im Drucktool und Zugänge zum Server prüfen           |

## Notfall-Ablauf

### Das Drucktool ist nicht erreichbar

1. `https://<domain>/api/health` aufrufen. Antwortet es, liegt das Problem eher beim Netz oder beim Browser.
2. Per SSH auf den Server, dann in `/opt/drucktool`:
   - `docker compose ps`: laufen `app`, `db`, `clamav` und ggf. `caddy`?
   - `docker compose logs --tail 200 app`: Fehlermeldungen mit Zeitpunkt und Request-ID.
   - `df -h`: ist die Platte voll?
3. Neustart versuchen: `docker compose up -d`. Hilft das nicht, `docker compose restart app`.
4. Kam der Ausfall direkt nach einem Update: Rollback wie im README unter
   [Versionen und Rollback](../README.md#versionen-und-rollback).
5. Die Druckerei informieren, dass Aufträge vorübergehend per E-Mail angenommen werden müssen.

### Ein Update ist schiefgegangen

Vor jedem Update legt das Playbook ein Backup `…-vor-update.sql.gz` an. Altes Image mit
`-e drucktool_image_tag=<alte Version>` ausrollen. Nur wenn das neue Release Migrationen enthielt, zusätzlich dieses
Backup mit `drucktool-restore` einspielen (Eingaben seit dem Update gehen dabei verloren).

### Daten fehlen oder sind falsch

1. Nichts überschreiben. Zuerst `drucktool-backup` ausführen, damit der aktuelle Stand gesichert ist.
2. Im Drucktool unter **Protokoll** (Superadmin) nachsehen, wer was wann geändert hat.
3. Einzelne Daten lassen sich aus einem Backup in einer Wegwerf-Datenbank nachschlagen und von Hand übertragen.
   Ein komplettes Zurückspielen mit `drucktool-restore` nur, wenn der Verlust aller späteren Eingaben vertretbar ist.

### Verdacht auf einen Sicherheitsvorfall

1. Betroffene Konten im Drucktool unter **Benutzer** deaktivieren. Bei Verdacht auf den Server selbst: Server vom
   Netz nehmen, aber nicht löschen (Beweise sichern).
2. Passwörter im Vault (Datenbank, SMTP, OIDC-Secret) wechseln und das Playbook erneut ausrollen.
3. Die Datenschutzbeauftragten informieren. Bei Verletzung personenbezogener Daten gilt die 72-Stunden-Meldefrist nach
   Art. 33 DSGVO.

## Wenn das Repository umzieht

Zieht der Code auf den Git-Server der FSMB um, müssen mit:

- die CI (`.github/workflows/`) auf das System des neuen Servers übertragen werden,
- das Image in eine andere Registry, dann `drucktool_image` in `ansible/group_vars/all.yml` anpassen,
- `.github/CODEOWNERS`, Issue- und PR-Vorlagen in das Format des neuen Servers,
- Links in README, `CONTRIBUTING.md` und dieser Datei.
