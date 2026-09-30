import { createServerFn } from '@tanstack/react-start'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { emailSchema, loginSchema } from '~/lib/validation'
import { getDb, schema } from '../db/client.server'
import { getDummyHash, verifyPassword } from './password.server'
import { issueLoginLink, redeemLoginLink } from './magic-link.server'
import { safeRedirect } from '~/lib/redirect'
import { getOidcSettings } from './oidc.server'
import { assertRateLimit } from './rate-limit.server'
import { createSession, destroyCurrentSession, getSessionUser } from './session.server'

export const getCurrentUser = createServerFn({ method: 'GET' }).handler(() => getSessionUser())

/** Welche Anmeldewege die Login-Seite anbieten soll. */
export const getAuthOptions = createServerFn({ method: 'GET' }).handler(() => {
  const oidc = getOidcSettings()
  return { oidc: oidc ? { displayName: oidc.displayName } : null }
})

export const login = createServerFn({ method: 'POST' })
  .validator(loginSchema)
  .handler(async ({ data }) => {
    assertRateLimit('login', 10, 60_000)
    const db = getDb()
    const [user] = await db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${data.email}`)
      .limit(1)

    const hash = user?.passwordHash ?? (await getDummyHash())
    const valid = await verifyPassword(hash, data.password)
    if (!user || !user.passwordHash || !valid) {
      throw new Error('E-Mail-Adresse oder Passwort ist falsch')
    }
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

    await destroyCurrentSession()
    await createSession(user.id)
    await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id))
    return { ok: true as const }
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  await destroyCurrentSession()
  return { ok: true as const }
})

export const requestLoginLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ email: emailSchema, redirect: z.string().max(500).nullable() }))
  .handler(async ({ data }) => {
    assertRateLimit('login-link', 10, 10 * 60_000)
    assertRateLimit('login-link-address', 3, 10 * 60_000, data.email)
    await issueLoginLink(data.email, safeRedirect(data.redirect))
    return { ok: true as const }
  })

export const redeemLoginLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(20).max(200) }))
  .handler(async ({ data }) => {
    assertRateLimit('login-link-redeem', 20, 10 * 60_000)
    const result = await redeemLoginLink(data.token)
    await destroyCurrentSession()
    await createSession(result.userId)
    const [user] = await getDb()
      .select({ role: schema.users.role, billingAddress: schema.users.billingAddress })
      .from(schema.users)
      .where(eq(schema.users.id, result.userId))
    // Kunden ohne Rechnungsadresse landen zuerst im Profil.
    const needsProfile = user?.role === 'customer' && !user.billingAddress
    return { redirect: needsProfile ? '/profil?neu=1' : safeRedirect(result.redirect) }
  })
