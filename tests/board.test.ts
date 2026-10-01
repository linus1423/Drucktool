import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Board (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { listBoard, changeStatus, assignRequest } = await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal

  let customer: Principal
  let staff: Principal
  const tag = `board-${Date.now()}`
  const ids: Record<string, string> = {}

  const version = async (id: string) =>
    (await getDb().select({ v: schema.requests.version }).from(schema.requests).where(eq(schema.requests.id, id)))[0]!.v

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, lastName: 'Boardkundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, lastName: 'Boardstaff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    staff = { id: rows[1]!.id, role: 'staff' }
    for (const name of ['neu', 'frage', 'fertig', 'alt', 'abgelehnt'])
      ids[name] = (await placeOrder(customer, { title: `${tag} ${name}` })).id
    const move = async (id: string, to: 'on_hold' | 'confirmed' | 'completed' | 'rejected', note?: string) =>
      changeStatus(staff, { id, version: await version(id), to, note })
    await move(ids.frage!, 'on_hold', 'Welches Papier?')
    for (const name of ['fertig', 'alt']) {
      await move(ids[name]!, 'confirmed')
      await move(ids[name]!, 'completed')
    }
    await move(ids.abgelehnt!, 'rejected', 'Passt nicht')
    await getDb()
      .update(schema.requests)
      .set({ statusChangedAt: sql`now() - interval '15 days'` })
      .where(eq(schema.requests.id, ids.alt!))
    await assignRequest(staff, { id: ids.neu!, version: await version(ids.neu!), assigneeId: staff.id })
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('zeigt offene und frisch fertige Aufträge, aber keine alten oder abgelehnten', async () => {
    const { rows, truncated } = await listBoard(staff, { search: tag })
    expect(truncated).toBe(false)
    const byTitle = Object.fromEntries(rows.map((r) => [r.title.replace(`${tag} `, ''), r.status]))
    expect(byTitle).toEqual({ neu: 'submitted', frage: 'on_hold', fertig: 'completed' })
    expect(rows.every((r) => typeof r.version === 'number')).toBe(true)
  })

  it('filtert auf eigene Aufträge', async () => {
    const { rows } = await listBoard(staff, { search: tag, mine: true })
    expect(rows.map((r) => r.id)).toEqual([ids.neu])
  })

  it('ist nur für Mitarbeiter', async () => {
    await expect(listBoard(customer, { search: tag })).rejects.toThrow('Keine Berechtigung')
  })
})
