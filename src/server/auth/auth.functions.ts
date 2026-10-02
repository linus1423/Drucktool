import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { emailSchema, loginSchema } from '~/lib/validation'
import { getDb, schema } from '../db/client.server'
import { authenticateWithPassword } from './login.server'
import { LinkLoginError, issueLoginLink, redeemLoginLink } from './magic-link.server'
import { auditLogin } from '../audit/audit.server'
import { safeRedirect } from '~/lib/redirect'
import { getOidcSettings } from './oidc.server'
import { assertRateLimit } from './rate-limit.server'
import { createSession, destroyCurrentSession, getSessionUser } from './session.server'

export const getCurrentUser = createServerFn({ method: 'GET' }).handler(() => getSessionUser())

/** Welche Anmeldewege die Login-Seite anbieten soll. */
export const getAuthOptions = createServerFn({ method: 'GET' }).handler(() => {
  const oidc = getOidcSettings('staff')
  const customer = getOidcSettings('customer')
  return {
    oidc: oidc ? { displayName: oidc.displayName } : null,
    customerOidc: customer ? { displayName: customer.displayName } : null,
  }
})

/** Links auf Datenschutzerklärung und Impressum (PRIVACY_URL, IMPRINT_URL), für die Fußzeile. */
export const getSiteLinksFn = createServerFn({ method: 'GET' }).handler(() => ({
  privacyUrl: process.env.PRIVACY_URL || null,
  imprintUrl: process.env.IMPRINT_URL || null,
}))

export const login = createServerFn({ method: 'POST' })
  .validator(loginSchema)
  .handler(async ({ data }) => {
    await assertRateLimit('login', 10, 60_000)
    const user = await authenticateWithPassword(data.email, data.password)
    const db = getDb()
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
    await assertRateLimit('login-link', 10, 10 * 60_000)
    await assertRateLimit('login-link-address', 3, 10 * 60_000, data.email)
    await issueLoginLink(data.email, safeRedirect(data.redirect))
    return { ok: true as const }
  })

export const redeemLoginLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ token: z.string().min(20).max(200) }))
  .handler(async ({ data }) => {
    await assertRateLimit('login-link-redeem', 20, 10 * 60_000)
    const result = await redeemLoginLink(data.token).catch(async (error: unknown) => {
      if (error instanceof LinkLoginError) {
        await auditLogin('failed', { userId: error.userId, method: 'link', reason: error.reason })
      }
      throw error
    })
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
