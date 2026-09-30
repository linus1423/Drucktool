// Legt den ersten Superadmin an, falls noch keiner existiert.
// SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD und optional SUPERADMIN_NAME setzen.
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../src/server/db/schema'
import { hashPassword } from '../src/server/auth/password.server'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase()
const password = process.env.SUPERADMIN_PASSWORD

const client = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(client, { schema })

const existing = await db
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(eq(schema.users.role, 'superadmin'))
  .limit(1)

if (existing.length > 0) {
  console.log('Superadmin existiert bereits, nichts zu tun')
} else if (!email || !password) {
  console.log('Kein Superadmin vorhanden. SUPERADMIN_EMAIL und SUPERADMIN_PASSWORD setzen, um einen anzulegen.')
} else if (password.length < 12) {
  throw new Error('SUPERADMIN_PASSWORD muss mindestens 12 Zeichen lang sein')
} else {
  const taken = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${email}`)
  if (taken[0]) {
    await db
      .update(schema.users)
      .set({ role: 'superadmin', status: 'active', updatedAt: new Date() })
      .where(eq(schema.users.id, taken[0].id))
    console.log(`Bestehender Benutzer ${email} wurde zum Superadmin gemacht`)
  } else {
    await db.insert(schema.users).values({
      email,
      name: process.env.SUPERADMIN_NAME ?? 'Superadmin',
      passwordHash: await hashPassword(password),
      role: 'superadmin',
      status: 'active',
    })
    console.log(`Superadmin ${email} angelegt`)
  }
}

await client.end()
