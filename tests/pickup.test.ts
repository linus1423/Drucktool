import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { DEFAULT_DEADLINE_SETTINGS, attentionFor } from '~/lib/deadlines'
import { pickupReminderMail } from '~/server/mail/templates'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const DAY = 86_400_000

describe('Abholung (Issue #173)', () => {
  const now = new Date('2026-10-10T10:00:00Z')
  const base = {
    status: 'completed' as const,
    promisedDate: null,
    statusChangedAt: new Date(now.getTime() - 8 * DAY),
    deliveryMethod: 'pickup' as const,
    handedOverAt: null,
  }

  it('hebt nicht abgeholte Abholaufträge nach der eingestellten Frist hervor', () => {
    expect(attentionFor(base, DEFAULT_DEADLINE_SETTINGS, now)).toBe('not_picked_up')
    expect(attentionFor(base, { ...DEFAULT_DEADLINE_SETTINGS, pickupReminderDays: 10 }, now)).toBeNull()
    expect(attentionFor({ ...base, handedOverAt: now }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
    // Hauspost holt niemand ab, und ohne handedOverAt (Kundenansicht) gibt es keinen Hinweis.
    expect(attentionFor({ ...base, deliveryMethod: 'house_post' }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
    expect(attentionFor({ ...base, handedOverAt: undefined }, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
  })

  it('erinnert mit Datum und Link an die Abholung', () => {
    const mail = pickupReminderMail({
      id: 'abc',
      number: 26100001,
      title: 'Skript',
      completedAt: new Date('2026-10-01T10:00:00Z'),
      now,
    })
    expect(mail.subject).toBe('Erinnerung: #26100001 Skript liegt zur Abholung bereit')
    expect(mail.text).toContain('seit 01.10.2026 fertig')
    expect(mail.text).toContain('/auftraege/abc')
    expect(mail.template).toMatchObject({ key: 'pickup_reminder', vars: { tage: '9' } })
  })
})

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('Abholung erfassen und erinnern (Integration)', async () => {
  process.env.DATABASE_URL = url
  const { getDb, schema } = await import('~/server/db/client.server')
  const { getRequestDetail, listBoard, listRequests } = await import('~/server/requests/requests.server')
  const { recordHandover } = await import('~/server/requests/handover.server')
  const { sendPickupReminders } = await import('~/server/requests/pickup-reminders.server')
  const { getDeadlineSettings } = await import('~/server/catalog/catalog.server')
  type Principal = import('~/server/requests/requests.server').Principal
  const tag = `abholung-${Date.now()}`
  let customer: Principal
  let staff: Principal

  /** Fertiger Auftrag, der seit `daysAgo` Tagen in der Druckerei liegt. */
  async function completedOrder(title: string, daysAgo = 1, deliveryMethod: 'pickup' | 'house_post' = 'pickup') {
    const { id } = await placeOrder(customer, { title: `${tag} ${title}` })
    await getDb()
      .update(schema.requests)
      .set({ status: 'completed', deliveryMethod, statusChangedAt: new Date(Date.now() - daysAgo * DAY) })
      .where(eq(schema.requests.id, id))
    return id
  }

  const mailsTo = (to: string) => getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, to))

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

  it('markiert als abgeholt, zeigt es im Verlauf und lässt sich zurücknehmen', async () => {
    const id = await completedOrder('abholen')
    await recordHandover(staff.id, { id, handedOver: true })
    const detail = await getRequestDetail(staff, id)
    expect(detail.status).toBe('completed')
    expect(detail.handedOverAt).toBeInstanceOf(Date)
    expect(detail.handedOverByName).toBe('Staff')
    // Kunden sehen, wann ihr Auftrag abgeholt wurde.
    const forCustomer = await getRequestDetail(customer, id)
    expect(forCustomer.handedOverAt).toBeInstanceOf(Date)
    expect(forCustomer.events.find((e) => e.type === 'handed_over')?.data).toMatchObject({
      handedOver: true,
      deliveryMethod: 'pickup',
    })
    await expect(recordHandover(staff.id, { id, handedOver: true })).rejects.toThrow('bereits als „Abgeholt“')

    await recordHandover(staff.id, { id, handedOver: false })
    const undone = await getRequestDetail(staff, id)
    expect(undone).toMatchObject({ handedOverAt: null, handedOverByName: null })
    expect(undone.events.filter((e) => e.type === 'handed_over').map((e) => e.data.handedOver)).toEqual([true, false])
  })

  it('erfasst nur fertige Aufträge', async () => {
    const { id } = await placeOrder(customer, { title: `${tag} offen` })
    await expect(recordHandover(staff.id, { id, handedOver: true })).rejects.toThrow('nur bei fertigen Aufträgen')
  })

  it('filtert Liste und Board auf „Liegt zur Abholung bereit“', async () => {
    const ready = await completedOrder('filter bereit', 30)
    const post = await completedOrder('filter hauspost', 1, 'house_post')
    const done = await completedOrder('filter erledigt')
    await recordHandover(staff.id, { id: done, handedOver: true })

    const list = await listRequests(staff, { search: `${tag} filter`, readyForPickup: true })
    expect(list.rows.map((r) => r.id).sort()).toEqual([ready, post].sort())
    const board = await listBoard(staff, { search: `${tag} filter`, ready: true })
    // Auch Aufträge, die länger als die 14 Tage des Boards fertig sind.
    expect(board.rows.map((r) => r.id).sort()).toEqual([ready, post].sort())
    expect((await listBoard(staff, { search: `${tag} filter` })).rows.map((r) => r.id)).not.toContain(ready)

    // „Nicht abgeholt“ ist ein interner Hinweis.
    const staffRow = (await listRequests(staff, { search: `${tag} filter bereit` })).rows[0]!
    expect(staffRow.attention).toBe('not_picked_up')
    expect((await listRequests(customer, { search: `${tag} filter bereit` })).rows[0]!.attention).toBeNull()
    expect((await getRequestDetail(staff, ready)).attention).toBe('not_picked_up')
    expect((await getRequestDetail(customer, ready)).attention).toBeNull()
  })

  it('erinnert den Kunden einmal an nicht abgeholte Aufträge', async () => {
    const due = await completedOrder('erinnern', 8)
    const fresh = await completedOrder('frisch', 2)
    const post = await completedOrder('post', 8, 'house_post')
    const picked = await completedOrder('abgeholt', 8)
    await recordHandover(staff.id, { id: picked, handedOver: true })
    const ids = [due, fresh, post, picked]
    // Andere Tests lassen ebenfalls fertige Aufträge liegen; gezählt werden nur die Mails zu diesen Aufträgen.
    const mailsFor = async () =>
      (await mailsTo(`${tag}-k@test`)).filter((m) => m.subject.startsWith('Erinnerung:') && ids.some((id) => m.text.includes(id)))

    await sendPickupReminders(getDb())
    const mails = await mailsFor()
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toMatch(/^Erinnerung: #\d+ .* erinnern liegt zur Abholung bereit$/)
    expect(mails[0]!.text).toContain(`/auftraege/${due}`)

    const detail = await getRequestDetail(staff, due)
    expect(detail.pickupReminderSentAt).toBeInstanceOf(Date)
    expect(detail.events.find((e) => e.type === 'pickup_reminder_sent')?.data).toMatchObject({ emailed: true })
    // Intern: Kunden sehen weder Zeitpunkt noch Verlaufseintrag der Erinnerung.
    const forCustomer = await getRequestDetail(customer, due)
    expect(forCustomer.pickupReminderSentAt).toBeNull()
    expect(forCustomer.events.some((e) => e.type === 'pickup_reminder_sent')).toBe(false)
    for (const id of [fresh, post, picked]) expect((await getRequestDetail(staff, id)).pickupReminderSentAt).toBeNull()

    // Nur einmal, auch wenn die Abholung erfasst und wieder zurückgenommen wird.
    await recordHandover(staff.id, { id: due, handedOver: true })
    await recordHandover(staff.id, { id: due, handedOver: false })
    await sendPickupReminders(getDb())
    expect(await mailsFor()).toHaveLength(1)
  })

  it('verschickt ohne Benachrichtigungen keine Mail, vermerkt die Fälligkeit aber im Verlauf', async () => {
    await getDb().update(schema.users).set({ emailNotifications: false }).where(eq(schema.users.id, customer.id))
    try {
      const id = await completedOrder('stumm', 9)
      const before = (await mailsTo(`${tag}-k@test`)).length
      await sendPickupReminders(getDb())
      expect((await mailsTo(`${tag}-k@test`)).length).toBe(before)
      const detail = await getRequestDetail(staff, id)
      expect(detail.pickupReminderSentAt).toBeInstanceOf(Date)
      expect(detail.events.find((e) => e.type === 'pickup_reminder_sent')?.data).toMatchObject({ emailed: false })
    } finally {
      await getDb().update(schema.users).set({ emailNotifications: true }).where(eq(schema.users.id, customer.id))
    }
  })

  it('ergänzt die neue Frist bei älteren gespeicherten Einstellungen', async () => {
    const rollback = new Error('rollback')
    await expect(
      getDb().transaction(async (tx) => {
        const old = { staleSubmittedDays: 3, staleOnHoldDays: 4, staleConfirmedDays: 5 }
        await tx
          .insert(schema.settings)
          .values({ key: 'deadlines', value: old })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value: old } })
        expect(await getDeadlineSettings(tx)).toEqual({ ...old, pickupReminderDays: 7 })
        throw rollback
      }),
    ).rejects.toBe(rollback)
  })
})
