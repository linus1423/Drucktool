import { eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.server'
import type { User } from '../db/schema'
import { getOidcSettings } from './oidc.server'
import { getDummyHash, verifyPassword } from './password.server'
import { accountBlockedMessage, accountBlockedMs, clearLoginFailures, recordLoginFailure } from './rate-limit.server'

export const WRONG_CREDENTIALS = 'E-Mail-Adresse oder Passwort ist falsch'

/**
 * Prüft E-Mail-Adresse und Passwort und liefert den Benutzer, wenn er sich anmelden darf.
 * Fehlversuche werden pro E-Mail-Adresse gezählt (auch für unbekannte Adressen, damit eine
 * Sperre nichts über vorhandene Konten verrät). Eine erfolgreiche Prüfung setzt den Zähler zurück.
 */
export async function authenticateWithPassword(email: string, password: string): Promise<User> {
  const db = getDb()
  const blockedMs = await accountBlockedMs(email)
  if (blockedMs > 0) throw new Error(accountBlockedMessage(blockedMs))

  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email}`)
    .limit(1)

  const hash = user?.passwordHash ?? (await getDummyHash())
  const valid = await verifyPassword(hash, password)
  if (!user || !user.passwordHash || !valid) {
    await recordLoginFailure(email)
    throw new Error(WRONG_CREDENTIALS)
  }
  await clearLoginFailures(email)

  // Mit OIDC_ENFORCE_FOR_STAFF melden sich Mitarbeiter und Admins nur über den Anbieter an.
  if ((user.role === 'staff' || user.role === 'admin') && getOidcSettings()?.enforceForStaff) {
    throw new Error('Mitarbeiter melden sich bitte über das Firmenkonto an.')
  }
  if (user.status === 'pending') {
    throw new Error('Ihr Konto wurde noch nicht freigegeben. Sie erhalten eine Nachricht, sobald es so weit ist.')
  }
  if (user.status !== 'active') {
    throw new Error('Ihr Konto ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.')
  }
  if (user.organisationId) {
    const [org] = await db
      .select({ status: schema.organisations.status })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, user.organisationId))
    if (org && org.status !== 'active') {
      throw new Error('Ihre Organisation ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.')
    }
  }
  return user
}
