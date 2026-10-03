import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { isoWithOffset, lexwareXml, xmlText, type LexwareOrder } from '~/server/invoices/lexware.server'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'

const order: LexwareOrder = {
  number: 26100042,
  title: 'Skript <Analysis> & Übungen',
  completedAt: new Date('2026-10-02T09:30:00Z'),
  totalCents: 1250,
  deliveryCents: 200,
  deliveryMethod: 'house_post',
  email: 'kundin@example.com',
  billing: {
    firstName: 'Kim',
    lastName: 'Kundin',
    organisation: 'Lehrstuhl für Mathematik',
    street: 'Boltzmannstr. 3',
    zip: '85748',
    city: 'Garching',
    country: '',
  },
  details: [
    ['Format', 'A4'],
    ['Exemplare', '10'],
  ],
}

describe('Lexware-Datei (Issue #53)', () => {
  it('schreibt einen Auftrag im openTRANS-Format für die Shopschnittstelle', () => {
    const xml = lexwareXml([order], { article: 'DRUCK', taxRate: 19 }, new Date('2026-10-02T10:00:00Z'))
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ORDER_LIST>\n<ORDER ')).toBe(true)
    expect(xml).toContain('<ORDER_ID>26100042</ORDER_ID>')
    expect(xml).toContain('<ORDER_DATE>2026-10-02T11:30:00+02:00</ORDER_DATE>')
    expect(xml).toContain('<NAME>Lehrstuhl für Mathematik</NAME>\n<NAME2>Kundin</NAME2>\n<NAME3>Kim</NAME3>')
    expect(xml).toContain('<COUNTRY>Deutschland</COUNTRY>')
    expect(xml).toContain('<SUPPLIER_AID>DRUCK</SUPPLIER_AID>')
    expect(xml).toContain('<DESCRIPTION_SHORT>#26100042 Skript &lt;Analysis&gt; &amp; Übungen</DESCRIPTION_SHORT>')
    expect(xml).toContain('<DESCRIPTION_LONG>Format: A4\nExemplare: 10</DESCRIPTION_LONG>')
    // Druckkosten als Position, Lieferkosten als Versandkosten, zusammen der Endpreis.
    expect(xml).toContain('<PRICE_AMOUNT>10.50</PRICE_AMOUNT>')
    expect(xml).toContain('<TAX>0.19</TAX>')
    expect(xml).toContain('<REMARK type="shipping_fee">2.00</REMARK>')
    expect(xml).toContain('<REMARK type="delivery_method">Lieferung per Hauspost</REMARK>')
    expect(xml).toContain('<TOTAL_AMOUNT>12.50</TOTAL_AMOUNT>')
    expect(xml).toContain('<PRICE_CURRENCY>978</PRICE_CURRENCY>')
  })

  it('übernimmt alte Rechnungsadressen mit nur einem Namensfeld und lässt Versandkosten bei Abholung weg', () => {
    const legacy = {
      ...order,
      deliveryMethod: 'pickup' as const,
      deliveryCents: 0,
      billing: { name: 'Fachschaft MPI', organisation: '', street: 'a', zip: '1', city: 'b', country: 'Österreich' },
    }
    const xml = lexwareXml([legacy, order], { article: 'X-1', taxRate: 7 })
    expect(xml.match(/<ORDER /g)).toHaveLength(2)
    expect(xml).toContain('<NAME2>Fachschaft MPI</NAME2>\n<NAME3></NAME3>')
    expect(xml).toContain('<COUNTRY>Österreich</COUNTRY>')
    expect(xml).toContain('<TAX>0.07</TAX>')
    expect(xml.split('</ORDER>')[0]).not.toContain('shipping_fee')
  })

  it('entfernt in XML verbotene Zeichen', () => {
    expect(xmlText('a\u0001b\tc\n"\'')).toBe('ab\tc\n&quot;&apos;')
  })

  it('rechnet Winter- und Sommerzeit richtig', () => {
    expect(isoWithOffset(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-15T13:00:00+01:00')
    expect(isoWithOffset(new Date('2026-07-15T12:00:00Z'))).toBe('2026-07-15T14:00:00+02:00')
  })
})

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('Übergabe an Lexware', async () => {
  process.env.DATABASE_URL = url
  const { getDb, schema } = await import('~/server/db/client.server')
  const { exportForLexware, pendingLexwareCount, recordInvoice, LexwareExportError } =
    await import('~/server/invoices/lexware.server')
  const { getRequestDetail } = await import('~/server/requests/requests.server')
  type Principal = import('~/server/requests/requests.server').Principal
  const tag = `lexware-${Date.now()}`
  let customer: Principal
  let staff: Principal
  const ids: string[] = []

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
    for (const title of ['Fertig 1', 'Fertig 2', 'Offen']) ids.push((await placeOrder(customer, { title })).id)
    await getDb()
      .update(schema.requests)
      .set({ status: 'completed' })
      .where(inArray(schema.requests.id, ids.slice(0, 2)))
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('exportiert alle fertigen Aufträge einmal und merkt sie als übergeben', async () => {
    expect(await pendingLexwareCount()).toBeGreaterThanOrEqual(2)
    const first = await exportForLexware(staff.id)
    const [one, two] = await getDb()
      .select({ number: schema.requests.number })
      .from(schema.requests)
      .where(inArray(schema.requests.id, ids.slice(0, 2)))
      .orderBy(schema.requests.number)
    expect(first.numbers).toEqual(expect.arrayContaining([one!.number, two!.number]))
    expect(first.xml).toContain('<NAME2>Muster</NAME2>\n<NAME3>Erika</NAME3>')
    expect(first.xml).toContain(`<EMAIL>${tag}-k@test</EMAIL>`)

    const second = await exportForLexware(staff.id)
    expect(second.numbers).not.toContain(one!.number)
    const [row] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, ids[0]!))
    expect(row!.invoiceExportedById).toBe(staff.id)
    expect((await getRequestDetail(staff, ids[0]!)).invoiceExportedAt).toBeInstanceOf(Date)
    expect((await getRequestDetail(customer, ids[0]!)).invoiceExportedAt).toBeNull()
  })

  it('überspringt Aufträge ohne Rechnungsadresse, statt den ganzen Export abzubrechen (Issue #130)', async () => {
    // Mitarbeiter dürfen ohne Rechnungsadresse bestellen.
    const own = await placeOrder(staff, { title: 'Ohne Adresse' })
    const customers = await placeOrder(customer, { title: 'Mit Adresse' })
    await getDb()
      .update(schema.requests)
      .set({ status: 'completed' })
      .where(inArray(schema.requests.id, [own.id, customers.id]))

    const result = await exportForLexware(staff.id)
    expect(result.skipped).toContain(own.number)
    expect(result.numbers).toContain(customers.number)
    expect(result.numbers).not.toContain(own.number)
    const [row] = await getDb().select().from(schema.requests).where(eq(schema.requests.id, own.id))
    expect(row!.invoiceExportedAt).toBeNull()
    // Gezielt angefordert bleibt es ein Fehler.
    await expect(exportForLexware(staff.id, [own.id])).rejects.toBeInstanceOf(LexwareExportError)
  })

  it('exportiert einzelne Aufträge erneut, aber nur fertige', async () => {
    const again = await exportForLexware(staff.id, [ids[0]!])
    expect(again.count).toBe(1)
    expect(again.xml).toContain('Fertig 1')
    await expect(exportForLexware(staff.id, [ids[2]!])).rejects.toBeInstanceOf(LexwareExportError)
  })

  it('trägt die in Lexware angelegte Rechnung ein und nimmt sie wieder zurück (Issue #157)', async () => {
    await recordInvoice(staff.id, { id: ids[0]!, created: true, invoiceNumber: 'RE-2026-0042' })
    const detail = await getRequestDetail(staff, ids[0]!)
    expect(detail).toMatchObject({ invoiceNumber: 'RE-2026-0042', invoiceCreatedByName: 'Staff' })
    expect(detail.invoiceCreatedAt).toBeInstanceOf(Date)
    expect(detail.events.some((e) => e.type === 'invoice_recorded')).toBe(true)
    const forCustomer = await getRequestDetail(customer, ids[0]!)
    expect(forCustomer).toMatchObject({ invoiceCreatedAt: null, invoiceNumber: null })
    expect(forCustomer.events.some((e) => e.type === 'invoice_recorded')).toBe(false)

    await recordInvoice(staff.id, { id: ids[0]!, created: false, invoiceNumber: '' })
    expect(await getRequestDetail(staff, ids[0]!)).toMatchObject({ invoiceCreatedAt: null, invoiceNumber: null })
    await expect(recordInvoice(staff.id, { id: ids[2]!, created: true, invoiceNumber: 'RE-1' })).rejects.toThrow('fertige')
    // Die Rechnungsnummer aus Lexware ist Pflicht.
    await expect(recordInvoice(staff.id, { id: ids[0]!, created: true, invoiceNumber: '' })).rejects.toThrow('Rechnungsnummer')
  })

  it('zählt von Hand angelegte Rechnungen nicht mehr als offen und exportiert sie nicht (Issue #157)', async () => {
    const manual = await placeOrder(customer, { title: 'Von Hand' })
    await getDb().update(schema.requests).set({ status: 'completed' }).where(eq(schema.requests.id, manual.id))
    const before = await pendingLexwareCount()
    await recordInvoice(staff.id, { id: manual.id, created: true, invoiceNumber: 'RE-2026-0043' })
    expect(await pendingLexwareCount()).toBe(before - 1)
    expect((await exportForLexware(staff.id)).numbers).not.toContain(manual.number)
  })
})
