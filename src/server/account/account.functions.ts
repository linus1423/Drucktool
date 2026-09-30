import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { requireUser } from '../auth/guards.server'
import { getDb, schema } from '../db/client.server'

export const getMyAccountFn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser()
  const [row] = await getDb()
    .select({ emailNotifications: schema.users.emailNotifications })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
  return { ...user, emailNotifications: row?.emailNotifications ?? true }
})

export const updateMyNotificationsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ emailNotifications: z.boolean() }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await getDb()
      .update(schema.users)
      .set({ emailNotifications: data.emailNotifications, updatedAt: new Date() })
      .where(eq(schema.users.id, user.id))
    return { ok: true as const }
  })
