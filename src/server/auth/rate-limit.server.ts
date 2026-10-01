import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { getRequestIP } from '@tanstack/react-start/server'
import { getDb, schema } from '../db/client.server'

type Db = ReturnType<typeof getDb>
const { rateLimits } = schema

export const RATE_LIMITED = 'Zu viele Versuche. Bitte warten Sie einen Moment.'

/** Fehlversuche pro Konto, bevor die Anmeldung gesperrt wird, und das Zeitfenster dafür. */
export const ACCOUNT_MAX_FAILURES = 5
export const ACCOUNT_WINDOW_MS = 15 * 60_000
const ACCOUNT_MAX_BLOCK_MS = 60 * 60_000

// Im Schlüssel steht nur ein Hash, damit die Tabelle keine IP- oder E-Mail-Adressen enthält.
function bucketKey(name: string, subject: string) {
  return `${name}:${createHash('sha256').update(subject.toLowerCase()).digest('hex').slice(0, 32)}`
}

const interval = (ms: number) => sql`make_interval(secs => ${ms / 1000})`

/**
 * Zählt einen Versuch im festen Zeitfenster und liefert true, solange das Limit nicht
 * überschritten ist. Das Hochzählen ist ein einzelnes Upsert und damit auch bei
 * mehreren App-Instanzen atomar. Die Zeit kommt immer von der Datenbank.
 */
export async function hitRateLimit(name: string, subject: string, max: number, windowMs: number, db: Db = getDb()) {
  const expired = sql`${rateLimits.windowEndsAt} <= now()`
  const [row] = await db
    .insert(rateLimits)
    .values({ key: bucketKey(name, subject), hits: 1, windowEndsAt: sql`now() + ${interval(windowMs)}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
        windowEndsAt: sql`case when ${expired} then excluded.window_ends_at else ${rateLimits.windowEndsAt} end`,
      },
    })
    .returning({ hits: rateLimits.hits })
  return row!.hits <= max
}

function requestIp() {
  return getRequestIP({ xForwardedFor: process.env.TRUST_PROXY === 'true' }) ?? 'unknown'
}

/** Begrenzt Versuche pro IP, oder pro angegebenem Merkmal (z. B. E-Mail-Adresse oder Benutzer). */
export async function assertRateLimit(name: string, max: number, windowMs: number, subject?: string) {
  if (!(await hitRateLimit(name, subject ?? requestIp(), max, windowMs))) throw new Error(RATE_LIMITED)
}

/** Wartezeit nach n Fehlversuchen: ab dem fünften 1, 2, 4, … Minuten, höchstens eine Stunde. */
export function accountBlockMs(failures: number) {
  if (failures < ACCOUNT_MAX_FAILURES) return 0
  return Math.min(60_000 * 2 ** (failures - ACCOUNT_MAX_FAILURES), ACCOUNT_MAX_BLOCK_MS)
}

/** Verbleibende Sperrzeit eines Kontos in Millisekunden (0 = nicht gesperrt). */
export async function accountBlockedMs(email: string, db: Db = getDb()) {
  const [row] = await db
    .select({ ms: sql<number>`greatest(0, extract(epoch from (${rateLimits.blockedUntil} - now())) * 1000)::float8` })
    .from(rateLimits)
    .where(eq(rateLimits.key, bucketKey('login-account', email)))
  return Math.ceil(row?.ms ?? 0)
}

/**
 * Zählt einen fehlgeschlagenen Passwort-Login für die E-Mail-Adresse, egal von welcher IP.
 * Das Fenster läuft ab dem letzten Fehlversuch bzw. dem Ende der Sperre, damit sich die
 * Wartezeit bei weiteren Fehlversuchen verdoppelt statt zurückzufallen.
 */
export async function recordLoginFailure(email: string, db: Db = getDb()) {
  const key = bucketKey('login-account', email)
  const expired = sql`${rateLimits.windowEndsAt} <= now()`
  const [row] = await db
    .insert(rateLimits)
    .values({ key, hits: 1, windowEndsAt: sql`now() + ${interval(ACCOUNT_WINDOW_MS)}` })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
        windowEndsAt: sql`now() + ${interval(ACCOUNT_WINDOW_MS)}`,
        blockedUntil: sql`case when ${expired} then null else ${rateLimits.blockedUntil} end`,
      },
    })
    .returning({ hits: rateLimits.hits })
  const blockMs = accountBlockMs(row!.hits)
  if (blockMs > 0) {
    await db
      .update(rateLimits)
      .set({
        blockedUntil: sql`now() + ${interval(blockMs)}`,
        windowEndsAt: sql`now() + ${interval(blockMs + ACCOUNT_WINDOW_MS)}`,
      })
      .where(eq(rateLimits.key, key))
  }
  return row!.hits
}

/** Nach einer erfolgreichen Anmeldung beginnt die Zählung von vorn. */
export async function clearLoginFailures(email: string, db: Db = getDb()) {
  await db.delete(rateLimits).where(eq(rateLimits.key, bucketKey('login-account', email)))
}

/** Text für die Login-Seite, solange ein Konto gesperrt ist. */
export function accountBlockedMessage(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  return `Zu viele Fehlversuche für dieses Konto. Bitte versuchen Sie es in ${minutes === 1 ? 'einer Minute' : `${minutes} Minuten`} erneut.`
}
