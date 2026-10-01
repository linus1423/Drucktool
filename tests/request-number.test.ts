import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'
import { berlinToday } from '~/lib/deadlines'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Auftragsnummer JJMMxxxx (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  const month = Number(berlinToday().slice(2, 7).replace('-', ''))

  beforeAll(async () => {
    const [row] = await getDb()
      .insert(schema.users)
      .values({
        email: `nummer-${Date.now()}@test`,
        lastName: 'Nummer',
        role: 'customer',
        status: 'active',
        billingAddress: BILLING,
      })
      .returning()
    customer = { id: row!.id, role: 'customer', organisationId: null }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('vergibt achtstellige, fortlaufende Nummern mit Jahr und Monat', async () => {
    const a = await placeOrder(customer, { title: 'Nummer A' })
    const b = await placeOrder(customer, { title: 'Nummer B' })
    const [ra, rb] = await Promise.all(
      [a.id, b.id].map(async (id) => (await getDb().select().from(schema.requests).where(eq(schema.requests.id, id)))[0]!),
    )
    expect(String(ra!.number)).toMatch(/^\d{8}$/)
    expect(Math.floor(ra!.number / 10000)).toBe(month)
    expect(rb!.number).toBe(ra!.number + 1)
  })

  it('vergibt bei gleichzeitigen Aufträgen keine Nummer doppelt', async () => {
    const created = await Promise.all(Array.from({ length: 5 }, (_, i) => placeOrder(customer, { title: `Parallel ${i}` })))
    const rows = await getDb()
      .select({ number: schema.requests.number })
      .from(schema.requests)
      .where(sql`${schema.requests.id} in ${created.map((c) => c.id)}`)
    expect(new Set(rows.map((r) => r.number)).size).toBe(5)
  })

  it('bricht ab, wenn im Monat alle 9999 Nummern vergeben sind', async () => {
    const [counter] = await getDb()
      .select()
      .from(schema.requestNumberCounters)
      .where(eq(schema.requestNumberCounters.month, month))
    const last = counter!.last
    await getDb().execute(sql`update request_number_counters set last = 9999 where month = ${month}`)
    try {
      await expect(getDb().execute(sql`select next_request_number()`)).rejects.toThrow()
    } finally {
      await getDb().execute(sql`update request_number_counters set last = ${last} where month = ${month}`)
    }
  })
})
