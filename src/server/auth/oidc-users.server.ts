import { and, eq, sql } from 'drizzle-orm'
import { displayName, splitName, type PersonName } from '~/lib/name'
import { getDb, schema } from '../db/client.server'
import { notifyRegistrationReceived } from '../mail/notifications.server'
import type { NewUserPolicy, RoleMapping } from './oidc.server'

export type OidcClaims = {
  sub: string
  email?: unknown
  email_verified?: unknown
  name?: unknown
  given_name?: unknown
  family_name?: unknown
  [claim: string]: unknown
}

export type OidcResolution = { kind: 'login'; userId: string } | { kind: 'pending' } | { kind: 'denied'; message: string }

export type ResolveOptions = {
  policy: NewUserPolicy
  /** E-Mail-Adressen auch ohne email_verified als bestätigt ansehen. */
  trustEmail?: boolean
  /** Rollen aus einem Claim des Anbieters ableiten (z. B. Entra-App-Rollen oder Gruppen). */
  roles?: RoleMapping | null
  /** Nur Kunden dürfen sich anmelden (Kunden-Anbieter wie der TUM-Keycloak, Issue #60). */
  customersOnly?: boolean
}

const { users, oidcAccounts, sessions } = schema

const INACTIVE = 'Ihr Konto ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.'
const STAFF_ELSEWHERE =
  'Mitarbeiter der Druckerei melden sich bitte über die Mitarbeiter-Anmeldung an, nicht mit der Kunden-Anmeldung.'
const NO_ROLE = 'Ihr Firmenkonto ist nicht (mehr) für das Drucktool freigeschaltet. Bitte wenden Sie sich an die IT.'

const claimText = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Vor- und Nachname aus den Claims: bevorzugt given_name/family_name, sonst wird name am letzten
 * Leerzeichen geteilt. Ohne Namen bleiben beide leer, die Person trägt sie im Profil nach (Issue #159).
 */
export function nameFromClaims(claims: OidcClaims): PersonName {
  const firstName = claimText(claims.given_name)
  const lastName = claimText(claims.family_name)
  if (firstName || lastName) return { firstName, lastName }
  const name = claimText(claims.name)
  return name ? splitName(name) : { firstName: '', lastName: '' }
}

/** Liefert "admin" oder "staff", wenn der Claim einen der konfigurierten Werte enthält. */
export function roleFromClaims(claims: OidcClaims, mapping: RoleMapping): 'admin' | 'staff' | null {
  const raw = claims[mapping.claim]
  const values = new Set(Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/) : [])
  if (mapping.adminValues.some((v) => values.has(v))) return 'admin'
  if (mapping.staffValues.some((v) => values.has(v))) return 'staff'
  return null
}

async function decide(userId: string, claims: OidcClaims, options: ResolveOptions): Promise<OidcResolution> {
  const db = getDb()
  const [row] = await db.select({ status: users.status, role: users.role }).from(users).where(eq(users.id, userId))
  if (!row) return { kind: 'denied', message: INACTIVE }
  if (options.customersOnly && row.role !== 'customer') return { kind: 'denied', message: STAFF_ELSEWHERE }

  // Die Rollen der Mitarbeiter kommen bei jeder Anmeldung neu vom Anbieter. Der Superadmin
  // (lokaler Notfallzugang) wird nie angefasst.
  if (options.roles && row.role !== 'superadmin') {
    const mapped = roleFromClaims(claims, options.roles)
    if (!mapped && (row.role === 'admin' || row.role === 'staff')) {
      await db.delete(sessions).where(eq(sessions.userId, userId))
      return { kind: 'denied', message: NO_ROLE }
    }
    if (mapped && mapped !== row.role) {
      await db
        .update(users)
        .set({
          role: mapped,
          status: row.status === 'pending' ? 'active' : row.status,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId))
      await db.delete(sessions).where(eq(sessions.userId, userId))
      row.role = mapped
      if (row.status === 'pending') row.status = 'active'
    }
  }

  if (row.status === 'pending') return { kind: 'pending' }
  if (row.status !== 'active') return { kind: 'denied', message: INACTIVE }
  return { kind: 'login', userId }
}

/**
 * Ordnet eine OIDC-Anmeldung einem Benutzer zu:
 * 1. bereits verknüpftes Konto (Issuer + Subject),
 * 2. sonst bestehender Benutzer mit derselben, vom Anbieter bestätigten E-Mail-Adresse,
 * 3. sonst anlegen: mit Rolle aus dem Token direkt als Mitarbeiter/Admin, ansonsten je nach
 *    Einstellung ablehnen, als wartende Registrierung oder als Mitarbeiter.
 */
export async function resolveOidcUser(issuer: string, claims: OidcClaims, options: ResolveOptions): Promise<OidcResolution> {
  const db = getDb()
  const [linked] = await db
    .select({ userId: oidcAccounts.userId })
    .from(oidcAccounts)
    .where(and(eq(oidcAccounts.issuer, issuer), eq(oidcAccounts.subject, claims.sub)))
  if (linked) return decide(linked.userId, claims, options)

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  // Ohne bestätigte Adresse wird weder verknüpft noch angelegt, sonst könnte man fremde Konten übernehmen.
  if (!email || (claims.email_verified !== true && !options.trustEmail)) {
    return {
      kind: 'denied',
      message: 'Ihr Anmeldedienst hat keine bestätigte E-Mail-Adresse übermittelt. Bitte wenden Sie sich an die Druckerei.',
    }
  }

  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
  // Ein Mitarbeiterkonto wird nie mit dem Kunden-Anbieter verknüpft.
  if (existing && options.customersOnly && existing.role !== 'customer') {
    return { kind: 'denied', message: STAFF_ELSEWHERE }
  }
  if (existing) {
    await db.insert(oidcAccounts).values({ userId: existing.id, issuer, subject: claims.sub }).onConflictDoNothing()
    return decide(existing.id, claims, options)
  }

  const mapped = options.roles ? roleFromClaims(claims, options.roles) : null
  if (!mapped && options.policy === 'reject') {
    return {
      kind: 'denied',
      message:
        'Für diese E-Mail-Adresse gibt es noch kein Konto. Bitte registrieren Sie sich oder wenden Sie sich an die Druckerei.',
    }
  }

  const role = mapped ?? (options.policy === 'staff' ? 'staff' : 'customer')
  // Lastenheft V2: Kunden über den Kunden-Anbieter sind sofort aktiv, wie beim Anmeldelink.
  const status = role === 'customer' && options.policy !== 'customer' ? 'pending' : 'active'
  const personName = nameFromClaims(claims)
  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ email, ...personName, role, status })
      .onConflictDoNothing()
      .returning({ id: users.id })
    if (!user) return null
    await tx.insert(oidcAccounts).values({ userId: user.id, issuer, subject: claims.sub })
    if (status === 'pending') {
      await notifyRegistrationReceived(tx, {
        name: displayName(personName) || email,
        email,
        organisationName: 'ohne Organisation (Anmeldung über OIDC)',
      })
    }
    return user
  })
  // Gleichzeitige erste Anmeldung: der andere Aufruf hat den Benutzer schon angelegt.
  if (!created) return resolveOidcUser(issuer, claims, options)
  return decide(created.id, claims, options)
}
