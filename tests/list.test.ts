import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { BILLING } from './fixtures'
import { placeOrder } from './order-fixture'
import { csvCell, toCsv } from '~/server/requests/export.server'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

describe('CSV-Export', () => {
  it('entschärft Formeln und maskiert Trennzeichen', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+49 89')).toBe("'+49 89")
    expect(csvCell('-5')).toBe("'-5")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell(null)).toBe('')
    expect(toCsv(['A', 'B'], [[1, 'x']])).toBe('\uFEFFA;B\r\n1;x\r\n')
  })
})

describe.skipIf(!url)('Auftragsliste (Integration)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { listRequests, assignRequest } = await import('~/server/requests/requests.server')
  const { requestsCsv } = await import('~/server/requests/export.server')
  type Principal = import('~/server/requests/requests.server').Principal

  let customer: Principal
  let other: Principal
  let staff: Principal
  const tag = `liste-${Date.now()}`
  const ids: string[] = []

  beforeAll(async () => {
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `${tag}-k@test`, name: 'Listenkundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-f@test`, name: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `${tag}-s@test`, name: 'Listenstaff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    other = { id: rows[1]!.id, role: 'customer' }
    staff = { id: rows[2]!.id, role: 'staff' }
    for (let i = 0; i < 30; i++)
      ids.push((await placeOrder(customer, { title: `${tag} ${String(i).padStart(2, '0')}`, spec: { copies: i + 1 } })).id)
    await placeOrder(other, { title: `${tag} fremd` })
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  it('blättert seitenweise und zählt alle Treffer', async () => {
    const first = await listRequests(customer, { search: tag, pageSize: 25, sort: 'title', dir: 'asc' })
    expect(first.total).toBe(30)
    expect(first.rows).toHaveLength(25)
    const second = await listRequests(customer, { search: tag, pageSize: 25, page: 2, sort: 'title', dir: 'asc' })
    expect(second.rows.map((r) => r.title)).toEqual(['25', '26', '27', '28', '29'].map((n) => `${tag} ${n}`))
    // Keine Überschneidung zwischen den Seiten
    expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(30)
  })

  it('zeigt Kunden auch beim Blättern nur eigene Aufträge', async () => {
    const all = await listRequests(other, { search: tag, pageSize: 100 })
    expect(all.total).toBe(1)
    expect(all.rows[0]!.title).toBe(`${tag} fremd`)
    expect((await listRequests(staff, { search: tag, pageSize: 100 })).total).toBe(31)
  })

  it('sortiert serverseitig nach Preis', async () => {
    const asc = await listRequests(customer, { search: tag, sort: 'total', dir: 'asc', pageSize: 100 })
    const totals = asc.rows.map((r) => r.totalCents!)
    expect(totals).toEqual([...totals].sort((a, b) => a - b))
    const desc = await listRequests(customer, { search: tag, sort: 'total', dir: 'desc', pageSize: 25 })
    expect(desc.rows[0]!.totalCents).toBe(Math.max(...totals))
  })

  it('filtert nach Zuständigem und Zeitraum', async () => {
    await assignRequest(staff, { id: ids[0]!, version: 1, assigneeId: staff.id })
    const mine = await listRequests(staff, { search: tag, assigneeId: staff.id })
    expect(mine.rows.map((r) => r.id)).toEqual([ids[0]])
    expect((await listRequests(staff, { search: tag, assigneeId: 'none', pageSize: 100 })).total).toBe(30)
    // Kunden können nicht nach Zuständigem filtern; der Filter wird ignoriert.
    expect((await listRequests(customer, { search: tag, assigneeId: staff.id, pageSize: 100 })).total).toBe(30)

    await getDb()
      .update(schema.requests)
      .set({ createdAt: new Date('2025-03-10T23:30:00Z') }) // 11.03. in deutscher Zeit
      .where(eq(schema.requests.id, ids[1]!))
    const day = await listRequests(staff, { search: tag, from: '2025-03-11', to: '2025-03-11' })
    expect(day.rows.map((r) => r.id)).toEqual([ids[1]])
    expect((await listRequests(staff, { search: tag, to: '2025-03-10' })).total).toBe(0)
  })

  it('exportiert die gefilterten Aufträge als CSV', async () => {
    const csv = await requestsCsv(staff, { search: tag, sort: 'number', dir: 'asc' })
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe(
      'Nummer;Titel;Kunde;E-Mail;Organisation;Status;Interner Status;Exemplare;Preis (EUR);Lieferung;Zuständig;Angelegt;Zuletzt geändert',
    )
    expect(lines).toHaveLength(32)
    expect(lines[1]).toContain(`${tag} 00;Listenkundin;${tag}-k@test;;Eingereicht;;1;`)
    // Kunden bekommen nur eigene Aufträge und keine internen Spalten.
    const own = await requestsCsv(customer, { search: tag })
    expect(own.split('\r\n')[0]).not.toContain('Zuständig')
    expect(own).not.toContain('fremd')
  })

  afterAll(async () => {
    await getDb().delete(schema.requests).where(inArray(schema.requests.id, ids))
  })
})
