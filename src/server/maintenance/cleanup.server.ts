// Aufräumjob für abgelaufene Daten und Löschfristen. Läuft im Worker beim Start und dann stündlich.
// Alle Schritte sind DELETEs bzw. UPDATEs mit festen Bedingungen und damit idempotent: laufen
// mehrere Worker gleichzeitig, erledigt einer die Zeilen und der andere findet nichts mehr.
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { stat } from 'node:fs/promises'
import { schema, type getDb, type Tx } from '../db/client.server'
import { removeStored, uploadDir } from '../files/storage.server'
import { logger } from '../log.server'

type Db = ReturnType<typeof getDb>
const { sessions, loginTokens, rateLimits, auditLog, users, organisations, organisationMembers, requestFiles, requestEvents } =
  schema

/** Frist in Tagen aus einer Umgebungsvariable; 0 oder ungültig = nie löschen. */
function retentionDays(name: string, fallback: number) {
  const raw = process.env[name]
  const days = raw === undefined || raw === '' ? fallback : Number(raw)
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
}

/** Aufbewahrungsdauer des Audit-Logs in Tagen (AUDIT_LOG_RETENTION_DAYS, Standard 365, 0 = unbegrenzt). */
export const auditRetentionDays = () => retentionDays('AUDIT_LOG_RETENTION_DAYS', 365)
/** IP-Adressen an Sitzungen (SESSION_IP_RETENTION_DAYS, Standard 30). */
export const sessionIpRetentionDays = () => retentionDays('SESSION_IP_RETENTION_DAYS', 30)
/** Abgelehnte Registrierungen (REJECTED_REGISTRATION_RETENTION_DAYS, Standard 30). */
export const rejectedRetentionDays = () => retentionDays('REJECTED_REGISTRATION_RETENTION_DAYS', 30)
/** Dateien fertiger, abgelehnter oder stornierter Aufträge (REQUEST_FILE_RETENTION_DAYS, Standard 90, 0 = nie). */
export const requestFileRetentionDays = () => retentionDays('REQUEST_FILE_RETENTION_DAYS', 90)
/**
 * Hochgeladene, nie abgeschickte Dateien (UNSUBMITTED_UPLOAD_RETENTION_DAYS, Standard 1). Mindestens ein Tag, auch bei 0:
 * Das Kontingent für offene Uploads (UPLOAD_PENDING_MAX_MB) wird erst durch dieses Löschen wieder frei.
 */
export const unsubmittedUploadRetentionDays = () => retentionDays('UNSUBMITTED_UPLOAD_RETENTION_DAYS', 1) || 1

/** Status, nach denen die Druckerei die Dateien eines Auftrags nicht mehr braucht. */
export const FINAL_STATUSES = ['completed', 'rejected', 'cancelled'] as const

const olderThan = (days: number) => sql`now() - make_interval(days => ${days})`

/**
 * Entfernt Namen und E-Mail-Adressen gelöschter oder anonymisierter Benutzer aus dem Audit-Log.
 * Die Einträge selbst (wer hat wann was getan) bleiben bis zum Ablauf ihrer Frist erhalten.
 */
export async function scrubAuditLog(db: Db | Tx, userIds: string[], emails: string[]) {
  if (userIds.length) {
    await db
      .update(auditLog)
      .set({
        before: sql`${auditLog.before} - 'name' - 'email'`,
        after: sql`${auditLog.after} - 'name' - 'email'`,
        data: sql`${auditLog.data} - 'email'`,
      })
      .where(and(eq(auditLog.targetType, 'user'), inArray(auditLog.targetId, userIds)))
  }
  if (emails.length) {
    await db
      .update(auditLog)
      .set({ data: sql`${auditLog.data} - 'email'` })
      .where(
        inArray(
          sql`lower(${auditLog.data}->>'email')`,
          emails.map((e) => e.toLowerCase()),
        ),
      )
  }
}

/** Entfernt IP-Adressen aus Sitzungen, die älter als die Frist sind. Die Sitzung selbst bleibt gültig. */
export async function purgeSessionIps(db: Db, days = sessionIpRetentionDays()) {
  if (days <= 0) return 0
  const result = await db
    .update(sessions)
    .set({ ip: null })
    .where(and(isNotNull(sessions.ip), lt(sessions.createdAt, olderThan(days))))
  return result.count
}

/**
 * Löscht abgelehnte Registrierungen nach Ablauf der Frist, samt der dabei angelegten, nie
 * freigegebenen Organisation. Konten mit Aufträgen, Kommentaren oder Dateien bleiben stehen;
 * sie lassen sich in der Benutzerverwaltung anonymisieren.
 */
export async function purgeRejectedRegistrations(db: Db, days = rejectedRetentionDays()) {
  if (days <= 0) return 0
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.status, 'rejected'),
          lt(sql`coalesce(${users.reviewedAt}, ${users.updatedAt})`, olderThan(days)),
          sql`not exists (select 1 from requests r where r.created_by_id = ${users.id})`,
          sql`not exists (select 1 from request_comments c where c.author_id = ${users.id})`,
          sql`not exists (select 1 from request_files f where f.owner_id = ${users.id})`,
        ),
      )
    if (candidates.length === 0) return 0
    const ids = candidates.map((u) => u.id)
    // Die Mitgliedschaften verschwinden mit dem Benutzer, deshalb die Organisationen vorher merken.
    const memberships = await tx
      .select({ organisationId: organisationMembers.organisationId })
      .from(organisationMembers)
      .where(inArray(organisationMembers.userId, ids))
    const deleted = await tx.delete(users).where(inArray(users.id, ids)).returning({ id: users.id, email: users.email })
    const orgIds = [...new Set(memberships.map((m) => m.organisationId))]
    if (orgIds.length) {
      await tx
        .delete(organisations)
        .where(
          and(
            inArray(organisations.id, orgIds),
            sql`${organisations.status} <> 'active'`,
            sql`not exists (select 1 from organisation_members m where m.organisation_id = ${organisations.id})`,
            sql`not exists (select 1 from requests r where r.organisation_id = ${organisations.id})`,
          ),
        )
    }
    await scrubAuditLog(
      tx,
      deleted.map((u) => u.id),
      deleted.map((u) => u.email),
    )
    return deleted.length
  })
}

/** Löscht Audit-Einträge, die älter als die Aufbewahrungsdauer sind. */
export async function purgeAuditLog(db: Db, days = auditRetentionDays()) {
  if (days <= 0) return 0
  const result = await db.delete(auditLog).where(lt(auditLog.createdAt, olderThan(days)))
  return result.count
}

/** Löscht Dateien von der Platte; Fehler werden geloggt, damit eine Datei nicht den ganzen Lauf abbricht. */
async function removeFiles(keys: string[]) {
  // Nacheinander statt alle auf einmal, damit ein großer erster Lauf nicht tausende Dateien gleichzeitig öffnet.
  for (const key of keys) {
    try {
      await removeStored(key)
    } catch (error) {
      logger.error('Datei konnte nicht gelöscht werden', { key, err: error })
    }
  }
}

/** Ohne eingebundene Ablage (z. B. fehlendes Volume am Worker) nichts als gelöscht markieren. */
async function uploadDirAvailable() {
  try {
    return (await stat(uploadDir())).isDirectory()
  } catch {
    return false
  }
}

/**
 * Löscht hochgeladene Dateien, die nach Ablauf der Frist zu keinem Auftrag gehören (abgebrochene Bestellungen,
 * nie verschickte Anhänge). Erst die Zeile, dann die Datei: Ein gleichzeitiges Absenden findet die Zeile dann entweder
 * noch (und behält die Datei) oder gar nicht mehr.
 */
export async function purgeUnsubmittedUploads(db: Db, days = unsubmittedUploadRetentionDays()) {
  // Ohne Ablage blieben die Dateien sonst ohne Zeile auf der Platte liegen.
  if (!(await uploadDirAvailable())) return 0
  const rows = await db
    .delete(requestFiles)
    .where(and(isNull(requestFiles.requestId), lt(requestFiles.createdAt, olderThan(days))))
    .returning({ key: requestFiles.storageKey })
  await removeFiles(rows.map((r) => r.key))
  return rows.length
}

/**
 * Löscht die Dateien (Druckdatei, Deckblatt, Anhänge) von Aufträgen, die seit Ablauf der Frist fertig, abgelehnt oder
 * storniert sind (Issue #172). Auftrag, Preis, Nachrichten und Verlauf bleiben; die Dateizeilen bekommen `purged_at`,
 * damit die Oberfläche statt eines Links „gelöscht“ zeigt, und der Verlauf einen Eintrag.
 *
 * Jede Zeile hat ihre eigene Datei (`storage_key` ist eindeutig): Nachbestellungen arbeiten mit Kopien, das Löschen
 * eines alten Auftrags berührt also keinen anderen. Ausgenommen sind Vorlagen nicht archivierter Skripte, weil die SVK
 * daraus jedes Semester nachbestellt.
 */
export async function purgeRequestFiles(db: Db, days = requestFileRetentionDays()) {
  if (days <= 0) return 0
  if (!(await uploadDirAvailable())) {
    logger.warn('Ablage für Dateien nicht gefunden, Löschfrist für Dateien übersprungen', { uploadDir: uploadDir() })
    return 0
  }
  const keys = await db.transaction(async (tx) => {
    const purged = await tx
      .update(requestFiles)
      .set({ purgedAt: sql`now()` })
      .where(
        and(
          isNull(requestFiles.purgedAt),
          sql`${requestFiles.requestId} in (
            select r.id from requests r
            where r.status in (${sql.join(
              FINAL_STATUSES.map((s) => sql`${s}`),
              sql`, `,
            )})
              and r.status_changed_at < ${olderThan(days)}
              and not exists (select 1 from scripts s where s.template_request_id = r.id and not s.archived)
          )`,
        ),
      )
      .returning({ key: requestFiles.storageKey, requestId: requestFiles.requestId })
    const perRequest = new Map<string, number>()
    for (const row of purged) perRequest.set(row.requestId!, (perRequest.get(row.requestId!) ?? 0) + 1)
    if (perRequest.size) {
      await tx.insert(requestEvents).values(
        [...perRequest].map(([requestId, files]) => ({
          requestId,
          actorId: null,
          type: 'files_purged' as const,
          data: { files, retentionDays: days },
        })),
      )
    }
    return purged.map((r) => r.key)
  })
  // Erst nach dem Commit von der Platte löschen: Scheitert das, bleibt höchstens eine verwaiste Datei liegen,
  // aber kein Auftrag zeigt auf eine fehlende Datei, ohne es zu wissen.
  await removeFiles(keys)
  return keys.length
}

export const CLEANUP_INTERVAL_MS = 60 * 60_000

export type CleanupResult = Record<string, number>

export async function purgeExpired(db: Db): Promise<CleanupResult> {
  const now = sql`now()`
  const expiredSessions = await db.delete(sessions).where(lte(sessions.expiresAt, now))
  // Anmeldelinks gelten 15 Minuten; benutzte und abgelaufene werden nicht mehr gebraucht.
  const expiredTokens = await db.delete(loginTokens).where(lte(loginTokens.expiresAt, now))
  const expiredLimits = await db
    .delete(rateLimits)
    .where(and(lte(rateLimits.windowEndsAt, now), or(isNull(rateLimits.blockedUntil), lte(rateLimits.blockedUntil, now))))
  // Löschfristen (Audit-Log, IP-Adressen, abgelehnte Registrierungen, Dateien), siehe oben.
  const auditEntries = await purgeAuditLog(db)
  const sessionIps = await purgeSessionIps(db)
  const rejected = await purgeRejectedRegistrations(db)
  const unsubmittedUploads = await purgeUnsubmittedUploads(db)
  const requestFileCount = await purgeRequestFiles(db)
  return {
    sessions: expiredSessions.count,
    loginTokens: expiredTokens.count,
    rateLimits: expiredLimits.count,
    auditLog: auditEntries,
    sessionIps,
    rejectedRegistrations: rejected,
    unsubmittedUploads,
    requestFiles: requestFileCount,
  }
}

/** Führt den Aufräumjob aus und schreibt das Ergebnis ins Log. Fehler beenden den Worker nicht. */
export async function runCleanup(db: Db) {
  try {
    const result = await purgeExpired(db)
    const removed = Object.entries(result).filter(([, n]) => n > 0)
    if (removed.length) logger.info('Abgelaufene Daten gelöscht', Object.fromEntries(removed))
  } catch (error) {
    logger.error('Aufräumen fehlgeschlagen', { err: error })
  }
}
