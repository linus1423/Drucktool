import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import path from 'node:path'
import { logger } from '../src/server/log.server'

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')

const client = postgres(url, { max: 1, onnotice: () => {} })
const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), 'drizzle')
await migrate(drizzle(client), { migrationsFolder })
logger.info('Migrationen angewendet')
await client.end()
