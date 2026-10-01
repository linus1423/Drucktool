import { createServerFn } from '@tanstack/react-start'
import { and, desc, eq, gt, ne } from 'drizzle-orm'
import { z } from 'zod'
import { billingAddressSchema, deliveryAddressSchema } from '~/lib/address'
import { requiredText } from '~/lib/validation'
import { requireUser } from '../auth/guards.server'
import { currentSessionId, destroyCurrentSession } from '../auth/session.server'
import { getDb, schema } from '../db/client.server'

const { users, sessions } = schema

export const getMyAccountFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  const db = getDb()
  const [row] = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      emailNotifications: users.emailNotifications,
      billingAddress: users.billingAddress,
      deliveryAddress: users.deliveryAddress,
    })
    .from(users)
    .where(eq(users.id, user.id))
  const current = currentSessionId()
  const active = await db
    .select({ id: sessions.id, createdAt: sessions.createdAt, userAgent: sessions.userAgent, ip: sessions.ip })
    .from(sessions)
    .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
    .orderBy(desc(sessions.createdAt))
  return {
    ...user,
    firstName: row?.firstName ?? '',
    lastName: row?.lastName ?? user.name,
    emailNotifications: row?.emailNotifications ?? true,
    billingAddress: row?.billingAddress ?? null,
    deliveryAddress: row?.deliveryAddress ?? null,
    // Nur ein Kürzel der Sitzungskennung verlassen den Server.
    sessions: active.map((s) => ({ ...s, id: s.id.slice(0, 16), current: s.id === current })),
  }
})

export const updateMyNotificationsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ emailNotifications: z.boolean() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await getDb()
      .update(users)
      .set({ emailNotifications: data.emailNotifications, updatedAt: new Date() })
      .where(eq(users.id, user.id))
    return { ok: true as const }
  })

export const profileSchema = z.object({
  firstName: requiredText('Vorname'),
  lastName: requiredText('Nachname'),
  billingAddress: billingAddressSchema,
  deliveryAddress: deliveryAddressSchema.nullable(),
})

export const updateMyProfileFn = createServerFn({ method: 'POST' })
  .validator(profileSchema)
  .handler(async ({ data }) => {
    const user = await requireUser()
    await getDb()
      .update(users)
      .set({
        firstName: data.firstName,
        lastName: data.lastName,
        billingAddress: data.billingAddress,
        deliveryAddress: data.deliveryAddress,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
    return { ok: true as const }
  })

/** Beendet eine eigene Sitzung (per Kürzel) oder alle anderen. */
export const revokeMySessionsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string().length(16).nullable() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const db = getDb()
    const current = currentSessionId()
    if (data.id === null) {
      await db.delete(sessions).where(and(eq(sessions.userId, user.id), current ? ne(sessions.id, current) : undefined))
      return { ok: true as const }
    }
    const mine = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, user.id))
    const target = mine.find((s) => s.id.startsWith(data.id!))
    if (!target) throw new Error('Sitzung nicht gefunden')
    if (target.id === current) await destroyCurrentSession()
    else await db.delete(sessions).where(eq(sessions.id, target.id))
    return { ok: true as const }
  })
