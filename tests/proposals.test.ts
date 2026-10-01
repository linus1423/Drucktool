import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import type { OrderSpec } from '~/lib/order'
import { calculatePrice } from '~/lib/pricing'
import { compareOrders } from '~/lib/proposal'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { getDb, schema } = await import('~/server/db/client.server')
const { getCatalog } = await import('~/server/catalog/catalog.server')
const { answerChange, changeStatus, getRequestDetail, proposeChange, withdrawChange } =
  await import('~/server/requests/requests.server')
type Principal = import('~/server/requests/requests.server').Principal

describe.skipIf(!url)('Änderungsvorschläge der Druckerei (Issue #50)', () => {
  let customer: Principal
  let other: Principal
  let staff: Principal
  let staff2: Principal

  beforeAll(async () => {
    const stamp = Date.now()
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `p-kunde-${stamp}@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `p-fremd-${stamp}@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `p-staff-${stamp}@test`, lastName: 'Staff', role: 'staff', status: 'active' },
        { email: `p-staff2-${stamp}@test`, firstName: 'Staff', lastName: 'Zwei', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    other = { id: rows[1]!.id, role: 'customer' }
    staff = { id: rows[2]!.id, role: 'staff' }
    staff2 = { id: rows[3]!.id, role: 'staff' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function proposal(id: string, version: number, change: Partial<OrderSpec>, priceOverrideCents: number | null = null) {
    const detail = await getRequestDetail(staff, id)
    const spec = { ...detail.order!.spec, ...change }
    const priced = calculatePrice(await getCatalog({ onlyAvailable: true }), spec)
    if (!priced.ok) throw new Error(priced.errors.join(' '))
    return {
      id,
      version,
      spec,
      deliveryAddress: null,
      priceOverrideCents,
      expectedTotalCents: priced.price.totalCents,
      reason: 'Es sind 20 statt 10 Exemplare nötig.',
    }
  }

  async function mailsTo(user: Principal) {
    const [u] = await getDb().select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, user.id))
    return getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, u!.email))
  }

  it('wird erst mit der Zustimmung des Kunden wirksam', async () => {
    const { id } = await placeOrder(customer)
    const confirmed = await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    const before = await getRequestDetail(staff, id)

    const { version } = await proposeChange(staff, await proposal(id, confirmed.version, { copies: 20 }))
    const pending = await getRequestDetail(customer, id)
    expect(pending.status).toBe('on_hold')
    expect(pending.order!.spec.copies).toBe(10)
    expect(pending.totalCents).toBe(before.totalCents)
    expect(pending.proposal!.order.spec.copies).toBe(20)
    expect(pending.proposal!.totalCents).toBeGreaterThan(before.totalCents!)
    // Kunden sehen auch im Vorschlag keinen Rechenweg.
    expect(pending.proposal!.order.price.lines).toEqual([])
    expect(pending.canAnswerProposal).toBe(true)
    expect(pending.transitions).toEqual(['cancelled'])
    expect((await mailsTo(customer)).some((m) => m.subject.startsWith('Änderungsvorschlag'))).toBe(true)

    await answerChange(customer, { id, version, accept: true })
    const after = await getRequestDetail(staff, id)
    expect(after.status).toBe('confirmed')
    expect(after.proposal).toBeNull()
    expect(after.order!.spec.copies).toBe(20)
    expect(after.quantity).toBe(20)
    expect(after.totalCents).toBe(pending.proposal!.totalCents)
    expect(after.events.map((e) => e.type)).toEqual(['created', 'status_changed', 'change_proposed', 'change_accepted'])
    expect((await mailsTo(staff)).some((m) => m.subject.startsWith('Änderung angenommen'))).toBe(true)
  })

  it('lässt bei Ablehnung alles beim Alten', async () => {
    const { id } = await placeOrder(customer)
    const before = await getRequestDetail(staff, id)
    const { version } = await proposeChange(staff, await proposal(id, 1, { duplex: true }))
    await answerChange(customer, { id, version, accept: false })
    const after = await getRequestDetail(staff, id)
    expect(after.status).toBe('on_hold')
    expect(after.proposal).toBeNull()
    expect(after.order).toEqual(before.order)
    expect(after.totalCents).toBe(before.totalCents)
    expect(after.events.at(-1)!.type).toBe('change_rejected')
    // Danach kann der Kunde die Rückfrage wie gewohnt beantworten.
    expect(after.transitions).toEqual(['confirmed', 'rejected'])
  })

  it('weist einen manuellen Preis als Korrektur aus', async () => {
    const { id } = await placeOrder(customer)
    const { version } = await proposeChange(staff, await proposal(id, 1, {}, 1234))
    const staffView = await getRequestDetail(staff, id)
    const line = staffView.proposal!.order.price.lines.at(-1)!
    expect(line.key).toBe('adjustment')
    expect(staffView.proposal!.totalCents).toBe(1234)
    expect(staffView.proposal!.order.price.printCents + staffView.proposal!.order.price.deliveryCents).toBe(1234)
    await answerChange(customer, { id, version, accept: true })
    expect((await getRequestDetail(customer, id)).totalCents).toBe(1234)
    expect((await getRequestDetail(customer, id)).status).toBe('submitted')
  })

  it('lässt nur den Auftraggeber antworten und Statuswechsel nicht am Vorschlag vorbei', async () => {
    const { id } = await placeOrder(customer)
    const { version } = await proposeChange(staff, await proposal(id, 1, { copies: 2 }))
    await expect(answerChange(other, { id, version, accept: true })).rejects.toThrow('Auftrag nicht gefunden')
    await expect(answerChange(staff, { id, version, accept: true })).rejects.toThrow('Nur der Auftraggeber')
    await expect(changeStatus(customer, { id, version, to: 'submitted' })).rejects.toThrow('Änderungsvorschlag')
    await expect(changeStatus(staff, { id, version, to: 'confirmed' })).rejects.toThrow('Änderungsvorschlag')

    const withdrawn = await withdrawChange(staff, { id, version })
    const after = await getRequestDetail(staff, id)
    expect(after.proposal).toBeNull()
    expect(after.order!.spec.copies).toBe(10)
    await changeStatus(staff, { id, version: withdrawn.version, to: 'confirmed' })
  })

  it('verwirft den Vorschlag, wenn der Kunde storniert', async () => {
    const { id } = await placeOrder(customer)
    const { version } = await proposeChange(staff, await proposal(id, 1, { copies: 2 }))
    await changeStatus(customer, { id, version, to: 'cancelled' })
    const after = await getRequestDetail(staff, id)
    expect(after.status).toBe('cancelled')
    expect(after.proposal).toBeNull()
    await expect(proposeChange(staff, await proposal(id, after.version, { copies: 3 }))).rejects.toThrow('abgeschlossen')
  })

  it('erkennt gleichzeitige Vorschläge zweier Mitarbeiter', async () => {
    const { id } = await placeOrder(customer)
    const [a, b] = await Promise.allSettled([
      proposeChange(staff, await proposal(id, 1, { copies: 5 })),
      proposeChange(staff2, await proposal(id, 1, { copies: 7 })),
    ])
    const results = [a, b].map((r) => r.status)
    expect(results.sort()).toEqual(['fulfilled', 'rejected'])
    const failed = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failed.reason as Error).message).toBe(CONFLICT_MESSAGE)
    // Der Kunde antwortet auf einer veralteten Ansicht: Konflikt statt stiller Übernahme.
    const fresh = await getRequestDetail(customer, id)
    await proposeChange(staff, await proposal(id, fresh.version, { copies: 9 }))
    await expect(answerChange(customer, { id, version: fresh.version, accept: true })).rejects.toThrow(CONFLICT_MESSAGE)
  })

  it('lehnt Vorschläge mit veraltetem Preis ab', async () => {
    const { id } = await placeOrder(customer)
    const input = await proposal(id, 1, { copies: 20 })
    await expect(proposeChange(staff, { ...input, expectedTotalCents: input.expectedTotalCents + 1 })).rejects.toThrow(
      'Preis hat sich',
    )
    await expect(proposeChange(customer, input)).rejects.toThrow('Keine Berechtigung')
  })

  it('zeigt Vorher und Nachher', async () => {
    const { id } = await placeOrder(customer)
    await proposeChange(staff, await proposal(id, 1, { copies: 20 }))
    const d = await getRequestDetail(customer, id)
    const rows = compareOrders(d, d.proposal!)
    expect(rows.filter((r) => r.changed).map((r) => r.label)).toEqual(['Exemplare', 'Preis'])
  })
})
