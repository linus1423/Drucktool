import { and, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '../db/client.server'
import { notifyRegistrationReceived } from '../mail/notifications.server'
import type { NewUserPolicy } from './oidc.server'

export type OidcClaims = {
  sub: string
  email?: unknown
  email_verified?: unknown
  name?: unknown
  given_name?: unknown
  family_name?: unknown
}

export type OidcResolution =
  | { kind: 'login'; userId: string }
  | { kind: 'pending' }
  | { kind: 'denied'; message: string }

const { users, organisations, oidcAccounts } = schema

const INACTIVE = 'Ihr Konto ist nicht aktiv. Bitte wenden Sie sich an die Druckerei.'

function displayName(claims: OidcClaims, email: string) {
  if (typeof claims.name === 'string' && claims.name.trim()) return claims.name.trim()
  const parts = [claims.given_name, claims.family_name].filter((p): p is string => typeof p === 'string' && !!p.trim())
  return parts.length ? parts.join(' ') : email
}

async function decide(userId: string): Promise<OidcResolution> {
  const [row] = await getDb()
    .select({ status: users.status, role: users.role, orgStatus: organisations.status })
    .from(users)
    .leftJoin(organisations, eq(organisations.id, users.organisationId))
    .where(eq(users.id, userId))
  if (!row) return { kind: 'denied', message: INACTIVE }
  if (row.status === 'pending') return { kind: 'pending' }
  if (row.status !== 'active') return { kind: 'denied', message: INACTIVE }
  if (row.role === 'customer' && row.orgStatus !== 'active') return { kind: 'denied', message: INACTIVE }
  return { kind: 'login', userId }
}

/**
 * Ordnet eine OIDC-Anmeldung einem Benutzer zu:
 * 1. bereits verknüpftes Konto (Issuer + Subject),
 * 2. sonst bestehender Benutzer mit derselben, vom Anbieter bestätigten E-Mail-Adresse,
 * 3. sonst je nach Einstellung ablehnen, als wartende Registrierung anlegen oder als Mitarbeiter anlegen.
 */
export async function resolveOidcUser(
  issuer: string,
  claims: OidcClaims,
  policy: NewUserPolicy,
  trustEmail = false,
): Promise<OidcResolution> {
  const db = getDb()
  const [linked] = await db
    .select({ userId: oidcAccounts.userId })
    .from(oidcAccounts)
    .where(and(eq(oidcAccounts.issuer, issuer), eq(oidcAccounts.subject, claims.sub)))
  if (linked) return decide(linked.userId)

  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  // Ohne bestätigte Adresse wird weder verknüpft noch angelegt, sonst könnte man fremde Konten übernehmen.
  if (!email || (claims.email_verified !== true && !trustEmail)) {
    return {
      kind: 'denied',
      message: 'Ihr Anmeldedienst hat keine bestätigte E-Mail-Adresse übermittelt. Bitte wenden Sie sich an die Druckerei.',
    }
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
  if (existing) {
    await db.insert(oidcAccounts).values({ userId: existing.id, issuer, subject: claims.sub }).onConflictDoNothing()
    return decide(existing.id)
  }

  if (policy === 'reject') {
    return {
      kind: 'denied',
      message: 'Für diese E-Mail-Adresse gibt es noch kein Konto. Bitte registrieren Sie sich oder wenden Sie sich an die Druckerei.',
    }
  }

  const name = displayName(claims, email)
  const created = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email,
        name,
        role: policy === 'staff' ? 'staff' : 'customer',
        status: policy === 'staff' ? 'active' : 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: users.id })
    if (!user) return null
    await tx.insert(oidcAccounts).values({ userId: user.id, issuer, subject: claims.sub })
    if (policy === 'pending') {
      await notifyRegistrationReceived(tx, { name, email, organisationName: 'ohne Organisation (Anmeldung über OIDC)' })
    }
    return user
  })
  // Gleichzeitige erste Anmeldung: der andere Aufruf hat den Benutzer schon angelegt.
  if (!created) return resolveOidcUser(issuer, claims, policy, trustEmail)
  return decide(created.id)
}
