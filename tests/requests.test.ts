import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONFLICT_MESSAGE } from '~/lib/errors'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

// Die Module lesen DATABASE_URL beim ersten Zugriff, deshalb dynamisch importieren.
const { getDb, schema } = await import('~/server/db/client.server')
const requestsModule = await import('~/server/requests/requests.server')
const { addComment, assignRequest, changeStatus, createRequest, getRequestDetail, listRequests, updateRequest } = requestsModule
type Principal = import('~/server/requests/requests.server').Principal

describe.skipIf(!url)('Anfragen (Integration)', () => {
  let staff: Principal
  let customer: Principal
  let otherCustomer: Principal

  beforeAll(async () => {
    const db = getDb()
    const [orgA, orgB] = await db
      .insert(schema.organisations)
      .values([
        { name: 'Kunde A', status: 'active' },
        { name: 'Kunde B', status: 'active' },
      ])
      .returning()
    const stamp = Date.now()
    const [s, c, o] = await db
      .insert(schema.users)
      .values([
        { email: `staff${stamp}@test`, name: 'Mitarbeiterin', role: 'staff', status: 'active' },
        { email: `a${stamp}@test`, name: 'Kunde A', role: 'customer', status: 'active', organisationId: orgA!.id },
        { email: `b${stamp}@test`, name: 'Kunde B', role: 'customer', status: 'active', organisationId: orgB!.id },
      ])
      .returning()
    staff = { id: s!.id, role: 'staff', organisationId: null }
    customer = { id: c!.id, role: 'customer', organisationId: orgA!.id }
    otherCustomer = { id: o!.id, role: 'customer', organisationId: orgB!.id }
  })

  afterAll(async () => {
    // Verbindung schließen, damit Vitest beendet.
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  const input = { title: 'Visitenkarten', description: '', quantity: 250, desiredDate: null }

  it('legt eine Anfrage für die eigene Organisation an', async () => {
    const created = await createRequest(customer, input)
    const detail = await getRequestDetail(customer, created.id)
    expect(detail.status).toBe('new')
    expect(detail.organisationId).toBe(customer.organisationId)
    expect(detail.version).toBe(1)
    expect(detail.events.map((e) => e.type)).toEqual(['created'])
  })

  it('verbirgt Anfragen anderer Organisationen', async () => {
    const created = await createRequest(customer, input)
    await expect(getRequestDetail(otherCustomer, created.id)).rejects.toThrow('Anfrage nicht gefunden')
    await expect(addComment(otherCustomer, { id: created.id, body: 'hallo', internal: false })).rejects.toThrow()
    const list = await listRequests(otherCustomer, {})
    expect(list.find((r) => r.id === created.id)).toBeUndefined()
  })

  it('lehnt veraltete Versionen ab (Optimistic Locking)', async () => {
    const { id } = await createRequest(customer, input)
    const first = await changeStatus(staff, { id, version: 1, to: 'in_review' })
    expect(first.version).toBe(2)
    await expect(changeStatus(staff, { id, version: 1, to: 'rejected' })).rejects.toThrow(CONFLICT_MESSAGE)
    await expect(updateRequest(staff, { id, version: 1, ...input, title: 'Neu' })).rejects.toThrow(CONFLICT_MESSAGE)
    await expect(assignRequest(staff, { id, version: 1, assigneeId: staff.id })).rejects.toThrow(CONFLICT_MESSAGE)
  })

  it('lässt bei gleichzeitigen Änderungen genau eine gewinnen', async () => {
    const { id } = await createRequest(customer, input)
    const results = await Promise.allSettled([
      changeStatus(staff, { id, version: 1, to: 'in_review' }),
      changeStatus(staff, { id, version: 1, to: 'rejected' }),
      changeStatus(customer, { id, version: 1, to: 'cancelled' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const detail = await getRequestDetail(staff, id)
    expect(detail.version).toBe(2)
    expect(detail.events.filter((e) => e.type === 'status_changed')).toHaveLength(1)
  })

  it('setzt die Status-Rechte durch', async () => {
    const { id } = await createRequest(customer, input)
    await expect(changeStatus(customer, { id, version: 1, to: 'in_review' })).rejects.toThrow('nicht erlaubt')
    await changeStatus(staff, { id, version: 1, to: 'in_review' })
    await expect(changeStatus(staff, { id, version: 2, to: 'quoted' })).rejects.toThrow('Angebotspreis')
    await changeStatus(staff, { id, version: 2, to: 'quoted', quoteAmountCents: 12_345 })
    const res = await changeStatus(customer, { id, version: 3, to: 'approved' })
    expect(res.status).toBe('approved')
    await expect(changeStatus(customer, { id, version: 4, to: 'cancelled' })).rejects.toThrow('nicht erlaubt')
  })

  it('zeigt Kunden keine internen Notizen und keine Zuständigkeit', async () => {
    const { id } = await createRequest(customer, input)
    await addComment(staff, { id, body: 'intern', internal: true })
    await addComment(customer, { id, body: 'öffentlich', internal: true })
    await assignRequest(staff, { id, version: 1, assigneeId: staff.id })

    const forCustomer = await getRequestDetail(customer, id)
    expect(forCustomer.comments.map((c) => c.body)).toEqual(['öffentlich'])
    expect(forCustomer.assigneeId).toBeNull()
    expect(forCustomer.events.some((e) => e.type === 'assigned')).toBe(false)

    const forStaff = await getRequestDetail(staff, id)
    expect(forStaff.comments.map((c) => c.body)).toEqual(['intern', 'öffentlich'])
    expect(forStaff.assigneeId).toBe(staff.id)
  })

  it('erlaubt Kunden das Bearbeiten nur solange die Anfrage neu ist', async () => {
    const { id } = await createRequest(customer, input)
    await updateRequest(customer, { id, version: 1, ...input, title: 'Visitenkarten 2' })
    await changeStatus(staff, { id, version: 2, to: 'in_review' })
    await expect(updateRequest(customer, { id, version: 3, ...input })).rejects.toThrow('nicht mehr bearbeitet')
  })
})
