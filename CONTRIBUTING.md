# Mitwirken am Drucktool

Danke, dass du helfen willst! Das Drucktool gehört der Fachschaftsdruckerei (FSMB). Mitarbeiterinnen und Mitarbeiter
der Druckerei melden Fehler und Wünsche, die FSMB-IT betreut Code, Server und Notfälle.

## Fehler melden oder etwas vorschlagen (ohne Programmierkenntnisse)

1. Auf GitHub oben auf **Issues** klicken, dann **New issue**.
2. **Fehler melden** oder **Wunsch oder Idee** wählen und die Felder ausfüllen. Es reicht, in eigenen Worten zu
   beschreiben, was passiert ist. Bildschirmfotos helfen sehr (einfach ins Feld ziehen).
3. Keine Passwörter, Kundendaten oder Druckdateien von Kunden anhängen. Issues sind für alle mit Zugriff auf das
   Repository sichtbar.

Steht in einer Fehlermeldung eine **Fehlernummer**, bitte mit angeben. Damit findet die IT den Fehler im Log.

**Dringend?** Wenn das Drucktool gar nicht erreichbar ist oder Daten falsch sind, nicht nur ein Issue anlegen,
sondern die FSMB-IT direkt kontaktieren (siehe [Betriebshandbuch](docs/BETRIEB.md#kontakte)).

## Code beitragen

### Einrichten

Voraussetzungen und erste Schritte stehen im README unter [Lokale Entwicklung](README.md#lokale-entwicklung). Kurz:

```sh
cp .env.example .env
docker compose up -d db
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev
```

### Ablauf

1. Für jede Änderung einen eigenen Branch von `main` anlegen, z. B. `fix/preis-rundung` oder `feature/sammelauftrag`.
2. Kleine, in sich geschlossene Commits mit aussagekräftiger Nachricht auf Deutsch („Preis bei Nachbestellung neu
   berechnen“ statt „fix“).
3. Pull Request gegen `main` öffnen und die Vorlage ausfüllen. Im Text `Closes #123` schreiben, dann wird das Issue
   beim Mergen geschlossen.
4. Die CI muss grün sein, und der Maintainer (siehe `.github/CODEOWNERS`) muss zustimmen. Gemergt wird erst danach.

### Vor dem Pull Request lokal prüfen

```sh
pnpm lint && pnpm format:check && pnpm typecheck
TEST_DATABASE_URL=postgres://drucktool:drucktool@localhost:5432/drucktool_test pnpm test
```

Für Änderungen an Oberflächen zusätzlich die E2E-Tests mit Barrierefreiheitsprüfung (`pnpm build`, dann
`pnpm test:e2e`, Details im README unter [CI](README.md#ci)).

### Worauf geachtet wird

- **Sprache:** Oberfläche, Meldungen, Kommentare und Commits auf Deutsch. Code-Bezeichner auf Englisch.
- **Datenbank:** Schemaänderungen immer mit Migration (`pnpm db:generate --name <name>`). Migrationen nie nachträglich
  ändern, sondern eine neue anlegen.
- **Rechte:** Jede Server-Funktion prüft selbst, wer sie aufrufen darf (`requireUser`, `requireStaff`, `requireAdmin`).
  Kunden dürfen nur eigene Aufträge bzw. die ihrer Organisation sehen.
- **Preise:** Preise werden beim Absenden eingefroren. Preis- und Angebotsänderungen muss der Kunde immer bestätigen.
- **Barrierefreiheit:** Bedienbar per Tastatur, Beschriftungen für alle Felder, ausreichender Kontrast, auch auf dem
  Handy (375 px) ohne waagerechtes Scrollen.
- **Tests:** Neue Logik bekommt Tests in `tests/`, neue Kernabläufe einen Schritt in `e2e/`.
- **Geheimnisse:** Keine Passwörter oder Tokens in Code, Tests oder Logs.

### Wie ein Pull Request geprüft wird

Die CI prüft Lint und Formatierung, Typen, Unit- und Integrationstests mit Datenbank, Migrationen, E2E-Abläufe mit
Barrierefreiheit, das Ansible-Playbook und einen Docker-Start. Der Maintainer prüft danach fachlich: passt die Änderung
zum Lastenheft, ist sie verständlich, und gefährdet sie keine Daten. Rückfragen kommen als Kommentar im Pull Request.

## Releases und Betrieb

Wie Versionen entstehen und ausgerollt werden, steht im README unter
[Versionen und Rollback](README.md#versionen-und-rollback). Der Notfall-Ablauf für die FSMB-IT steht im
[Betriebshandbuch](docs/BETRIEB.md).
