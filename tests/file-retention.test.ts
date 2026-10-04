import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { PDFDocument } from 'pdf-lib'
import { BILLING } from './fixtures'
import { orderInput } from './order-fixture'

const url = process.env.TEST_DATABASE_URL
process.env.DATABASE_URL = url
const uploads = await mkdtemp(path.join(tmpdir(), 'drucktool-loeschfrist-'))
process.env.UPLOAD_DIR = uploads

const DAY = 24 * 3600 * 1000

describe.skipIf(!url)('Löschfrist für Druckdateien (Issue #172)', async () => {
  const { getDb, schema } = await import('~/server/db/client.server')
  const { createRequest, getRequestDetail, prepareReorder, addComment } = await import('~/server/requests/requests.server')
  const { createUpload, fileForDownload } = await import('~/server/files/files.server')
  const { storagePath } = await import('~/server/files/storage.server')
  const { purgeRequestFiles, purgeUnsubmittedUploads, requestFileRetentionDays, unsubmittedUploadRetentionDays } =
    await import('~/server/maintenance/cleanup.server')
  type Principal = import('~/server/requests/requests.server').Principal
  let customer: Principal
  let staff: Principal
  const tag = `frist-${Date.now()}`

  const exists = (key: string) =>
    access(storagePath(key)).then(
      () => true,
      () => false,
    )

  async function pdf(pages: number) {
    const doc = await PDFDocument.create()
    for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89])
    return Readable.from(Buffer.from(await doc.save()))
  }

  /** Auftrag mit echter Druckdatei und einem Anhang, danach in `status` seit `daysAgo` Tagen. */
  async function order(status: 'completed' | 'rejected' | 'cancelled' | 'confirmed', daysAgo: number) {
    const input = await orderInput(customer, { title: 'Flyer', spec: { pages: 2 } })
    const main = await createUpload(customer, {
      role: 'main',
      filename: 'flyer.pdf',
      mimeType: 'application/pdf',
      body: await pdf(2),
    })
    const { id } = await createRequest(customer, { ...input, mainFileId: main.id })
    const attachment = await createUpload(customer, {
      role: 'attachment',
      filename: 'logo.txt',
      mimeType: 'text/plain',
      body: Readable.from(Buffer.from('Logo')),
    })
    await addComment(customer, { id, body: 'Logo anbei', internal: false, attachmentIds: [attachment.id] })
    await getDb()
      .update(schema.requests)
      .set({ status, statusChangedAt: new Date(Date.now() - daysAgo * DAY) })
      .where(eq(schema.requests.id, id))
    const files = await getDb().select().from(schema.requestFiles).where(eq(schema.requestFiles.requestId, id))
    return { id, files }
  }

  const reload = (ids: string[]) => getDb().select().from(schema.requestFiles).where(inArray(schema.requestFiles.id, ids))

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

  afterEach(() => {
    delete process.env.REQUEST_FILE_RETENTION_DAYS
    delete process.env.UNSUBMITTED_UPLOAD_RETENTION_DAYS
  })

  afterAll(async () => {
    await (getDb().$client as { end: () => Promise<void> }).end()
    await rm(uploads, { recursive: true, force: true })
  })

  it('liest die Fristen aus der Umgebung', () => {
    expect(requestFileRetentionDays()).toBe(90)
    process.env.REQUEST_FILE_RETENTION_DAYS = '0'
    expect(requestFileRetentionDays()).toBe(0)
    process.env.REQUEST_FILE_RETENTION_DAYS = '30'
    expect(requestFileRetentionDays()).toBe(30)
    expect(unsubmittedUploadRetentionDays()).toBe(1)
    process.env.UNSUBMITTED_UPLOAD_RETENTION_DAYS = '7'
    expect(unsubmittedUploadRetentionDays()).toBe(7)
    // 0 hieße „nie“, dann würde das Kontingent für offene Uploads nie wieder frei.
    process.env.UNSUBMITTED_UPLOAD_RETENTION_DAYS = '0'
    expect(unsubmittedUploadRetentionDays()).toBe(1)
  })

  it('löscht Dateien abgeschlossener Aufträge nach Ablauf der Frist, Auftrag und Verlauf bleiben', async () => {
    const done = await order('completed', 100)
    const rejected = await order('rejected', 100)
    const cancelled = await order('cancelled', 100)
    const recent = await order('completed', 10)
    const open = await order('confirmed', 100)
    expect(done.files).toHaveLength(2)
    for (const f of done.files) expect(await exists(f.storageKey)).toBe(true)

    await purgeRequestFiles(getDb(), 90)

    for (const o of [done, rejected, cancelled]) {
      for (const f of await reload(o.files.map((f) => f.id))) {
        expect(f.purgedAt).not.toBeNull()
        expect(await exists(f.storageKey)).toBe(false)
      }
    }
    for (const o of [recent, open]) {
      for (const f of await reload(o.files.map((f) => f.id))) {
        expect(f.purgedAt).toBeNull()
        expect(await exists(f.storageKey)).toBe(true)
      }
    }

    const detail = await getRequestDetail(customer, done.id)
    expect(detail.status).toBe('completed')
    expect(detail.totalCents).toBeGreaterThan(0)
    expect(detail.files[0]!.purgedAt).not.toBeNull()
    expect(detail.comments[0]!.attachments[0]!.purgedAt).not.toBeNull()
    const purgedEvents = detail.events.filter((e) => e.type === 'files_purged')
    expect(purgedEvents).toHaveLength(1)
    expect(purgedEvents[0]!.data).toMatchObject({ files: 2, retentionDays: 90 })

    // Der Download-Endpunkt bekommt die Zeile weiter und meldet „gelöscht“ statt eines Fehlers.
    expect((await fileForDownload(customer, done.files[0]!.id))?.purgedAt).not.toBeNull()

    // Zweiter Lauf: nichts mehr zu tun, kein zweiter Verlaufseintrag.
    await purgeRequestFiles(getDb(), 90)
    const again = await getRequestDetail(staff, done.id)
    expect(again.events.filter((e) => e.type === 'files_purged')).toHaveLength(1)
  })

  it('verlangt bei einer Nachbestellung ohne Datei einen neuen Upload', async () => {
    const old = await order('completed', 200)
    await purgeRequestFiles(getDb(), 90)
    const template = await prepareReorder(customer, old.id)
    expect(template.mainFile).toBeNull()
    expect(template.filesPurged).toBe(true)
    expect(template.spec.pages).toBe(2)
  })

  it('lässt Kopien einer Nachbestellung und Vorlagen von Skripten stehen', async () => {
    const source = await order('confirmed', 0)
    const copy = await prepareReorder(customer, source.id)
    const input = await orderInput(customer, { title: 'Flyer nochmal', spec: { pages: 2 } })
    const { id: reorderId } = await createRequest(customer, { ...input, mainFileId: copy.mainFile!.id, reorderOfId: source.id })
    // Erst die Vorlage läuft ab: die Kopie hat ihre eigene Datei und bleibt.
    await getDb()
      .update(schema.requests)
      .set({ status: 'completed', statusChangedAt: new Date(Date.now() - 100 * DAY) })
      .where(eq(schema.requests.id, source.id))
    await purgeRequestFiles(getDb(), 90)
    const [reorderFile] = await getDb()
      .select()
      .from(schema.requestFiles)
      .where(and(eq(schema.requestFiles.requestId, reorderId), eq(schema.requestFiles.role, 'main')))
    expect(reorderFile!.purgedAt).toBeNull()
    expect(await exists(reorderFile!.storageKey)).toBe(true)

    // Vorlage eines aktiven Skripts: bleibt, archiviert: wird gelöscht.
    const scriptOrder = await order('completed', 100)
    const [org] = await getDb()
      .insert(schema.organisations)
      .values({ name: `${tag} SVK`, status: 'active' })
      .returning()
    const [script] = await getDb()
      .insert(schema.scripts)
      .values({ organisationId: org!.id, title: 'Mechanik', semester: 'WS 2026/27', templateRequestId: scriptOrder.id })
      .returning()
    await purgeRequestFiles(getDb(), 90)
    for (const f of await reload(scriptOrder.files.map((f) => f.id))) expect(f.purgedAt).toBeNull()
    await getDb().update(schema.scripts).set({ archived: true }).where(eq(schema.scripts.id, script!.id))
    await purgeRequestFiles(getDb(), 90)
    for (const f of await reload(scriptOrder.files.map((f) => f.id))) expect(f.purgedAt).not.toBeNull()
  })

  it('löscht nichts bei Frist 0', async () => {
    await order('completed', 1000)
    expect(await purgeRequestFiles(getDb(), 0)).toBe(0)
  })

  it('löscht nie abgeschickte Uploads nach Ablauf der Frist', async () => {
    const fresh = await createUpload(customer, {
      role: 'main',
      filename: 'neu.pdf',
      mimeType: 'application/pdf',
      body: await pdf(1),
    })
    const stale = await createUpload(customer, {
      role: 'main',
      filename: 'alt.pdf',
      mimeType: 'application/pdf',
      body: await pdf(1),
    })
    await getDb()
      .update(schema.requestFiles)
      .set({ createdAt: new Date(Date.now() - 8 * DAY) })
      .where(eq(schema.requestFiles.id, stale.id))
    const [staleRow] = await reload([stale.id])
    expect(await purgeUnsubmittedUploads(getDb(), 7)).toBeGreaterThanOrEqual(1)
    const left = await reload([fresh.id, stale.id])
    expect(left.map((f) => f.id)).toEqual([fresh.id])
    expect(await exists(staleRow!.storageKey)).toBe(false)
  })
})
