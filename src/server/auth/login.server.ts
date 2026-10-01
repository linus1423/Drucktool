import { sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.server'
import type { User } from '../db/schema'
import { auditLogin } from '../audit/audit.server'
import { getOidcSettings } from './oidc.server'
import { getDummyHash, verifyPassword } from './password.server'
import { accountBlockedMessage, accountBlockedMs, clearLoginFailures, recordLoginFailure } from './rate-limit.server'

export const WRONG_CREDENTIALS = 'E-Mail-Adresse oder Passwort ist falsch'

/**
 * Prüft E-Mail-Adresse und Passwort und liefert den Benutzer, wenn er sich anmelden darf.
 * Fehlversuche werden pro E-Mail-Adresse gezählt (auch für unbekannte Adressen, damit eine
 * Sperre nichts über vorhandene Konten verrät). Eine erfolgreiche Prüfung setzt den Zähler zurück.
 * Jeder Versuch landet im Audit-Log, das Passwort nie.
 */
export async function authenticateWithPassword(email: string, password: string): Promise<User> {
  const db = getDb()
  const fail = async (userId: string | null, reason: string, message: string): Promise<never> => {
    await auditLogin('failed', { userId, method: 'password', email, reason })
    throw new Error(message)
  }

  const blockedMs = await accountBlockedMs(email)
  if (blockedMs > 0) return fail(null, 'blocked', accountBlockedMessage(blockedMs))

  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email}`)
    .limit(1)

  const hash = user?.passwordHash ?? (await getDummyHash())
  const valid = await verifyPassword(hash, password)
  if (!user || !user.passwordHash || !valid) {
    await recordLoginFailure(email)
    return fail(user?.id ?? null, 'wrong_credentials', WRONG_CREDENTIALS)
  }
  await clearLoginFailures(email)

  // Mit OIDC_ENFORCE_FOR_STAFF melden sich Mitarbeiter und Admins nur über den Anbieter an.
  if ((user.role === 'staff' || user.role === 'admin') && getOidcSettings()?.enforceForStaff) {
    return fail(user.id, 'sso_required', 'Mitarbeiter melden sich bitte über das Firmenkonto an.')
  }
  if (user.status === 'pending') {
    return fail(user.id, 'pending', 'Ihr Konto wurde noch nicht freigegeben. Sie erhalten eine Nachricht, sobald es so weit ist.')
  }
  if (user.status !== 'active') {
    return fail(user.id, 'inactive', 'Ihr Konto ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.')
  }
  // Organisationen sind optional (Issue #68): Eine deaktivierte Organisation sperrt nicht das Konto,
  // sie steht beim Bestellen nur nicht mehr zur Auswahl.
  await auditLogin('succeeded', { userId: user.id, method: 'password' })
  return user
}
