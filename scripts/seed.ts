// Legt den ersten Superadmin an, falls noch keiner existiert.
// SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD und optional SUPERADMIN_NAME setzen.
// Mit SEED_EXAMPLE_CATALOG=true werden zusätzlich die Beispiel-Coverfarben je Papier aus Issue #83 gesetzt.
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq, inArray, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from '../src/server/db/schema'
import { hashPassword } from '../src/server/auth/password.server'
import { splitName } from '../src/lib/name'

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
      ...splitName(process.env.SUPERADMIN_NAME ?? 'Superadmin'),
      passwordHash: await hashPassword(password),
      role: 'superadmin',
      status: 'active',
    })
    console.log(`Superadmin ${email} angelegt`)
  }
}

/**
 * Beispiel aus Issue #83: Auf Coverkarton mit 250 g/m² gibt es nur Weiß, auf dem
 * 160-g/m²-Deckblattpapier zusätzlich Blau, Rot und Durchsichtig. Überschreibt die
 * Farbzuordnung dieser Papiere, deshalb nur auf ausdrücklichen Wunsch (Demo, Entwicklung).
 */
async function seedExampleCoverColors() {
  const colors = await db.select().from(schema.coverColors)
  const byName = (name: string) => colors.find((c) => c.name === name)
  const white = byName('Weiß')
  if (!white) {
    console.log('Coverfarbe „Weiß“ fehlt, Beispiel-Coverfarben übersprungen')
    return
  }
  const colored = ['Weiß', 'Dunkelblau', 'Dunkelrot', 'Durchsichtig'].flatMap((n) => byName(n) ?? [])

  const [existingCard] = await db
    .select({ id: schema.papers.id })
    .from(schema.papers)
    .where(and(eq(schema.papers.grammage, 250), eq(schema.papers.forCover, true)))
    .limit(1)
  const card =
    existingCard ??
    (
      await db
        .insert(schema.papers)
        .values({
          name: 'Coverkarton',
          grammage: 250,
          priceA3Cents: 12,
          priceSra3Cents: 16,
          forCover: true,
          forInner: false,
          maxFormatId: 'A3',
          helpText: 'Fester Karton für Deckblätter, nur in Weiß.',
          sortOrder: 25,
        })
        .returning({ id: schema.papers.id })
    )[0]!
  const thin = await db
    .select({ id: schema.papers.id })
    .from(schema.papers)
    .where(and(eq(schema.papers.grammage, 160), eq(schema.papers.forCover, true)))

  const assign = async (paperIds: string[], colorIds: string[]) => {
    if (paperIds.length === 0) return
    await db.delete(schema.paperCoverColors).where(inArray(schema.paperCoverColors.paperId, paperIds))
    const rows = paperIds.flatMap((paperId) => colorIds.map((coverColorId) => ({ paperId, coverColorId })))
    if (rows.length) await db.insert(schema.paperCoverColors).values(rows).onConflictDoNothing()
  }
  await assign([card.id], [white.id])
  await assign(
    thin.map((p) => p.id),
    colored.map((c) => c.id),
  )
  console.log(`Beispiel-Coverfarben gesetzt: 250 g/m² nur Weiß, 160 g/m² ${colored.map((c) => c.name).join(', ')}`)
}

if (process.env.SEED_EXAMPLE_CATALOG === 'true') await seedExampleCoverColors()

await client.end()
