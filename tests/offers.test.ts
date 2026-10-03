import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import { canTransition } from '~/lib/status'
import { BILLING } from './fixtures'
import { orderInput } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

const { getDb, schema } = await import('~/server/db/client.server')
const { acceptOffer, changeStatus, createOffer, getRequestDetail, proposeChange } =
  await import('~/server/requests/requests.server')
type Principal = import('~/server/requests/requests.server').Principal

describe('Status „Angebot“ (Issue #165)', () => {
  it('kann nur zurückgezogen bzw. abgelehnt werden; angenommen wird über acceptOffer', () => {
    expect(canTransition('offered', 'cancelled', 'staff')).toBe(true)
    expect(canTransition('offered', 'cancelled', 'customer')).toBe(true)
    expect(canTransition('offered', 'confirmed', 'staff')).toBe(false)
    expect(canTransition('offered', 'submitted', 'customer')).toBe(false)
  })
})

describe.skipIf(!url)('Angebot durch Mitarbeiter (Issue #165)', () => {
  let staff: Principal
  let other: Principal
  let stamp: number

  beforeAll(async () => {
    stamp = Date.now()
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `o-staff-${stamp}@test`, firstName: 'Max', lastName: 'Druck', role: 'staff', status: 'active' },
        { email: `o-fremd-${stamp}@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
      ])
      .returning()
    staff = { id: rows[0]!.id, role: 'staff' }
    other = { id: rows[1]!.id, role: 'customer' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  async function offerInput(email: string, overrides: { priceOverrideCents?: number | null; priceReason?: string } = {}) {
    const { acceptTerms: _a, organisationId: _o, ...rest } = await orderInput(staff, { title: 'Plakat' })
    return {
      ...rest,
      customer: { email, firstName: 'Erika', lastName: 'Muster' },
      priceOverrideCents: overrides.priceOverrideCents ?? null,
      priceReason: overrides.priceReason ?? '',
    }
  }

  async function userByEmail(email: string) {
    const [u] = await getDb()
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email}`)
    return u
  }

  async function mailsTo(email: string) {
    return getDb().select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, email))
  }

  it('legt für eine neue Adresse ein Kundenkonto an und schickt das Angebot', async () => {
    const email = `o-neu-${stamp}@test`
    const created = await createOffer(staff, await offerInput(email.toUpperCase()))
    expect(created.newCustomer).toBe(true)

    const customer = await userByEmail(email)
    expect(customer).toMatchObject({ role: 'customer', status: 'active', firstName: 'Erika', lastName: 'Muster' })
    expect(customer!.billingAddress).toBeNull()

    const detail = await getRequestDetail(staff, created.id)
    expect(detail.status).toBe('offered')
    expect(detail.createdById).toBe(customer!.id)
    expect(detail.offeredById).toBe(staff.id)
    expect(detail.assigneeId).toBe(staff.id)
    expect(detail.offeredByName).toBe('Max Druck')
    expect(detail.files).toHaveLength(1)
    expect(detail.events.map((e) => e.type)).toEqual(['offer_created'])

    const mails = await mailsTo(email)
    expect(mails).toHaveLength(1)
    expect(mails[0]!.subject).toContain('Angebot')
    expect(mails[0]!.text).toContain(email)
  })

  it('nutzt ein bestehendes Konto und überschreibt dessen Namen nicht', async () => {
    const email = `o-alt-${stamp}@test`
    await getDb().insert(schema.users).values({ email, firstName: 'Eri', lastName: 'Ka', role: 'customer', status: 'active' })
    const created = await createOffer(staff, await offerInput(email))
    expect(created.newCustomer).toBe(false)
    expect(await userByEmail(email)).toMatchObject({ firstName: 'Eri', lastName: 'Ka' })
  })

  it('geht nicht an Mitarbeiter und nur von Mitarbeitern aus', async () => {
    await expect(createOffer(staff, await offerInput(`o-staff-${stamp}@test`))).rejects.toThrow('Mitarbeiter')
    await expect(createOffer(other, await offerInput(`o-x-${stamp}@test`))).rejects.toThrow('Keine Berechtigung')
  })

  it('übernimmt einen manuell gesetzten Preis', async () => {
    const created = await createOffer(
      staff,
      await offerInput(`o-preis-${stamp}@test`, { priceOverrideCents: 1234, priceReason: 'Stammkundenrabatt' }),
    )
    const detail = await getRequestDetail(staff, created.id)
    expect(detail.totalCents).toBe(1234)
    expect(detail.order!.price.lines.at(-1)).toMatchObject({ key: 'adjustment', detail: 'Stammkundenrabatt' })
  })

  it('wird mit Rechnungsadresse und Bedingungen vom Kunden angenommen und ist dann bestätigt', async () => {
    const email = `o-annahme-${stamp}@test`
    const created = await createOffer(staff, await offerInput(email))
    const customer: Principal = { id: (await userByEmail(email))!.id, role: 'customer' }

    const offered = await getRequestDetail(customer, created.id)
    expect(offered.canAcceptOffer).toBe(true)
    expect(offered.transitions).toEqual(['cancelled'])
    // Andere Kunden sehen das Angebot nicht, Mitarbeiter nehmen es nicht für den Kunden an.
    await expect(acceptOffer(other, { id: created.id, version: 1, acceptTerms: true })).rejects.toThrow('nicht gefunden')
    await expect(acceptOffer(staff, { id: created.id, version: 1, acceptTerms: true })).rejects.toThrow('Nur der Kunde')

    await expect(acceptOffer(customer, { id: created.id, version: 1, acceptTerms: true })).rejects.toThrow('Rechnungsadresse')
    await getDb().update(schema.users).set({ billingAddress: BILLING }).where(eq(schema.users.id, customer.id))
    await expect(acceptOffer(customer, { id: created.id, version: 2, acceptTerms: true })).rejects.toThrow(CONFLICT_MESSAGE)

    const result = await acceptOffer(customer, { id: created.id, version: 1, acceptTerms: true })
    expect(result.status).toBe('confirmed')
    const detail = await getRequestDetail(staff, created.id)
    expect(detail.billingAddress).toEqual(BILLING)
    expect(detail.termsAcceptedAt).not.toBeNull()
    expect(detail.confirmedById).toBe(staff.id)
    expect(detail.events.map((e) => e.type)).toEqual(['offer_created', 'offer_accepted'])
    expect((await mailsTo(`o-staff-${stamp}@test`)).some((m) => m.subject.includes('Bestätigt'))).toBe(true)

    await expect(acceptOffer(customer, { id: created.id, version: result.version, acceptTerms: true })).rejects.toThrow(
      'kein offenes Angebot',
    )
  })

  it('kann vom Kunden abgelehnt und von der Druckerei zurückgezogen, aber nicht geändert werden', async () => {
    const email = `o-ablehnen-${stamp}@test`
    const declined = await createOffer(staff, await offerInput(email))
    const customer: Principal = { id: (await userByEmail(email))!.id, role: 'customer' }
    expect((await changeStatus(customer, { id: declined.id, version: 1, to: 'cancelled' })).status).toBe('cancelled')

    const withdrawn = await createOffer(staff, await offerInput(email))
    const detail = await getRequestDetail(staff, withdrawn.id)
    await expect(
      proposeChange(staff, {
        id: withdrawn.id,
        version: 1,
        spec: detail.order!.spec,
        deliveryAddress: null,
        priceOverrideCents: null,
        expectedTotalCents: detail.totalCents!,
        reason: 'Mehr Exemplare',
      }),
    ).rejects.toThrow('Angebot')
    await expect(changeStatus(staff, { id: withdrawn.id, version: 1, to: 'confirmed' })).rejects.toThrow('nicht erlaubt')
    expect((await changeStatus(staff, { id: withdrawn.id, version: 1, to: 'cancelled' })).status).toBe('cancelled')
  })
})
