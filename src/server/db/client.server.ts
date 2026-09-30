import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

function createDb() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL ist nicht gesetzt')
  const client = postgres(url, { max: Number(process.env.DATABASE_POOL_SIZE ?? 10) })
  return drizzle(client, { schema })
}

type Db = ReturnType<typeof createDb>

const globalForDb = globalThis as unknown as { __drucktoolDb?: Db }

export function getDb(): Db {
  globalForDb.__drucktoolDb ??= createDb()
  return globalForDb.__drucktoolDb
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export { schema }
