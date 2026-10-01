// Aufräumjob für abgelaufene Daten und Löschfristen. Läuft im Worker beim Start und dann stündlich.
// Alle Schritte sind DELETEs bzw. UPDATEs mit festen Bedingungen und damit idempotent: laufen
// mehrere Worker gleichzeitig, erledigt einer die Zeilen und der andere findet nichts mehr.
import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { schema, type getDb, type Tx } from '../db/client.server'

type Db = ReturnType<typeof getDb>
const { sessions, loginTokens, rateLimits, auditLog, users, organisations, organisationMembers } = schema

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
    const deleted = await tx
      .delete(users)
      .where(inArray(users.id, ids))
      .returning({ id: users.id, email: users.email })
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
  // Löschfristen (Audit-Log, IP-Adressen, abgelehnte Registrierungen), siehe oben.
  const auditEntries = await purgeAuditLog(db)
  const sessionIps = await purgeSessionIps(db)
  const rejected = await purgeRejectedRegistrations(db)
  return {
    sessions: expiredSessions.count,
    loginTokens: expiredTokens.count,
    rateLimits: expiredLimits.count,
    auditLog: auditEntries,
    sessionIps,
    rejectedRegistrations: rejected,
  }
}

/** Führt den Aufräumjob aus und schreibt das Ergebnis ins Log. Fehler beenden den Worker nicht. */
export async function runCleanup(db: Db, log: (message: string) => void = console.log) {
  try {
    const result = await purgeExpired(db)
    const removed = Object.entries(result).filter(([, n]) => n > 0)
    if (removed.length) log(`[cleanup] Gelöscht: ${removed.map(([k, n]) => `${k}=${n}`).join(', ')}`)
  } catch (error) {
    console.error('[cleanup] Aufräumen fehlgeschlagen', error)
  }
}
