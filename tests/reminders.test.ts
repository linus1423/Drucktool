import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { DEFAULT_DEADLINE_SETTINGS, deadlineSettingsSchema } from '~/lib/deadlines'
import { calculatePrice } from '~/lib/pricing'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { getDb, schema } = await import('~/server/db/client.server')
const { getCatalog } = await import('~/server/catalog/catalog.server')
const { getRequestDetail, proposeChange } = await import('~/server/requests/requests.server')
const { dueReminder, sendWaitingReminders } = await import('~/server/requests/reminders.server')
type Principal = import('~/server/requests/requests.server').Principal

const DAY = 86_400_000
const ago = (days: number, now = new Date()) => new Date(now.getTime() - days * DAY)

describe('Erinnerungen an Kunden (Issue #174)', () => {
  const now = new Date('2026-10-01T10:00:00Z')
  const settings = { ...DEFAULT_DEADLINE_SETTINGS, remindOnHoldDays: 5, remindOfferedDays: 7, remindProposalDays: 3 }
  const base = { status: 'on_hold' as const, statusChangedAt: ago(6, now), proposedAt: null, remindedAt: null }

  it('sind ohne Einstellung aus, auch bei älteren gespeicherten Fristen', () => {
    expect(dueReminder(base, DEFAULT_DEADLINE_SETTINGS, now)).toBeNull()
    const old = deadlineSettingsSchema.parse({
      staleSubmittedDays: 2,
      staleOnHoldDays: 5,
      staleConfirmedDays: 10,
      pickupReminderDays: 7,
    })
    expect(old.remindOnHoldDays).toBe(0)
    expect(deadlineSettingsSchema.safeParse({ ...old, remindOfferedDays: -1 }).success).toBe(false)
  })

  it('werden nach der eingestellten Zahl von Tagen fällig', () => {
    expect(dueReminder(base, settings, now)).toMatchObject({ kind: 'on_hold', days: 6 })
    expect(dueReminder({ ...base, statusChangedAt: ago(4, now) }, settings, now)).toBeNull()
    expect(dueReminder({ ...base, status: 'offered' }, settings, now)).toBeNull()
    expect(dueReminder({ ...base, status: 'offered', statusChangedAt: ago(8, now) }, settings, now)).toMatchObject({
      kind: 'offered',
    })
    // Andere Status kennen keine Erinnerung.
    expect(dueReminder({ ...base, status: 'confirmed', statusChangedAt: ago(30, now) }, settings, now)).toBeNull()
  })

  it('kommen höchstens einmal je Wartephase', () => {
    expect(dueReminder({ ...base, remindedAt: ago(1, now) }, settings, now)).toBeNull()
    // Eine Erinnerung aus einer früheren Phase zählt nicht.
    expect(dueReminder({ ...base, remindedAt: ago(10, now) }, settings, now)).toMatchObject({ kind: 'on_hold' })
  })

  it('richten sich bei offenem Änderungsvorschlag nach dem Vorschlag', () => {
    const proposedAt = ago(4, now).toISOString()
    // Die Rückfrage-Erinnerung ist schon verschickt, der neuere Vorschlag beginnt eine neue Phase.
    const r = { ...base, statusChangedAt: ago(20, now), proposedAt, remindedAt: ago(10, now) }
    expect(dueReminder(r, settings, now)).toMatchObject({ kind: 'proposal', days: 4 })
    expect(dueReminder(r, { ...settings, remindProposalDays: 0 }, now)).toBeNull()
  })
})

describe.skipIf(!url)('Erinnerungsmails aus dem stündlichen Job (Issue #174)', () => {
  let customer: Principal
  let quiet: Principal
  let staff: Principal
  let customerEmail: string
  // Nur die hier zurückdatierten Aufträge sind so lange offen; Aufträge anderer Tests bleiben unberührt.
  const settings = { ...DEFAULT_DEADLINE_SETTINGS, remindOnHoldDays: 30, remindOfferedDays: 30, remindProposalDays: 30 }

  beforeAll(async () => {
    const stamp = Date.now()
    customerEmail = `r-kunde-${stamp}@test`
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: customerEmail, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        {
          email: `r-still-${stamp}@test`,
          lastName: 'Still',
          role: 'customer',
          status: 'active',
          billingAddress: BILLING,
          emailNotifications: false,
        },
        { email: `r-staff-${stamp}@test`, lastName: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    quiet = { id: rows[1]!.id, role: 'customer' }
    staff = { id: rows[2]!.id, role: 'staff' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function reminders() {
    const mails = await getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, customerEmail))
    return mails.filter((m) => m.subject.startsWith('Erinnerung'))
  }

  async function setRequest(id: string, values: Partial<typeof schema.requests.$inferInsert>) {
    await getDb().update(schema.requests).set(values).where(eq(schema.requests.id, id))
  }

  it('erinnert an eine Rückfrage einmal und schreibt es in den Verlauf', async () => {
    const { id } = await placeOrder(customer)
    await setRequest(id, { status: 'on_hold', statusChangedAt: ago(31) })

    await sendWaitingReminders(getDb(), { settings })
    let mails = await reminders()
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toContain('Rückfrage')
    expect(mails[0]!.text).toContain('vor 31 Tagen')
    expect(mails[0]!.text).toContain(`/auftraege/${id}`)

    const detail = await getRequestDetail(customer, id)
    const event = detail.events.find((e) => e.type === 'reminder_sent')
    expect(event).toMatchObject({ actorName: null, data: { kind: 'on_hold', days: 31 } })
    // Version unverändert: Mitarbeiter mit offenem Auftrag bekommen keinen Konflikt.
    expect(detail.version).toBe(1)

    // Der nächste Lauf erinnert in derselben Phase nicht noch einmal.
    await sendWaitingReminders(getDb(), { settings })
    expect(await reminders()).toHaveLength(1)

    // Neue Wartephase (z. B. erneute Rückfrage) nach der letzten Erinnerung: wieder eine Erinnerung.
    await setRequest(id, { remindedAt: ago(40), statusChangedAt: ago(32) })
    await sendWaitingReminders(getDb(), { settings })
    mails = await reminders()
    expect(mails).toHaveLength(2)
  })

  it('erinnert an Angebot und Änderungsvorschlag mit eigener Vorlage', async () => {
    const offer = await placeOrder(customer)
    await setRequest(offer.id, { status: 'offered', statusChangedAt: ago(31) })
    const changed = await placeOrder(customer)
    const detail0 = await getRequestDetail(staff, changed.id)
    const spec = { ...detail0.order!.spec, copies: 20 }
    const priced = calculatePrice(await getCatalog({ onlyAvailable: true }), spec)
    if (!priced.ok) throw new Error(priced.errors.join(' '))
    await proposeChange(staff, {
      id: changed.id,
      version: 1,
      spec,
      deliveryAddress: null,
      priceOverrideCents: null,
      expectedTotalCents: priced.price.totalCents,
      reason: 'Bitte 20 statt 10 Exemplare.',
    })
    await getDb().execute(
      sql`update requests set status_changed_at = ${ago(31).toISOString()}::timestamptz, proposal = jsonb_set(proposal, '{proposedAt}', to_jsonb(${ago(31).toISOString()}::text)) where id = ${changed.id}`,
    )

    await sendWaitingReminders(getDb(), { settings })
    const mails = await reminders()
    const offerMail = mails.find((m) => m.subject.includes('Angebot'))
    expect(offerMail?.text).toContain(customerEmail)
    const proposalMail = mails.find((m) => m.subject.includes('Änderungsvorschlag'))
    expect(proposalMail?.text).toContain('Bitte 20 statt 10 Exemplare.')
    const detail = await getRequestDetail(customer, changed.id)
    expect(detail.events.find((e) => e.type === 'reminder_sent')?.data).toMatchObject({ kind: 'proposal' })
  })

  it('schreibt nicht an Kunden, die Benachrichtigungen abgeschaltet haben, und ist mit 0 aus', async () => {
    const { id } = await placeOrder(quiet)
    await setRequest(id, { status: 'on_hold', statusChangedAt: ago(31) })
    await sendWaitingReminders(getDb(), { settings: { ...settings, remindOnHoldDays: 0 } })
    const [untouched] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, id))
    expect(untouched!.remindedAt).toBeNull()

    await sendWaitingReminders(getDb(), { settings })
    const detail = await getRequestDetail(quiet, id)
    expect(detail.events.some((e) => e.type === 'reminder_sent')).toBe(false)
    const [row] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, id))
    expect(row!.remindedAt).not.toBeNull()
  })
})
