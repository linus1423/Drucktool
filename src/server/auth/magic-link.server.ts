// Anmeldung per Einmal-Link (Lastenheft 3.1: Kunden-Login über E-Mail-Verifizierung).
// Ein Konto entsteht beim ersten erfolgreichen Link, eine Freigabe durch die Druckerei gibt es nicht.
import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.server'
import { enqueueMail } from '../mail/outbox.server'
import { appUrl, loginLinkMail } from '../mail/templates'
import { getOidcSettings } from './oidc.server'
import { auditLogin } from '../audit/audit.server'

export const LINK_MINUTES = 15
const { users, loginTokens } = schema

const INVALID = 'Der Anmeldelink ist ungültig, abgelaufen oder wurde schon benutzt. Bitte fordern Sie einen neuen an.'
const INACTIVE = 'Ihr Konto ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.'
const STAFF_SSO = 'Mitarbeiter melden sich bitte über das Firmenkonto an.'

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

/** Erlaubte Domains für neue Kunden, z. B. "tum.de,mytum.de". Leer = alle. */
export function allowedDomains(): string[] {
  return (process.env.CUSTOMER_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

export function isDomainAllowed(email: string, domains = allowedDomains()) {
  if (domains.length === 0) return true
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`))
}

function staffMustUseSso(role: string) {
  return (role === 'staff' || role === 'admin') && !!getOidcSettings()?.enforceForStaff
}

/**
 * Legt einen Link an und stellt die Mail in die Outbox. Gibt nach außen immer dasselbe
 * zurück, damit sich nicht ermitteln lässt, welche Adressen ein Konto haben.
 * Liefert den Token nur für Tests zurück.
 */
export async function issueLoginLink(email: string, redirect: string | null): Promise<string | null> {
  const db = getDb()
  const [user] = await db
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1)

  if (user) {
    if (user.status === 'disabled' || user.status === 'rejected') return null
    if (staffMustUseSso(user.role)) return null
  } else if (!isDomainAllowed(email)) {
    const domains = allowedDomains()
    throw new Error(`Bitte verwenden Sie eine Adresse mit ${domains.map((d) => `@${d}`).join(' oder ')}.`)
  }

  const token = randomBytes(32).toString('base64url')
  await db.transaction(async (tx) => {
    await tx.insert(loginTokens).values({
      id: hashToken(token),
      email,
      redirect,
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
    })
    // Kontomails gehen unabhängig von den Benachrichtigungseinstellungen raus.
    await enqueueMail(tx, [email], loginLinkMail(appUrl(`/anmelden?token=${token}`), LINK_MINUTES))
  })
  return token
}

export type LinkLogin = { userId: string; redirect: string | null; isNew: boolean }

/** Fehlgeschlagene Anmeldung per Link, mit den Angaben für das Audit-Log. */
export class LinkLoginError extends Error {
  constructor(
    message: string,
    readonly userId: string | null,
    readonly reason: string,
  ) {
    super(message)
  }
}

/** Löst einen Link ein. Legt beim ersten Mal ein Kundenkonto an. */
export async function redeemLoginLink(token: string): Promise<LinkLogin> {
  return getDb().transaction(async (tx) => {
    const [link] = await tx
      .update(loginTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(loginTokens.id, hashToken(token)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, new Date())))
      .returning({ email: loginTokens.email, redirect: loginTokens.redirect })
    if (!link) throw new LinkLoginError(INVALID, null, 'invalid_link')

    const [existing] = await tx
      .select({ id: users.id, role: users.role, status: users.status })
      .from(users)
      .where(sql`lower(${users.email}) = ${link.email}`)
      .for('update')
      .limit(1)

    if (!existing) {
      // Vor- und Nachnamen tragen Kunden vor dem ersten Auftrag im Profil nach (Issue #159);
      // bis dahin zeigt users.name die E-Mail-Adresse.
      const [created] = await tx
        .insert(users)
        .values({
          email: link.email,
          role: 'customer',
          status: 'active',
          lastLoginAt: new Date(),
        })
        .returning({ id: users.id })
      await auditLogin('succeeded', { userId: created!.id, method: 'link' }, tx)
      return { userId: created!.id, redirect: link.redirect, isNew: true }
    }

    if (existing.status === 'disabled' || existing.status === 'rejected') {
      throw new LinkLoginError(INACTIVE, existing.id, 'inactive')
    }
    if (staffMustUseSso(existing.role)) throw new LinkLoginError(STAFF_SSO, existing.id, 'sso_required')
    // Die Adresse ist durch den Link bestätigt; eine Freigabe ist nicht mehr nötig.
    await tx
      .update(users)
      .set({ status: 'active', lastLoginAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, existing.id))
    await auditLogin('succeeded', { userId: existing.id, method: 'link' }, tx)
    return { userId: existing.id, redirect: link.redirect, isNew: false }
  })
}
