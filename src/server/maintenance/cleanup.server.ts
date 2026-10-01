// Aufräumjob für abgelaufene Daten und Löschfristen. Läuft im Worker beim Start und dann stündlich.
// Alle Schritte sind einfache DELETEs und damit idempotent: laufen mehrere Worker
// gleichzeitig, löscht einer die Zeilen und der andere findet nichts mehr.
import { and, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { schema, type getDb } from '../db/client.server'

type Db = ReturnType<typeof getDb>
const { sessions, loginTokens, rateLimits, auditLog } = schema

/** Aufbewahrungsdauer des Audit-Logs in Tagen (AUDIT_LOG_RETENTION_DAYS, Standard 365, 0 = unbegrenzt). */
export function auditRetentionDays() {
  const raw = process.env.AUDIT_LOG_RETENTION_DAYS
  const days = raw === undefined || raw === '' ? 365 : Number(raw)
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : 0
}

/** Löscht Audit-Einträge, die älter als die Aufbewahrungsdauer sind. */
export async function purgeAuditLog(db: Db, days = auditRetentionDays()) {
  if (days <= 0) return 0
  const result = await db.delete(auditLog).where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`))
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
  // Audit-Log nach AUDIT_LOG_RETENTION_DAYS (Standard 365 Tage).
  const auditEntries = await purgeAuditLog(db)
  return {
    sessions: expiredSessions.count,
    loginTokens: expiredTokens.count,
    rateLimits: expiredLimits.count,
    auditLog: auditEntries,
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
