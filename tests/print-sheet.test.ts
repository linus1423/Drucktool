import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe.skipIf(!url)('Druckbogen (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { setPrintSheet, getRequestDetail } = await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal

  let customer: Principal
  let staff: Principal
  let customerEmail = ''
  let id = ''
  const tag = `bogen-${Date.now()}`

  const version = async () =>
    (await getDb().select({ v: schema.requests.version }).from(schema.requests).where(eq(schema.requests.id, id)))[0]!.v
  const mailCount = async () =>
    (await getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, customerEmail))).length

  beforeAll(async () => {
    customerEmail = `${tag}-k@test`
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: customerEmail, lastName: 'Bogenkundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, lastName: 'Bogenstaff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    staff = { id: rows[1]!.id, role: 'staff', organisationId: null }
    id = (await placeOrder(customer, { title: `${tag} Skript` })).id
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('bietet Mitarbeitern die vorrätigen Bogengrößen des Papiers an', async () => {
    const detail = await getRequestDetail(staff, id)
    expect(detail.printSheet).toBeNull()
    expect(detail.printSheetOptions.inner.map((s) => s.label)).toEqual(['A3', 'SRA3'])
  })

  it('setzt den Bogen intern, ohne Status, Preis oder Mail zu ändern', async () => {
    const before = (await getDb().select().from(schema.requests).where(eq(schema.requests.id, id)))[0]!
    const mails = await mailCount()
    await setPrintSheet(staff, { id, version: await version(), sheet: 'SRA3', coverSheet: null })
    const after = (await getDb().select().from(schema.requests).where(eq(schema.requests.id, id)))[0]!
    expect(after.printSheet).toEqual({ label: 'SRA3', widthMm: 320, heightMm: 450 })
    expect(after.status).toBe(before.status)
    expect(after.totalCents).toBe(before.totalCents)
    expect(await mailCount()).toBe(mails)
    const events = await getDb()
      .select()
      .from(schema.requestEvents)
      .where(and(eq(schema.requestEvents.requestId, id), eq(schema.requestEvents.type, 'print_sheet_changed')))
    expect(events).toHaveLength(1)
    expect(events[0]!.internal).toBe(true)
  })

  it('verbirgt den Bogen vor Kunden', async () => {
    const detail = await getRequestDetail(customer, id)
    expect(detail.printSheet).toBeNull()
    expect(detail.printSheetOptions.inner).toEqual([])
    expect(detail.events.some((e) => e.type === 'print_sheet_changed')).toBe(false)
  })

  it('lehnt nicht hinterlegte Größen und Kunden ab', async () => {
    await expect(setPrintSheet(staff, { id, version: await version(), sheet: 'A2', coverSheet: null })).rejects.toThrow(
      'nicht hinterlegt',
    )
    await expect(setPrintSheet(customer, { id, version: await version(), sheet: 'A3', coverSheet: null })).rejects.toThrow(
      'Keine Berechtigung',
    )
  })

  it('setzt auf „wie berechnet“ zurück', async () => {
    await setPrintSheet(staff, { id, version: await version(), sheet: null, coverSheet: null })
    const detail = await getRequestDetail(staff, id)
    expect(detail.printSheet).toBeNull()
  })
})
