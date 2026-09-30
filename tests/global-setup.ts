import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

// Setzt die Testdatenbank zurück und spielt alle Migrationen ein.
// Ohne TEST_DATABASE_URL laufen nur die Unit-Tests.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return
  const client = postgres(url, { max: 1, onnotice: () => {} })
  await client.unsafe('drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;')
  await migrate(drizzle(client), { migrationsFolder: 'drizzle' })
  await client.end()
}
