// Aufräumjob für abgelaufene Daten. Läuft im Worker beim Start und dann stündlich.
// Alle Schritte sind einfache DELETEs und damit idempotent: laufen mehrere Worker
// gleichzeitig, löscht einer die Zeilen und der andere findet nichts mehr.
import { and, isNull, lte, or, sql } from 'drizzle-orm'
import { schema, type getDb } from '../db/client.server'

type Db = ReturnType<typeof getDb>
const { sessions, loginTokens, rateLimits } = schema

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
  return {
    sessions: expiredSessions.count,
    loginTokens: expiredTokens.count,
    rateLimits: expiredLimits.count,
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
