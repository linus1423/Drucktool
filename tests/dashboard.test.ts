import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'
import { lastMonths } from '~/server/requests/dashboard.server'
import { berlinToday } from '~/lib/deadlines'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe('Monatsliste', () => {
  it('zählt über Jahresgrenzen zurück', () => {
    expect(lastMonths(3, '2026-02-15')).toEqual(['2025-12', '2026-01', '2026-02'])
    expect(lastMonths(1, '2026-10-01')).toEqual(['2026-10'])
  })
})

describe.skipIf(!url)('Übersicht (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { getDashboard } = await import('~/server/requests/dashboard.server')
  const { changeStatus, assignRequest } = await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal

  let customer: Principal
  let other: Principal
  let staff: Principal
  const tag = `dash-${Date.now()}`
  const ids: Record<string, string> = {}
  let doneCents = 0

  const version = async (id: string) =>
    (await getDb().select({ v: schema.requests.version }).from(schema.requests).where(eq(schema.requests.id, id)))[0]!.v

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, name: 'Dashkundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-f@test`, name: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, name: 'Dashstaff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    other = { id: rows[1]!.id, role: 'customer', organisationId: null }
    staff = { id: rows[2]!.id, role: 'staff', organisationId: null }
    for (const name of ['offen', 'frage', 'fertig']) ids[name] = (await placeOrder(customer, { title: `${tag} ${name}` })).id
    ids.fremd = (await placeOrder(other, { title: `${tag} fremd` })).id
    await changeStatus(staff, { id: ids.frage!, version: await version(ids.frage!), to: 'on_hold', note: 'Welches Papier?' })
    await changeStatus(staff, { id: ids.fertig!, version: await version(ids.fertig!), to: 'confirmed' })
    await changeStatus(staff, { id: ids.fertig!, version: await version(ids.fertig!), to: 'completed' })
    await assignRequest(staff, { id: ids.offen!, version: await version(ids.offen!), assigneeId: staff.id })
    const [done] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, ids.fertig!))
    doneCents = done!.totalCents ?? 0
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('zeigt Kunden nur ihre eigenen offenen Aufträge und Rückfragen', async () => {
    const d = await getDashboard(customer)
    if (d.kind !== 'customer') throw new Error('falsche Sicht')
    expect(Object.fromEntries(d.byStatus.map((s) => [s.status, s.count]))).toEqual({ submitted: 1, confirmed: 0, on_hold: 1 })
    expect(d.waiting.map((w) => w.id)).toEqual([ids.frage])
    expect(JSON.stringify(d)).not.toContain('fremd')
  })

  it('berechnet Kennzahlen für Mitarbeiter aus Aufträgen und Historie', async () => {
    const d = await getDashboard(staff)
    if (d.kind !== 'staff') throw new Error('falsche Sicht')
    expect(d.counters.mine).toBe(1)
    expect(d.counters.newSinceYesterday).toBeGreaterThanOrEqual(3)
    expect(d.byStatus.find((s) => s.status === 'on_hold')!.count).toBeGreaterThanOrEqual(1)
    expect(d.throughput.count).toBeGreaterThanOrEqual(1)
    expect(d.throughput.medianDays).not.toBeNull()
    const month = d.months.at(-1)!
    expect(month.month).toBe(berlinToday().slice(0, 7))
    expect(month.created).toBeGreaterThanOrEqual(4)
    expect(month.completed).toBeGreaterThanOrEqual(1)
    expect(month.revenueCents).toBeGreaterThanOrEqual(doneCents)
    expect(d.months).toHaveLength(12)
    expect(d.distribution.formats.some((f) => f.orders >= 4 && f.copies >= 4)).toBe(true)
    expect(d.distribution.papers[0]!.label).toMatch(/g\/m²$/)
  })
})
