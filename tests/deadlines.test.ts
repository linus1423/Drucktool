import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { DEFAULT_DEADLINE_SETTINGS, attentionFor, berlinToday } from '~/lib/deadlines'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe('Hinweise zu Terminen', () => {
  const now = new Date('2026-10-01T10:00:00Z')
  const base = { status: 'confirmed' as const, promisedDate: null, internalDueDate: null, statusChangedAt: now }

  it('erkennt überfällige und heute fällige Aufträge', () => {
    expect(attentionFor({ ...base, promisedDate: '2026-09-30' }, DEFAULT_DEADLINE_SETTINGS, now)).toBe('overdue')
    expect(attentionFor({ ...base, internalDueDate: '2026-10-01' }, DEFAULT_DEADLINE_SETTINGS, now)).toBe('due_today')
    expect(attentionFor({ ...base, promisedDate: '2026-10-02' }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
    // Abgeschlossene Aufträge brauchen keine Aufmerksamkeit mehr.
    expect(attentionFor({ ...base, status: 'completed', promisedDate: '2026-09-01' }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
  })

  it('rechnet „heute“ in deutscher Zeit', () => {
    expect(berlinToday(new Date('2026-09-30T22:30:00Z'))).toBe('2026-10-01')
  })

  it('markiert Aufträge, die zu lange im selben Status stehen', () => {
    const sixDaysAgo = new Date(now.getTime() - 6 * 86_400_000)
    expect(attentionFor({ ...base, status: 'on_hold', statusChangedAt: sixDaysAgo }, DEFAULT_DEADLINE_SETTINGS, now)).toBe(
      'stale',
    )
    expect(attentionFor({ ...base, status: 'confirmed', statusChangedAt: sixDaysAgo }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
    expect(
      attentionFor(
        { ...base, status: 'confirmed', statusChangedAt: sixDaysAgo },
        { ...DEFAULT_DEADLINE_SETTINGS, staleConfirmedDays: 3 },
        now,
      ),
    ).toBe('stale')
  })
})

describe.skipIf(!url)('Termine (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { changeStatus, getRequestDetail, listRequests, setDates } = await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let staff: Principal
  const tag = `frist-${Date.now()}`

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, name: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, name: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer', organisationId: null }
    staff = { id: rows[1]!.id, role: 'staff', organisationId: null }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('zeigt Kunden den zugesagten Termin, aber nie die interne Frist', async () => {
    const { id } = await placeOrder(customer, { title: tag })
    await setDates(staff, { id, version: 1, promisedDate: '2030-05-02', internalDueDate: '2030-04-30' })
    const own = await getRequestDetail(customer, id)
    expect(own.promisedDate).toBe('2030-05-02')
    expect(own.internalDueDate).toBeNull()
    expect(own.events.filter((e) => e.type === 'dates_changed').map((e) => e.data.field)).toEqual(['promisedDate'])
    const staffView = await getRequestDetail(staff, id)
    expect(staffView.internalDueDate).toBe('2030-04-30')
    expect(staffView.events.filter((e) => e.type === 'dates_changed')).toHaveLength(2)
    const mails = await getDb()
      .select()
      .from(schema.emailOutbox)
      .where(eq(schema.emailOutbox.to, `${tag}-k@test`))
    expect(mails.some((m) => m.subject.startsWith('Termin für') && m.text.includes('02.05.2030'))).toBe(true)
    await expect(setDates(customer, { id, version: 2, promisedDate: null, internalDueDate: null })).rejects.toThrow(
      'Keine Berechtigung',
    )
  })

  it('findet überfällige Aufträge; die interne Frist zählt nur für Mitarbeiter', async () => {
    const late = await placeOrder(customer, { title: `${tag} spät` })
    await setDates(staff, { id: late.id, version: 1, promisedDate: null, internalDueDate: '2020-01-01' })
    expect((await listRequests(staff, { search: tag, overdue: true })).rows.map((r) => r.id)).toEqual([late.id])
    expect((await listRequests(customer, { search: tag, overdue: true })).total).toBe(0)
    const row = (await listRequests(staff, { search: `${tag} spät` })).rows[0]!
    expect(row.attention).toBe('overdue')
    expect((await listRequests(customer, { search: `${tag} spät` })).rows[0]!.attention).toBeNull()
  })

  it('merkt sich, seit wann der Auftrag im Status steht', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} status` })
    await getDb()
      .update(schema.requests)
      .set({ statusChangedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(schema.requests.id, id))
    expect((await getRequestDetail(staff, id)).attention).toBe('stale')
    await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    const after = await getRequestDetail(staff, id)
    expect(after.attention).toBeNull()
    expect(new Date(after.statusChangedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })
})
