import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { PDFDocument } from 'pdf-lib'
import { BILLING } from './fixtures'
import { orderInput } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-reorder-'))
process.env.UPLOAD_DIR = uploads

describe.skipIf(!url)('Nachbestellung (Issue #10)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { createRequest, getRequestDetail, prepareReorder, addComment, assignRequest } =
    await import('~/server/requests/requests.server')
  const { createUpload, PendingUploadsFullError } = await import('~/server/files/files.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let other: Principal
  let staff: Principal

  async function pdf(pages: number) {
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89])
    return Readable.from(Buffer.from(await doc.save()))
  }

  async function orderWithFile(user: Principal) {
    const input = await orderInput(user, { title: 'Visitenkarten', notes: 'wie immer', spec: { copies: 5 } })
    const file = await createUpload(user, {
      role: 'main',
      filename: 'karten.pdf',
      mimeType: 'application/pdf',
      body: await pdf(4),
    })
    return createRequest(user, { ...input, mainFileId: file.id })
  }

  beforeAll(async () => {
    const stamp = Date.now()
    const rows = await getDb()
      .insert(schema.users)
      .values([
        { email: `r-kunde-${stamp}@test`, lastName: 'Kundin', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `r-fremd-${stamp}@test`, lastName: 'Fremd', role: 'customer', status: 'active', billingAddress: BILLING },
        { email: `r-staff-${stamp}@test`, lastName: 'Staff', role: 'staff', status: 'active' },
      ])
      .returning()
    customer = { id: rows[0]!.id, role: 'customer' }
    other = { id: rows[1]!.id, role: 'customer' }
    staff = { id: rows[2]!.id, role: 'staff' }
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  it('übernimmt Optionen und kopiert die Dateien als neue Uploads', async () => {
    const original = await orderWithFile(customer)
    await assignRequest(staff, { id: original.id, version: 1, assigneeId: staff.id })
    await addComment(staff, { id: original.id, body: 'Danke!', internal: false })

    const template = await prepareReorder(customer, original.id)
    expect(template.source.number).toBe(original.number)
    expect(template.title).toBe('Visitenkarten')
    expect(template.notes).toBe('wie immer')
    expect(template.spec.copies).toBe(5)
    expect(template.mainFile!.filename).toBe('karten.pdf')
    expect(template.mainFile!.pageCount).toBe(4)

    const [oldFile] = await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.requestId, original.id))
    const [copy] = await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.id, template.mainFile!.id))
    expect(copy!.id).not.toBe(oldFile!.id)
    expect(copy!.storageKey).not.toBe(oldFile!.storageKey)
    expect(copy!.sha256).toBe(oldFile!.sha256)
    expect(copy!.ownerId).toBe(customer.id)
    expect(copy!.requestId).toBeNull()

    const input = await orderInput(customer, { spec: { ...template.spec, copies: 50 } })
    const again = await createRequest(customer, { ...input, mainFileId: template.mainFile!.id, reorderOfId: original.id })
    const detail = await getRequestDetail(customer, again.id)
    expect(detail.reorderOf).toMatchObject({ id: original.id, number: original.number })
    expect(detail.assigneeId).toBeNull()
    expect(detail.comments).toEqual([])
    expect(detail.events[0]!.data).toEqual({ reorderOfNumber: original.number })
    expect(detail.files.map((f) => f.filename)).toEqual(['karten.pdf'])
  })

  it('erlaubt Kunden nur eigene Aufträge als Vorlage', async () => {
    const original = await orderWithFile(customer)
    await expect(prepareReorder(other, original.id)).rejects.toThrow('Auftrag nicht gefunden')
    const input = await orderInput(other)
    await expect(createRequest(other, { ...input, reorderOfId: original.id })).rejects.toThrow('Auftrag nicht gefunden')
    // Mitarbeiter dürfen jeden Auftrag nachbestellen.
    expect((await prepareReorder(staff, original.id)).mainFile).not.toBeNull()
  })

  it('kopiert bei erneutem Öffnen der Vorlage nicht noch einmal (Issue #140)', async () => {
    const original = await orderWithFile(customer)
    const first = await prepareReorder(customer, original.id)
    const second = await prepareReorder(customer, original.id)
    expect(second.mainFile!.id).toBe(first.mainFile!.id)
    const copies = await getDb()
      .select()
      .from(schema.requestFiles)
      .where(
        eq(
          schema.requestFiles.sha256,
          (await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.id, first.mainFile!.id)))[0]!.sha256,
        ),
      )
    expect(copies.filter((f) => f.requestId === null && f.ownerId === customer.id)).toHaveLength(1)
  })

  it('begrenzt nicht abgeschickte Uploads pro Benutzer (Issue #140)', async () => {
    const stamp = Date.now()
    const [row] = await getDb()
      .insert(schema.users)
      .values({ email: `r-voll-${stamp}@test`, lastName: 'Voll', role: 'customer', status: 'active', billingAddress: BILLING })
      .returning()
    const user: Principal = { id: row!.id, role: 'customer' }
    const original = await orderWithFile(user)
    const size = (await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.requestId, original.id)))[0]!
      .sizeBytes
    // Die Vorlage aus orderInput bleibt sonst als offener Upload liegen.
    await getDb()
      .delete(schema.requestFiles)
      .where(and(eq(schema.requestFiles.ownerId, user.id), isNull(schema.requestFiles.requestId)))
    // Platz für genau eine weitere Datei dieser Größe.
    process.env.UPLOAD_PENDING_MAX_MB = String((size * 1.5) / 1024 / 1024)
    try {
      await prepareReorder(user, original.id)
      await expect(
        createUpload(user, { role: 'main', filename: 'noch.pdf', mimeType: 'application/pdf', body: await pdf(2) }),
      ).rejects.toBeInstanceOf(PendingUploadsFullError)
      // Die schon vorhandene Kopie wird weiter angeboten.
      expect((await prepareReorder(user, original.id)).mainFile).not.toBeNull()
    } finally {
      delete process.env.UPLOAD_PENDING_MAX_MB
    }
  })
})
