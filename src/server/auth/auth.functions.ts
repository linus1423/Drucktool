import { createServerFn } from '@tanstack/react-start'
import { eq, sql, TransactionRollbackError } from 'drizzle-orm'
import { loginSchema, registerSchema } from '~/lib/validation'
import { getDb, schema } from '../db/client.server'
import { notifyRegistrationReceived } from '../mail/notifications.server'
import { getDummyHash, hashPassword, verifyPassword } from './password.server'
import { assertRateLimit } from './rate-limit.server'
import { createSession, destroyCurrentSession, getSessionUser } from './session.server'

export const getCurrentUser = createServerFn({ method: 'GET' }).handler(() => getSessionUser())

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

/**
 * Selbstregistrierung eines Kunden. Konto und Organisation bleiben im Status
 * "pending", bis ein Superadmin sie freigibt.
 */
export const register = createServerFn({ method: 'POST' })
  .validator(registerSchema)
  .handler(async ({ data }) => {
    assertRateLimit('register', 5, 10 * 60_000)
    const db = getDb()
    const passwordHash = await hashPassword(data.password)

    const [existing] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${data.email}`)
      .limit(1)

    // Gleiche Antwort wie bei Erfolg, damit sich registrierte Adressen nicht ermitteln lassen.
    if (existing) return { ok: true as const }

    await db
      .transaction(async (tx) => {
        const [org] = await tx
          .insert(schema.organisations)
          .values({
            name: data.organisationName,
            email: data.email,
            phone: data.phone || null,
            street: data.street || null,
            zip: data.zip || null,
            city: data.city || null,
            status: 'pending',
          })
          .returning({ id: schema.organisations.id })
        const inserted = await tx
          .insert(schema.users)
          .values({
            email: data.email,
            name: data.name,
            passwordHash,
            role: 'customer',
            status: 'pending',
            organisationId: org!.id,
          })
          .onConflictDoNothing()
          .returning({ id: schema.users.id })
        // Parallele Registrierung mit derselben Adresse: angelegte Organisation verwerfen.
        if (inserted.length === 0) tx.rollback()
        await notifyRegistrationReceived(tx, { name: data.name, email: data.email, organisationName: data.organisationName })
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error
      })
    return { ok: true as const }
  })
