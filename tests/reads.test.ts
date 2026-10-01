import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Ungelesen-Markierung', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { addComment, assignRequest, getRequestDetail, listRequests, markRequestRead } =
    await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let staff: Principal
  const tag = `gelesen-${Date.now()}`

  const unread = async (user: Principal, id: string) =>
    (await listRequests(user, { search: tag, pageSize: 100 })).rows.find((r) => r.id === id)!.unread
  const read = async (user: Principal, id: string) => {
    const detail = await getRequestDetail(user, id)
    await markRequestRead(user, { id, at: detail.loadedAt })
    return detail
  }

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, lastName: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    staff = { id: rows[1]!.id, role: 'staff' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('eigene Aktionen zählen nicht, fremde schon', async () => {
    const { id } = await placeOrder(customer, { title: tag })
    expect(await unread(customer, id)).toBe(false)
    expect(await unread(staff, id)).toBe(true)
    await read(staff, id)
    expect(await unread(staff, id)).toBe(false)
    await addComment(staff, { id, body: 'Frage', internal: false })
    expect(await unread(staff, id)).toBe(false)
    expect(await unread(customer, id)).toBe(true)
    const list = await listRequests(customer, { unread: true, search: tag, pageSize: 100 })
    expect(list.rows.map((r) => r.id)).toContain(id)
  })

  it('interne Einträge zählen für Kunden nicht', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} intern` })
    await read(customer, id)
    await addComment(staff, { id, body: 'nur intern', internal: true })
    // Die Zuweisung ist ein internes Ereignis.
    await assignRequest(staff, { id, version: 1, assigneeId: staff.id })
    expect(await unread(customer, id)).toBe(false)
    expect(await unread(staff, id)).toBe(true)
  })

  it('liefert den letzten Lesezeitpunkt für die Hervorhebung', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} zeit` })
    const first = await read(staff, id)
    await addComment(customer, { id, body: 'Neu!', internal: false })
    const again = await getRequestDetail(staff, id)
    expect(new Date(again.readAt!).getTime()).toBe(new Date(first.loadedAt).getTime())
    const fresh = again.comments.filter((c) => !c.mine && new Date(c.createdAt) > new Date(again.readAt!))
    expect(fresh.map((c) => c.body)).toEqual(['Neu!'])
  })
})
