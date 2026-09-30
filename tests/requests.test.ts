import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { CONFLICT_MESSAGE } from '~/lib/errors'
import { BILLING } from './fixtures'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url

// Die Module lesen DATABASE_URL beim ersten Zugriff, deshalb dynamisch importieren.
const { getDb, schema } = await import('~/server/db/client.server')
const requestsModule = await import('~/server/requests/requests.server')
const { addComment, assignRequest, changeStatus, createRequest, getRequestDetail, listRequests, setInternalStatus, updateRequest } =
  requestsModule
type Principal = import('~/server/requests/requests.server').Principal

describe.skipIf(!url)('Anfragen (Integration)', () => {
  let staff: Principal
  let customer: Principal
  let otherCustomer: Principal
  let colleague: Principal
  let noAddress: Principal

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
    const [s, c, o, k, n] = await db
      .insert(schema.users)
      .values([
        { email: `staff${stamp}@test`, name: 'Mitarbeiterin', role: 'staff', status: 'active' },
        { email: `a${stamp}@test`, name: 'Kunde A', role: 'customer', status: 'active', organisationId: orgA!.id, billingAddress: BILLING },
        { email: `b${stamp}@test`, name: 'Kunde B', role: 'customer', status: 'active', organisationId: orgB!.id, billingAddress: BILLING },
        { email: `k${stamp}@test`, name: 'Kollege A', role: 'customer', status: 'active', organisationId: orgA!.id, billingAddress: BILLING },
        { email: `n${stamp}@test`, name: 'Ohne Adresse', role: 'customer', status: 'active' },
      ])
      .returning()
    staff = { id: s!.id, role: 'staff', organisationId: null }
    customer = { id: c!.id, role: 'customer', organisationId: orgA!.id }
    otherCustomer = { id: o!.id, role: 'customer', organisationId: orgB!.id }
    colleague = { id: k!.id, role: 'customer', organisationId: orgA!.id }
    noAddress = { id: n!.id, role: 'customer', organisationId: null }
  })

  afterAll(async () => {
    // Verbindung schließen, damit Vitest beendet.
    await (getDb().$client as { end: () => Promise<void> }).end()
  })

  const input = { title: 'Visitenkarten', description: '', quantity: 250, desiredDate: null }

  it('legt eine Anfrage an und merkt sich die Rechnungsadresse', async () => {
    const created = await createRequest(customer, input)
    const detail = await getRequestDetail(customer, created.id)
    expect(detail.status).toBe('submitted')
    expect(detail.organisationId).toBe(customer.organisationId)
    expect(detail.billingAddress).toEqual(BILLING)
    expect(detail.version).toBe(1)
    expect(detail.events.map((e) => e.type)).toEqual(['created'])
  })

  it('verlangt eine Rechnungsadresse und kommt ohne Organisation aus', async () => {
    await expect(createRequest(noAddress, input)).rejects.toThrow('Rechnungsadresse')
    await getDb().update(schema.users).set({ billingAddress: BILLING }).where(eq(schema.users.id, noAddress.id))
    const created = await createRequest(noAddress, input)
    const detail = await getRequestDetail(noAddress, created.id)
    expect(detail.organisationId).toBeNull()
    expect((await listRequests(noAddress, {})).map((r) => r.id)).toEqual([created.id])
  })

  it('zeigt Kunden nur ihre eigenen Anfragen', async () => {
    const created = await createRequest(customer, input)
    await expect(getRequestDetail(colleague, created.id)).rejects.toThrow('Anfrage nicht gefunden')
    await expect(getRequestDetail(otherCustomer, created.id)).rejects.toThrow('Anfrage nicht gefunden')
    await expect(addComment(otherCustomer, { id: created.id, body: 'hallo', internal: false })).rejects.toThrow()
    const list = await listRequests(otherCustomer, {})
    expect(list.find((r) => r.id === created.id)).toBeUndefined()
  })

  it('lehnt veraltete Versionen ab (Optimistic Locking)', async () => {
    const { id } = await createRequest(customer, input)
    const first = await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    expect(first.version).toBe(2)
    await expect(changeStatus(staff, { id, version: 1, to: 'rejected' })).rejects.toThrow(CONFLICT_MESSAGE)
    await expect(updateRequest(staff, { id, version: 1, ...input, title: 'Neu' })).rejects.toThrow(CONFLICT_MESSAGE)
    await expect(assignRequest(staff, { id, version: 1, assigneeId: staff.id })).rejects.toThrow(CONFLICT_MESSAGE)
  })

  it('lässt bei gleichzeitigen Änderungen genau eine gewinnen', async () => {
    const { id } = await createRequest(customer, input)
    const results = await Promise.allSettled([
      changeStatus(staff, { id, version: 1, to: 'confirmed' }),
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
    await expect(changeStatus(customer, { id, version: 1, to: 'confirmed' })).rejects.toThrow('nicht erlaubt')
    await expect(changeStatus(staff, { id, version: 1, to: 'on_hold' })).rejects.toThrow('Rückfrage')
    await changeStatus(staff, { id, version: 1, to: 'on_hold', note: 'Welches Papier?' })
    await changeStatus(customer, { id, version: 2, to: 'submitted', note: '120 g' })
    const res = await changeStatus(staff, { id, version: 3, to: 'confirmed' })
    expect(res.status).toBe('confirmed')
    await expect(changeStatus(customer, { id, version: 4, to: 'cancelled' })).rejects.toThrow('nicht erlaubt')
    const detail = await getRequestDetail(customer, id)
    expect(detail.confirmedByName).toBe('Mitarbeiterin')
    expect(detail.confirmedAt).toBeInstanceOf(Date)
  })

  it('führt einen internen Unterstatus, den Kunden nicht sehen', async () => {
    const { id } = await createRequest(customer, input)
    await expect(setInternalStatus(staff, { id, version: 1, internalStatus: 'in_progress' })).rejects.toThrow('bestätigten')
    await changeStatus(staff, { id, version: 1, to: 'confirmed' })
    await setInternalStatus(staff, { id, version: 2, internalStatus: 'problem' })
    await expect(setInternalStatus(customer, { id, version: 3, internalStatus: null })).rejects.toThrow('Keine Berechtigung')

    expect((await getRequestDetail(staff, id)).internalStatus).toBe('problem')
    const forCustomer = await getRequestDetail(customer, id)
    expect(forCustomer.internalStatus).toBeNull()
    expect(forCustomer.events.some((e) => e.type === 'internal_status_changed')).toBe(false)
    expect((await listRequests(customer, {})).find((r) => r.id === id)?.internalStatus).toBeNull()

    // Mit dem Abschluss verschwindet der Unterstatus.
    await changeStatus(staff, { id, version: 3, to: 'completed' })
    expect((await getRequestDetail(staff, id)).internalStatus).toBeNull()
    expect((await listRequests(staff, { done: true })).some((r) => r.id === id)).toBe(true)
    expect((await listRequests(staff, { open: true })).some((r) => r.id === id)).toBe(false)
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

  it('erlaubt Kunden das Bearbeiten nur bis zur Bestätigung', async () => {
    const { id } = await createRequest(customer, input)
    await updateRequest(customer, { id, version: 1, ...input, title: 'Visitenkarten 2' })
    await changeStatus(staff, { id, version: 2, to: 'confirmed' })
    await expect(updateRequest(customer, { id, version: 3, ...input })).rejects.toThrow('nicht mehr bearbeitet')
  })
})
